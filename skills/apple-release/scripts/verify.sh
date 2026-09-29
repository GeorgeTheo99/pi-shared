#!/bin/bash
# Verify a distributable the way a downloading Mac will: signature, Developer ID
# authority, hardened runtime (apps), Gatekeeper assessment and stapled ticket.
# Usage: verify.sh <artifact.app|.dmg|.pkg>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: verify.sh <artifact>"
artifact="${1%/}"
[ -e "$artifact" ] || die "artifact not found: $artifact"
pass() { printf '  ok    %s\n' "$*"; }

case "$artifact" in
  *.app)
    codesign --verify --deep --strict "$artifact" 2>/dev/null || die "codesign verification failed"
    pass "code signature valid (deep, strict)"
    details="$(codesign -dvv "$artifact" 2>&1)"
    grep -q '^Authority=Developer ID Application:' <<<"$details" || die "not signed with a Developer ID Application identity"
    pass "$(grep -m1 '^Authority=Developer ID Application:' <<<"$details" | cut -d= -f2-)"
    grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$details" || die "hardened runtime is not enabled"
    pass "hardened runtime enabled"
    spctl --assess --type execute "$artifact" 2>/dev/null || die "Gatekeeper rejected the app"
    pass "Gatekeeper accepts it (execute)" ;;
  *.dmg)
    codesign --verify --strict "$artifact" 2>/dev/null || die "disk image signature invalid or missing"
    pass "disk image signature valid"
    spctl --assess --type open --context context:primary-signature "$artifact" 2>/dev/null || \
      die "Gatekeeper rejected the disk image"
    pass "Gatekeeper accepts it (open)" ;;
  *.pkg)
    signature="$(pkgutil --check-signature "$artifact" 2>&1)" || die "package signature invalid or missing"
    grep -q 'Developer ID Installer:' <<<"$signature" || die "not signed with a Developer ID Installer identity"
    pass "$(grep -m1 -o 'Developer ID Installer: .*' <<<"$signature")"
    spctl --assess --type install "$artifact" 2>/dev/null || die "Gatekeeper rejected the package"
    pass "Gatekeeper accepts it (install)" ;;
  *) die "unsupported artifact type: $artifact" ;;
esac
xcrun stapler validate "$artifact" >/dev/null 2>&1 || die "no valid stapled notarization ticket"
pass "notarization ticket stapled"
