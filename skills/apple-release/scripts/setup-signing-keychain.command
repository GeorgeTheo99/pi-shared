#!/bin/bash
# One-time (and re-runnable) setup of the dedicated apple-release signing keychain.
# Run in a logged-in Terminal (double-click or `open -a Terminal` this file): it
# copies this team's Developer ID Application/Installer identities out of the
# login keychain, which macOS asks you to approve. Background Pi sessions cannot
# use the login keychain; the dedicated keychain is unlocked from a private
# password file instead. Re-run after adding a new Developer ID certificate.
set -euo pipefail
umask 077
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"

SOURCE="${SETUP_SOURCE_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
# Rehearsal only: self-signed test identities are never "valid".
VALID=(-v); [ "${SETUP_VALID_ONLY:-1}" = 1 ] || VALID=()
TMP=""
pause() { [ -t 0 ] && { printf 'Press Return to close.'; read -r _; }; return 0; }
fail() { printf 'ERROR: %s\n' "$*" >&2; pause; exit 1; }
KC=""
cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  if [ -n "$KC" ] && [ -e "$KC" ]; then security lock-keychain "$KC" 2>/dev/null || true; fi
}
trap cleanup EXIT

load_config
if [ -z "${SIGNING_KEYCHAIN:-}" ] || [ -z "${SIGNING_KEYCHAIN_PASSWORD_FILE:-}" ]; then
  "$here/configure.sh" --keychain "$HOME/Library/Keychains/apple-release-signing.keychain-db" \
    --password-file "$(dirname "$APPLE_RELEASE_CONFIG")/keychain-password"
  load_config
fi
KC="$SIGNING_KEYCHAIN" PWFILE="$SIGNING_KEYCHAIN_PASSWORD_FILE"
wanted="^Developer ID (Application|Installer): .* \\($APPLE_TEAM_ID\\)\$"
printf '== apple-release signing keychain setup %s ==\n' "$(date)"

if [ -e "$KC" ]; then
  require_private_file "$PWFILE" "signing keychain password file"
  unlock_signing_keychain || fail "could not unlock $KC with $PWFILE"
  echo "extending existing keychain $KC"
else
  [ ! -e "$PWFILE" ] || fail "password file exists but keychain does not: $PWFILE"
  mkdir -p "$(dirname "$PWFILE")"
  /usr/bin/python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$PWFILE"
  chmod 600 "$PWFILE"
  security create-keychain -p "$(cat "$PWFILE")" "$KC"
  security set-keychain-settings -lut 900 "$KC"
  security unlock-keychain -p "$(cat "$PWFILE")" "$KC"
  echo "created $KC (locks after 15 minutes idle and on sleep; not added to the search list)"
fi

security find-identity ${VALID[@]+"${VALID[@]}"} -p basic "$SOURCE" | grep -Eq "\"Developer ID (Application|Installer): .* \\($APPLE_TEAM_ID\\)\"" || \
  fail "no valid Developer ID identity for team $APPLE_TEAM_ID in $SOURCE (create one in Xcode > Settings > Accounts > Manage Certificates)"

TMP="$(mktemp -d)"
P12PW="$(/usr/bin/python3 -c 'import secrets; print(secrets.token_hex(24))')"
echo "Exporting identities from $(basename "$SOURCE"); approve each macOS prompt."
security export -k "$SOURCE" -t identities -f pkcs12 -P "$P12PW" -o "$TMP/identities.p12"
# Already-present items are reported as duplicates; the result is verified below.
security import "$TMP/identities.p12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign -T /usr/bin/productsign >/dev/null 2>&1 || true
rm -P "$TMP/identities.p12"

# `security export` cannot select identities, so drop everything but this team's Developer ID ones.
security find-identity -p basic "$KC" | /usr/bin/python3 -c '
import re, sys
wanted = re.compile(sys.argv[1])
for line in sys.stdin:
    match = re.match(r"\s*\d+\) ([0-9A-F]{40}) \"(.*)\"", line)
    if match and not wanted.match(match.group(2)):
        print(match.group(1))
' "$wanted" | sort -u | while read -r hash; do security delete-identity -Z "$hash" "$KC" >/dev/null 2>&1 || true; done
security set-key-partition-list -S apple-tool:,apple: -s -k "$(cat "$PWFILE")" "$KC" >/dev/null

kept="$(security find-identity ${VALID[@]+"${VALID[@]}"} -p basic "$KC" | sed -nE 's/^ *[0-9]+\) [0-9A-F]{40} "(.*)"( \([A-Z_]+\))?$/\1/p' | sort -u)"
[ -n "$kept" ] || fail "no Developer ID identity ended up in $KC"
while IFS= read -r identity; do
  grep -Eq "$wanted" <<<"$identity" || fail "unexpected identity in signing keychain: $identity"
done <<<"$kept"
app="$(grep '^Developer ID Application:' <<<"$kept" || true)"
installer="$(grep '^Developer ID Installer:' <<<"$kept" || true)"
args=()
[ -n "$app" ] && [ "$(wc -l <<<"$app")" -eq 1 ] && args+=(--app-identity "$app")
[ -n "$installer" ] && [ "$(wc -l <<<"$installer")" -eq 1 ] && args+=(--installer-identity "$installer")
[ "${#args[@]}" -eq 0 ] || "$here/configure.sh" "${args[@]}"
security lock-keychain "$KC"
printf 'Signing keychain holds:\n%s\n' "$kept"
printf '== Done. Keychain locked. You can close this window. ==\n'
pause
