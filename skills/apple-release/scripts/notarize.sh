#!/bin/bash
# Notarize a signed .app, .dmg, .pkg or .zip with the App Store Connect API key,
# then staple the ticket (apps, disk images and installer packages).
# Usage: notarize.sh <artifact>
# On rejection, Apple's log is saved next to the artifact as <name>.notary-log.json.
set -euo pipefail
umask 077
source "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: notarize.sh <artifact>"
artifact="${1%/}"
[ -e "$artifact" ] || die "artifact not found: $artifact"
load_config
require_asc_key
auth=(--key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
submission="$artifact"
case "$artifact" in
  *.app)
    submission="$work/$(basename "$artifact" .app).zip"
    ditto -c -k --keepParent "$artifact" "$submission" ;;
  *.dmg|*.pkg|*.zip) ;;
  *) die "unsupported artifact type (expected .app, .dmg, .pkg or .zip): $artifact" ;;
esac

log "Submitting $(basename "$artifact") for notarization (waits for Apple's verdict)"
# A rejected submission may exit nonzero; parse the verdict either way.
xcrun notarytool submit "$submission" "${auth[@]}" --wait --output-format json > "$work/result.json" || true
read -r id status < <(/usr/bin/python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    data = {}
print(data.get("id") or "-", data.get("status") or "unknown")' "$work/result.json")
[ "$id" != "-" ] || id=""
log "Notarization $status (submission $id)"
if [ "$status" != "Accepted" ]; then
  if [ -n "$id" ]; then
    xcrun notarytool log "$id" "${auth[@]}" "$artifact.notary-log.json" >/dev/null || true
    log "Apple's log: $artifact.notary-log.json"
  fi
  die "notarization was not accepted"
fi

case "$artifact" in
  *.app|*.dmg|*.pkg)
    xcrun stapler staple "$artifact" >/dev/null
    xcrun stapler validate "$artifact" >/dev/null
    log "Stapled and validated the ticket on $(basename "$artifact")" ;;
  *) log "Zip archives cannot be stapled; Gatekeeper checks the ticket online" ;;
esac
