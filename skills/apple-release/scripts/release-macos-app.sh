#!/bin/bash
# Archive a macOS app with Developer ID Application signing, notarize, staple,
# and package it as a zip (default) or a signed, notarized disk image.
# Usage: release-macos-app.sh (--project P.xcodeproj | --workspace W.xcworkspace) --scheme S
#                             [--out DIR] [--dmg]
set -euo pipefail
umask 077
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"

container_flag="" container="" scheme="" out="dist/release" dmg=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project|--workspace) container_flag="$1"; container="$2"; shift 2 ;;
    --scheme) scheme="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --dmg) dmg=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$container" ] && [ -n "$scheme" ] || die "--project or --workspace, and --scheme, are required"
[ -e "$container" ] || die "not found: $container"
load_config
require_signing_keychain
require_asc_key
[ -n "${APP_IDENTITY:-}" ] || die "APP_IDENTITY (Developer ID Application) is not configured"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cat > "$build/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>developer-id</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>$APP_IDENTITY</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>destination</key><string>export</string>
</dict></plist>
EOF

log "Archiving $scheme and exporting with $APP_IDENTITY (logs: $out/xcodebuild-*.log)"
# xcodebuild only finds identities in the keychain search list, hence --search-list.
# shellcheck disable=SC2016  # expanded by the inner shell
"$here/with-signing-keychain.sh" --search-list -- /bin/bash -c '
  set -euo pipefail
  source "$1/lib.sh"; load_config
  require_identity "$APP_IDENTITY" codesigning
  xcodebuild "$2" "$3" -scheme "$4" -configuration Release -destination "generic/platform=macOS" \
    -archivePath "$5/App.xcarchive" archive \
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$APP_IDENTITY" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    PROVISIONING_PROFILE_SPECIFIER= ENABLE_HARDENED_RUNTIME=YES \
    OTHER_CODE_SIGN_FLAGS="--timestamp --keychain $SIGNING_KEYCHAIN" > "$6/xcodebuild-archive.log" 2>&1 || {
      echo "apple-release: archive failed; see $6/xcodebuild-archive.log" >&2; exit 1; }
  xcodebuild -exportArchive -archivePath "$5/App.xcarchive" -exportPath "$5/export" \
    -exportOptionsPlist "$5/ExportOptions.plist" > "$6/xcodebuild-export.log" 2>&1 || {
      echo "apple-release: export failed; see $6/xcodebuild-export.log" >&2; exit 1; }
' _ "$here" "$container_flag" "$container" "$scheme" "$build" "$out"

apps=("$build"/export/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] || die "expected exactly one exported .app"
name="$(basename "${apps[0]}" .app)"
rm -rf "${out:?}/$name.app"
ditto "${apps[0]}" "$out/$name.app"
app="$out/$name.app"

"$here/notarize.sh" "$app"
"$here/verify.sh" "$app"

if [ "$dmg" -eq 1 ]; then
  staging="$build/dmg"
  mkdir -p "$staging"
  ditto "$app" "$staging/$name.app"
  ln -s /Applications "$staging/Applications"
  artifact="$out/$name.dmg"
  rm -f "$artifact"
  hdiutil create -quiet -volname "$name" -srcfolder "$staging" -fs HFS+ -format UDZO "$artifact"
  # shellcheck disable=SC2016  # expanded by the inner shell
  "$here/with-signing-keychain.sh" -- /bin/bash -c '
    source "$1/lib.sh"; load_config
    codesign --timestamp --keychain "$SIGNING_KEYCHAIN" --sign "$APP_IDENTITY" "$2"
  ' _ "$here" "$artifact"
  "$here/notarize.sh" "$artifact"
  "$here/verify.sh" "$artifact"
else
  artifact="$out/$name.zip"
  rm -f "$artifact"
  ditto -c -k --keepParent "$app" "$artifact"
fi
log "Ready to share: $artifact"
