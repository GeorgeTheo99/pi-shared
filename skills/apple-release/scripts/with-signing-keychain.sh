#!/bin/bash
# Run one command with the dedicated signing keychain unlocked, then lock it.
# Usage: with-signing-keychain.sh [--search-list] -- command [args...]
# --search-list temporarily prepends the keychain to the user search list (xcodebuild
# only finds identities there) and restores the exact previous list on exit.
set -euo pipefail
umask 077
source "$(dirname "$0")/lib.sh"

search_list=0
while [ $# -gt 0 ]; do
  case "$1" in
    --search-list) search_list=1; shift ;;
    --) shift; break ;;
    *) die "usage: with-signing-keychain.sh [--search-list] -- command [args...]" ;;
  esac
done
[ $# -gt 0 ] || die "no command given"
load_config
require_signing_keychain

previous=()
restore() {
  if [ "$search_list" -eq 1 ] && [ "${#previous[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${previous[@]}"
  fi
  security lock-keychain "$SIGNING_KEYCHAIN"
}
trap restore EXIT
unlock_signing_keychain
if [ "$search_list" -eq 1 ]; then
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"; entry="${entry#\"}"; entry="${entry%\"}"
    [ -n "$entry" ] && previous+=("$entry")
  done < <(security list-keychains -d user)
  [ "${#previous[@]}" -gt 0 ] || die "could not read the keychain search list"
  security list-keychains -d user -s "$SIGNING_KEYCHAIN" "${previous[@]}"
fi
"$@"
