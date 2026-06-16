---
name: ios-testflight
description: Build a native Apple (SwiftUI/Xcode) app from source and get it onto a real iPhone via TestFlight. Covers xcodegen project setup, distribution signing with an App Store Connect API key, archiving, uploading, and (via the App Store Connect API) creating the app record check, internal beta group, and adding testers. Use when the user wants to ship an iOS app to TestFlight, "test on my phone", set up the upload pipeline, or debug why a build isn't appearing in TestFlight.
---

# Ship a native iOS app to TestFlight

End-to-end recipe to take SwiftUI source → a signed build → installable on a
real iPhone via TestFlight internal testing. Distilled from a working setup; the
**Gotchas** section lists the failures that actually bite and their fixes.

## Prerequisites (verify first, do not assume)

- **Full Xcode** (not just Command Line Tools) on the build machine.
  `xcodebuild -version` must print a version. CLT-only machines have no
  `xcodebuild` SDK / no simulator — build on a machine with full Xcode.
- **xcodegen**: `which xcodegen` (`brew install xcodegen`). Lets you keep a
  `project.yml` as source of truth instead of a hand-maintained `.xcodeproj`.
- **Apple Developer Program membership** + a **Team ID** (10 chars, e.g.
  `UU7DA9UM9D`). Find it in the Apple Developer account or an existing
  `project.yml`.
- **App Store Connect API key** (`.p8` file) with **App Manager** or **Admin**
  role, plus its **Key ID** and **Issuer ID**. These are SECRETS — keep them on
  the build machine only, never in git. An existing project's
  `.appstoreconnect.env` (env vars `APPSTORE_API_KEY_ID`, `APPSTORE_ISSUER_ID`,
  `APPSTORE_API_PRIVATE_KEY_PATH`) can be reused across apps under the same team.

> Secrets discipline: reference the `.p8` and key ids by path/env only. Never
> copy them into a repo, never print their values, never store in memory.

## Step 1 — project.yml (xcodegen)

Minimum viable universal app spec. Key settings that matter:

```yaml
name: MyApp
options:
  bundleIdPrefix: com.example
  deploymentTarget: { iOS: "17.0", macOS: "14.0" }
settings:
  base:
    SWIFT_VERSION: "6.0"            # match your Swift package
    DEVELOPMENT_TEAM: "TEAMID10"
    CODE_SIGN_STYLE: Automatic
packages:                          # if you link a local Swift package
  MyKit: { path: MyKit }
targets:
  MyApp:
    type: application
    platform: [iOS, macOS]         # generates schemes MyApp_iOS / MyApp_macOS
    sources: [MyApp]
    dependencies: [{ package: MyKit, product: MyKit }]
    info:
      path: MyApp/Info.generated.plist
      properties:
        # If the backend is plain HTTP on the LAN, you MUST allow it or every
        # request fails on-device:
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true }
        NSLocalNetworkUsageDescription: "Connects to your server on the local network."
        ITSAppUsesNonExemptEncryption: false   # auto-satisfies export compliance for HTTPS-only apps
    settings:
      base:
        GENERATE_INFOPLIST_FILE: true
        PRODUCT_BUNDLE_IDENTIFIER: com.example.MyApp
        TARGETED_DEVICE_FAMILY: "1,2"
        # App icon is REQUIRED for upload (see Gotcha #2):
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        INFOPLIST_KEY_CFBundleIconName: AppIcon
      configs:
        Debug:   { CODE_SIGN_IDENTITY: "" }    # simulator: unsigned is fine
        Release: { CODE_SIGN_IDENTITY: "" }    # archive UNSIGNED; export signs (Gotcha #1)
```

Generate + sanity-build for the simulator:

```bash
cd path/to/app && xcodegen generate
xcodebuild -list -project MyApp.xcodeproj            # confirm the scheme name (e.g. MyApp_iOS)
# build for a sim to catch compile errors cheaply:
DEVICE_ID=$(xcrun simctl list devices available -j | python3 -c 'import json,sys;[print(x["udid"]) or sys.exit(0) for r,v in json.load(sys.stdin)["devices"].items() for x in v if "iPhone" in x["name"] and x["isAvailable"]]')
xcodebuild -project MyApp.xcodeproj -scheme MyApp_iOS -sdk iphonesimulator -destination "id=$DEVICE_ID" -derivedDataPath build build
```

## Step 2 — App icon (required)

Add `MyApp/Assets.xcassets/AppIcon.appiconset/` with a single 1024×1024 PNG and
a `Contents.json` (modern single-size form):

```json
{ "images": [{ "filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" }],
  "info": { "author": "xcode", "version": 1 } }
```

Plus a top-level `Assets.xcassets/Contents.json` with just `{ "info": {...} }`.
Generate a placeholder icon with CoreGraphics if you have no artwork — see
`scripts/gen-placeholder-icon.swift` in this skill dir (`swift scripts/gen-placeholder-icon.swift out.png`).

## Step 3 — Create the App Store Connect app record

A build will NOT upload until the app record exists. Either:

- **Web UI**: App Store Connect → My Apps → ➕ → New App → platform iOS, a
  globally-unique Name, pick the Bundle ID, any SKU, Full Access.
- The **Bundle ID** must be registered first under Certificates, Identifiers &
  Profiles (Explicit App ID, no capabilities unless the code uses them — Sign in
  with Apple, Push, iCloud, etc.). Basic Keychain + HTTPS need NO capability.
- Or via API (see `scripts/asc.sh` helpers below).

## Step 4 — Archive + upload (the signing dance)

The proven flow: **archive UNSIGNED, then `-exportArchive` applies the App Store
*distribution* signature** via the API key. This needs no registered device
(development signing does — Gotcha #3).

```bash
set -a; source /path/to/.appstoreconnect.env; set +a
BUILD_NUMBER=$(date +%Y%m%d%H%M)

# 1) archive (unsigned)
xcodebuild -project MyApp.xcodeproj -scheme MyApp_iOS -configuration Release \
  -destination "generic/platform=iOS" -archivePath build/MyApp.xcarchive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPSTORE_API_PRIVATE_KEY_PATH" \
  -authenticationKeyID "$APPSTORE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID" \
  MARKETING_VERSION=0.1 CURRENT_PROJECT_VERSION=$BUILD_NUMBER \
  CODE_SIGNING_ALLOWED=NO archive

# 2) export + upload (ExportOptions: method=app-store-connect, destination=upload,
#    testFlightInternalTestingOnly=true, signingStyle=automatic, teamID=...)
xcodebuild -exportArchive -archivePath build/MyApp.xcarchive \
  -exportPath build/upload -exportOptionsPlist build/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPSTORE_API_PRIVATE_KEY_PATH" \
  -authenticationKeyID "$APPSTORE_API_KEY_ID" \
  -authenticationKeyIssuerID "$APPSTORE_ISSUER_ID"
```

A ready-to-adapt `upload-testflight.sh` lives alongside this skill in
`scripts/upload-testflight.sh.template`. To validate signing WITHOUT uploading,
set `destination=export` in ExportOptions — it produces a signed `.ipa` locally.
Verify it: `codesign -dvv Payload/MyApp.app` should show
`Authority=Apple Distribution: ...`.

## Step 5 — Make it appear in TestFlight (the part everyone forgets)

A `VALID` build is invisible to testers until it's in a beta group that includes
them. Do all of this via the App Store Connect API (`scripts/asc.sh`) or web UI:

1. Confirm the build processed: poll builds until `processingState == VALID`.
2. Create an **internal** beta group (`isInternalGroup: true`) — internal needs
   NO Beta App Review, so it's installable immediately.
3. **Assign the build to the group** (`POST /v1/betaGroups/{id}/relationships/builds`).
4. **Add the tester** by email (`POST /v1/betaTesters` with the group relationship).
   The email MUST match the Apple ID used in the tester's TestFlight app.
5. Tester installs the **TestFlight** app → the app appears → Install.

## App Store Connect API without dependencies

No `pyjwt`/`jq` needed — sign the ES256 JWT with `openssl`. See
`scripts/asc.sh` in this skill dir for a sourceable helper that defines
`asc_jwt` (mints a 5-min token from the `.p8`) and `asc GET|POST <path> [body]`.
Common calls:

```bash
source scripts/asc.sh           # needs APPSTORE_* env vars exported first
asc GET  "/v1/apps?filter[bundleId]=com.example.MyApp"
asc GET  "/v1/builds?filter[app]=APPID&fields[builds]=version,processingState"
asc POST "/v1/betaGroups" '{"data":{"type":"betaGroups","attributes":{"name":"Internal","isInternalGroup":true},"relationships":{"app":{"data":{"type":"apps","id":"APPID"}}}}}'
asc POST "/v1/betaGroups/GROUPID/relationships/builds" '{"data":[{"type":"builds","id":"BUILDID"}]}'
asc POST "/v1/betaTesters" '{"data":{"type":"betaTesters","attributes":{"email":"x@y.com","firstName":"A","lastName":"B"},"relationships":{"betaGroups":{"data":[{"type":"betaGroups","id":"GROUPID"}]}}}}'
```

## Gotchas (the ones that actually cost time)

1. **Unsigned archive / "no devices" error.** Forcing `CODE_SIGN_STYLE: Automatic`
   at archive time tries to make a *development* profile, which fails with
   *"team has no devices"*. Fix: archive with `CODE_SIGNING_ALLOWED=NO` and let
   `-exportArchive` apply the *distribution* signature (no device needed).
2. **Upload rejected: missing app icon** (`CFBundleIconName` / required
   120×120 & 152×152). The archive succeeds but the *upload* fails. Fix: add an
   `AppIcon` asset catalog (Step 2) and the two icon build settings.
3. **Multiplatform scheme name.** `platform: [iOS, macOS]` generates
   `MyApp_iOS` / `MyApp_macOS`, NOT `MyApp`. Use the suffixed scheme.
4. **Build is VALID but not in TestFlight.** Almost always: no beta group, build
   not assigned to a group, or the tester isn't in the group. See Step 5.
5. **Export compliance prompt.** Set `ITSAppUsesNonExemptEncryption: false` for
   HTTPS-only apps to auto-satisfy it and avoid a manual "Manage" step.
6. **macOS in the app record but only iOS uploaded** is fine — the iOS build
   populates the iOS TestFlight track; the Mac slot just sits empty until you
   wire Mac signing/notarization separately.
7. **Plain HTTP backend on LAN** needs `NSAllowsLocalNetworking` + a
   `NSLocalNetworkUsageDescription`, or on-device networking silently fails.
8. **CLT-only build machine** has no `xcodebuild`/simulator. Edit Swift + run
   `swift test` there, but archive/upload on a full-Xcode machine.

## Iterating

After the first setup, a new TestFlight build is one command
(`./scripts/upload-testflight.sh` with a fresh `BUILD_NUMBER`). Capabilities
(Push, etc.) can be added to the App ID later without recreating the app.
