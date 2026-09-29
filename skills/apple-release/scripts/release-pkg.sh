#!/bin/bash
# Sign an installer package with Developer ID Installer, notarize, staple, verify.
# Usage: release-pkg.sh <unsigned.pkg> [--out DIR]   (default DIR: dist/release)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"

[ $# -ge 1 ] || die "usage: release-pkg.sh <unsigned.pkg> [--out DIR]"
input="$1"; shift
out="dist/release"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -f "$input" ] || die "package not found: $input"
load_config
require_signing_keychain
[ -n "${INSTALLER_IDENTITY:-}" ] || die "INSTALLER_IDENTITY is not configured"

mkdir -p "$out"
signed="$out/$(basename "$input")"
[ "$(cd "$(dirname "$input")" && pwd)/$(basename "$input")" != "$(cd "$out" && pwd)/$(basename "$input")" ] || \
  die "--out must differ from the input package's directory"
rm -f "$signed"

log "Signing $(basename "$input") with $INSTALLER_IDENTITY"
# shellcheck disable=SC2016  # expanded by the inner shell
"$here/with-signing-keychain.sh" -- /bin/bash -c '
  source "$1/lib.sh"; load_config
  require_identity "$INSTALLER_IDENTITY" basic
  productsign --timestamp --keychain "$SIGNING_KEYCHAIN" --sign "$INSTALLER_IDENTITY" "$2" "$3" >/dev/null
' _ "$here" "$input" "$signed"
"$here/notarize.sh" "$signed"
"$here/verify.sh" "$signed"
log "Ready to share: $signed"
