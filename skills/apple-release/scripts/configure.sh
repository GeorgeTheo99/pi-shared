#!/bin/bash
# Write (or update) the private machine config for apple-release without
# printing secret values. Usage:
#   configure.sh --team TEAMID [--asc-env FILE] [--keychain PATH --password-file PATH]
#                [--app-identity NAME] [--installer-identity NAME]
# --asc-env reads APPSTORE_API_KEY_ID / APPSTORE_ISSUER_ID /
# APPSTORE_API_PRIVATE_KEY_PATH from an existing ios-testflight style env file;
# the .p8 is referenced in place, never copied.
set -euo pipefail
umask 077
source "$(dirname "$0")/lib.sh"

updates=()
add() { updates+=("$1=$2"); }
while [ $# -gt 0 ]; do
  case "$1" in
    --team) add APPLE_TEAM_ID "$2"; shift 2 ;;
    --keychain) add SIGNING_KEYCHAIN "$2"; shift 2 ;;
    --password-file) add SIGNING_KEYCHAIN_PASSWORD_FILE "$2"; shift 2 ;;
    --app-identity) add APP_IDENTITY "$2"; shift 2 ;;
    --installer-identity) add INSTALLER_IDENTITY "$2"; shift 2 ;;
    --asc-env)
      require_private_file "$2" "App Store Connect env file"
      while IFS='=' read -r key value; do
        # The file is written for `source`; accept its common quoting without evaluating it.
        key="${key#export }"
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        # shellcheck disable=SC2016  # matching the literal text, not expanding it
        case "$value" in '$HOME/'*|'${HOME}/'*) value="$HOME/${value#*/}" ;; esac
        case "$key" in
          APPSTORE_API_KEY_ID) add ASC_KEY_ID "$value" ;;
          APPSTORE_ISSUER_ID) add ASC_ISSUER_ID "$value" ;;
          APPSTORE_API_PRIVATE_KEY_PATH) add ASC_KEY_PATH "$value" ;;
        esac
      done < <(grep -E '^(export )?APPSTORE_(API_KEY_ID|ISSUER_ID|API_PRIVATE_KEY_PATH)=' "$2")
      shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "${#updates[@]}" -gt 0 ] || die "nothing to configure"

config_dir="$(dirname "$APPLE_RELEASE_CONFIG")"
[ -d "$config_dir" ] || mkdir -p "$config_dir"  # private via umask 077
[ ! -e "$APPLE_RELEASE_CONFIG" ] || require_private_file "$APPLE_RELEASE_CONFIG" "apple-release config"
/usr/bin/python3 - "$APPLE_RELEASE_CONFIG" "${updates[@]}" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text().splitlines() if path.exists() else [
    "# apple-release machine config (private; values are never printed)."]
for update in sys.argv[2:]:
    key, _, value = update.partition("=")
    if "\n" in value or not value:
        sys.exit(f"apple-release: empty or multi-line value for {key}")
    entry = f'{key}="{value}"'
    index = next((i for i, line in enumerate(lines) if line.startswith(key + "=")), None)
    if index is None:
        lines.append(entry)
    else:
        lines[index] = entry
temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.write("\n".join(lines) + "\n")
os.replace(temporary, path)
print("apple-release: updated " + ", ".join(sorted({u.split("=", 1)[0] for u in sys.argv[2:]})) + f" in {path}")
PY
load_config
