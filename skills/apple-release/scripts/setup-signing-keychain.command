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
TMP="" KC="" imported=0
pause() { if [ -t 0 ]; then printf 'Press Return to close.'; read -r _; fi; }
fail() { printf 'ERROR: %s\n' "$*" >&2; pause; exit 1; }

# `security export` cannot select identities, so everything else is deleted after import.
drop_foreign_identities() {
  local listing
  listing="$(security find-identity -p basic "$KC")"
  /usr/bin/python3 -c '
import re, sys
wanted = re.compile(sys.argv[1])
for line in sys.stdin:
    match = re.match(r"\s*\d+\) ([0-9A-F]{40}) \"(.*)\"", line)
    if match and not wanted.match(match.group(2)):
        print(match.group(1))
' "$wanted" <<<"$listing" | sort -u | while read -r hash; do
    security delete-identity -Z "$hash" "$KC" >/dev/null 2>&1 || true
  done
}
cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  if [ -n "$KC" ] && [ -e "$KC" ]; then
    # Never leave other teams' keys behind in a keychain a password file unlocks.
    if [ "$imported" -eq 1 ]; then drop_foreign_identities || true; fi
    security lock-keychain "$KC" 2>/dev/null || true
  fi
}
trap cleanup EXIT

load_config
if [ -z "${SIGNING_KEYCHAIN:-}" ] || [ -z "${SIGNING_KEYCHAIN_PASSWORD_FILE:-}" ]; then
  "$here/configure.sh" --keychain "$HOME/Library/Keychains/apple-release-signing.keychain-db" \
    --password-file "$(dirname "$APPLE_RELEASE_CONFIG")/keychain-password"
  load_config
fi
wanted="^Developer ID (Application|Installer): .* \\($APPLE_TEAM_ID\\)\$"
printf '== apple-release signing keychain setup %s ==\n' "$(date)"

if [ -e "$SIGNING_KEYCHAIN" ]; then
  require_private_file "$SIGNING_KEYCHAIN_PASSWORD_FILE" "signing keychain password file"
  KC="$SIGNING_KEYCHAIN"
  unlock_signing_keychain || fail "could not unlock $KC with $SIGNING_KEYCHAIN_PASSWORD_FILE"
  echo "extending existing keychain $KC"
else
  [ ! -e "$SIGNING_KEYCHAIN_PASSWORD_FILE" ] || fail "password file exists but keychain does not: $SIGNING_KEYCHAIN_PASSWORD_FILE"
  mkdir -p "$(dirname "$SIGNING_KEYCHAIN_PASSWORD_FILE")"
  /usr/bin/python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$SIGNING_KEYCHAIN_PASSWORD_FILE"
  chmod 600 "$SIGNING_KEYCHAIN_PASSWORD_FILE"
  security create-keychain -p "$(cat "$SIGNING_KEYCHAIN_PASSWORD_FILE")" "$SIGNING_KEYCHAIN"
  KC="$SIGNING_KEYCHAIN"
  unlock_signing_keychain || fail "could not unlock the new keychain"
  echo "created $KC (not added to the search list)"
fi
# Long builds unlock before compiling; release scripts still relock as soon as they finish.
security set-keychain-settings -lut 3600 "$KC"

source_identities="$(security find-identity ${VALID[@]+"${VALID[@]}"} -p basic "$SOURCE")"
grep -Eq "\"Developer ID (Application|Installer): .* \\($APPLE_TEAM_ID\\)\"" <<<"$source_identities" || \
  fail "no valid Developer ID identity for team $APPLE_TEAM_ID in $SOURCE (create one in Xcode > Settings > Accounts > Manage Certificates)"

TMP="$(mktemp -d)"
P12PW="$(/usr/bin/python3 -c 'import secrets; print(secrets.token_hex(24))')"
echo "Exporting identities from $(basename "$SOURCE"); approve each macOS prompt."
security export -k "$SOURCE" -t identities -f pkcs12 -P "$P12PW" -o "$TMP/identities.p12" >/dev/null
imported=1
# Already-present items are reported as duplicates; the result is verified below.
security import "$TMP/identities.p12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign -T /usr/bin/productsign >/dev/null 2>&1 || true
rm -P "$TMP/identities.p12"
drop_foreign_identities
security set-key-partition-list -S apple-tool:,apple: -s -k "$(cat "$SIGNING_KEYCHAIN_PASSWORD_FILE")" "$KC" >/dev/null

# Every identity left, valid or not, must be this team's Developer ID.
all="$(security find-identity -p basic "$KC" | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "(.*)"( \([A-Z_]+\))?$/\1 \2/p' | sort -u)"
while IFS= read -r row; do
  [ -z "$row" ] || grep -Eq "$wanted" <<<"${row#* }" || fail "unexpected identity in signing keychain: ${row#* }"
done <<<"$all"
usable="$(security find-identity ${VALID[@]+"${VALID[@]}"} -p basic "$KC" |
  sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "(.*)"( \([A-Z_]+\))?$/\1 \2/p' | sort -u | cut -d' ' -f2-)"
[ -n "$usable" ] || fail "no Developer ID identity ended up in $KC"
# A renewed certificate keeps its name; signing by that name would be ambiguous.
dupes="$(sort <<<"$usable" | uniq -d)"
[ -z "$dupes" ] || fail "several valid identities are named \"$dupes\"; delete the older certificate from $SOURCE and from $KC, then re-run"
app="$(grep '^Developer ID Application:' <<<"$usable" || true)"
installer="$(grep '^Developer ID Installer:' <<<"$usable" || true)"
args=()
if [ -n "$app" ] && [ "$(wc -l <<<"$app")" -eq 1 ]; then args+=(--app-identity "$app"); fi
if [ -n "$installer" ] && [ "$(wc -l <<<"$installer")" -eq 1 ]; then args+=(--installer-identity "$installer"); fi
if [ "${#args[@]}" -gt 0 ]; then "$here/configure.sh" "${args[@]}"; fi
imported=0
security lock-keychain "$KC"
printf 'Signing keychain holds:\n%s\n' "$usable"
printf '== Done. Keychain locked. You can close this window. ==\n'
pause
