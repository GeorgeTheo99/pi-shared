# Shared helpers for apple-release scripts. Source; do not execute.
# Secrets are referenced by path only and never printed.

APPLE_RELEASE_CONFIG="${APPLE_RELEASE_CONFIG:-$HOME/.config/apple-release/config.env}"

die() { printf 'apple-release: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*" >&2; }

# A private regular file owned by the current user (no symlink, no group/other access).
require_private_file() {
  local path="$1" label="$2" mode
  [ -f "$path" ] && [ ! -L "$path" ] || die "$label is missing or not a regular file: $path"
  [ -O "$path" ] || die "$label is not owned by $(id -un): $path"
  mode="$(stat -f '%Lp' "$path")"
  [ $((8#$mode & 8#077)) -eq 0 ] || die "$label must not be group/world accessible (mode $mode): $path"
}

# Load the machine config. Only KEY=value lines for known keys are accepted; the
# file is never sourced, so it cannot run commands.
load_config() {
  require_private_file "$APPLE_RELEASE_CONFIG" "apple-release config"
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    case "$key" in
      APPLE_TEAM_ID|ASC_KEY_PATH|ASC_KEY_ID|ASC_ISSUER_ID|SIGNING_KEYCHAIN|SIGNING_KEYCHAIN_PASSWORD_FILE|APP_IDENTITY|INSTALLER_IDENTITY)
        value="${value/#\~/$HOME}"
        printf -v "$key" '%s' "$value"
        export "${key?}" ;;
      *) die "unknown key in $APPLE_RELEASE_CONFIG: $key" ;;
    esac
  done < "$APPLE_RELEASE_CONFIG"
  [[ "${APPLE_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]] || die "APPLE_TEAM_ID must be a 10-character team ID"
}

require_asc_key() {
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ] || \
    die "ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID must be set in $APPLE_RELEASE_CONFIG"
  require_private_file "$ASC_KEY_PATH" "App Store Connect API key"
}

require_signing_keychain() {
  [ -n "${SIGNING_KEYCHAIN:-}" ] && [ -n "${SIGNING_KEYCHAIN_PASSWORD_FILE:-}" ] || \
    die "SIGNING_KEYCHAIN and SIGNING_KEYCHAIN_PASSWORD_FILE must be set; run setup-signing-keychain.command once"
  [ -f "$SIGNING_KEYCHAIN" ] || die "signing keychain not found: $SIGNING_KEYCHAIN"
  require_private_file "$SIGNING_KEYCHAIN_PASSWORD_FILE" "signing keychain password file"
}

# Unlock through the Security API: no password in argv and no TTY prompt, so it
# also works from background (non-GUI) sessions where the login keychain cannot.
unlock_signing_keychain() {
  /usr/bin/python3 - "$SIGNING_KEYCHAIN" "$SIGNING_KEYCHAIN_PASSWORD_FILE" <<'PY'
import ctypes
import sys

sec = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
keychain = ctypes.c_void_p()
with open(sys.argv[2], "rb") as handle:
    password = handle.read().strip()
if sec.SecKeychainOpen(sys.argv[1].encode(), ctypes.byref(keychain)) or \
        sec.SecKeychainUnlock(keychain, len(password), password, True):
    sys.exit("apple-release: could not unlock the signing keychain")
PY
}

# Verify the keychain holds exactly this valid identity (by full name).
require_identity() {
  local identity="$1" policy="$2"
  [ -n "$identity" ] || die "no signing identity configured for this step"
  security find-identity -v -p "$policy" "$SIGNING_KEYCHAIN" | grep -Fq "\"$identity\"" || \
    die "signing keychain has no valid identity \"$identity\""
}
