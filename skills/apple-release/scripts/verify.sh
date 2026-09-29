#!/bin/bash
# Verify a distributable the way a downloading Mac will: signature, Developer ID
# authority, hardened runtime (apps), Gatekeeper's notarized verdict and the
# stapled ticket.
# Usage: verify.sh <artifact.app|.dmg|.pkg>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: verify.sh <artifact>"
artifact="${1%/}"
[ -e "$artifact" ] || die "artifact not found: $artifact"
pass() { printf '  ok    %s\n' "$*"; }
# An exit status alone can reflect a local Gatekeeper override; require Apple's verdict.
gatekeeper() {
  local verdict
  verdict="$(spctl --assess -vv "$@" "$artifact" 2>&1)" || die "Gatekeeper rejected $(basename "$artifact")"
  grep -qx 'source=Notarized Developer ID' <<<"$verdict" || die "Gatekeeper did not report a notarized Developer ID source"
  pass "Gatekeeper: notarized Developer ID ($*)"
}

case "$artifact" in
  *.app)
    codesign --verify --deep --strict "$artifact" 2>/dev/null || die "codesign verification failed"
    pass "code signature valid (deep, strict)"
    details="$(codesign -dvv "$artifact" 2>&1)"
    authority="$(grep -m1 '^Authority=Developer ID Application:' <<<"$details" || true)"
    [ -n "$authority" ] || die "not signed with a Developer ID Application identity"
    pass "${authority#Authority=}"
    grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$details" || die "hardened runtime is not enabled"
    pass "hardened runtime enabled"
    gatekeeper --type execute ;;
  *.dmg)
    codesign --verify --strict "$artifact" 2>/dev/null || die "disk image signature invalid or missing"
    pass "disk image signature valid"
    gatekeeper --type open --context context:primary-signature ;;
  *.pkg)
    signature="$(pkgutil --check-signature "$artifact" 2>&1)" || die "package signature invalid or missing"
    authority="$(grep -m1 -o 'Developer ID Installer: .*' <<<"$signature" || true)"
    [ -n "$authority" ] || die "not signed with a Developer ID Installer identity"
    pass "$authority"
    gatekeeper --type install ;;
  *) die "unsupported artifact type: $artifact" ;;
esac
xcrun stapler validate "$artifact" >/dev/null 2>&1 || die "no valid stapled notarization ticket"
pass "notarization ticket stapled"
