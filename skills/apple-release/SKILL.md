---
name: apple-release
description: Get an Apple project ready to share — signed, notarized and verified, or TestFlight-ready — without manual Keychain work. Detects the project type (iOS app, macOS app, SwiftPM tool, .pkg installer), routes iOS to ios-testflight, and handles macOS Developer ID signing, notarization, stapling, .dmg/.zip packaging and installer packages from unattended Pi sessions. Use when the user says "get this ready to share", "notarize", "sign for distribution", "make a dmg", "Developer ID", or asks why Gatekeeper blocks their app.
---

# Get an Apple project ready to share

Scripts live in `scripts/` next to this file. They read one private machine
config, never print secret values, and work from background Pi sessions (where
the login keychain is unusable) through a dedicated, password-unlocked signing
keychain.

**Guardrails.** Signing and notarization of the user's own project are fine
once the user asked for a release. Never upload to App Store Connect/TestFlight,
submit for App Review, publish a GitHub release, or put an artifact anywhere
public without explicit approval for that step. Never create, revoke or
download certificates or change App Store Connect access without approval.
Never print, `cat`, copy or log the config values, the `.p8`, or the keychain
password file; refer to them by path. The setup `.command` is for the user to
run in Terminal — ask them to; do not launch it on their behalf.

## 1. Detect what is being shipped

```bash
python3 scripts/detect.py [PROJECT_DIR]
```

| `kind` | Route |
|---|---|
| `ios-app` | Step 3a — defer to the `ios-testflight` skill |
| `macos-app` | Step 3b |
| `multiplatform-app` | Ask which platform(s); iOS via 3a, macOS via 3b |
| `installer-package` / `installer_build_scripts` present | Step 3c (build the unsigned .pkg with the project's own script first) |
| `swiftpm-executable` | Step 3d |
| `xcodegen-ungenerated` | Run `xcodegen generate`, then detect again |
| `swiftpm-library` / `unknown` | Nothing distributable; ask the user |

Confirm the scheme when `app_schemes` lists more than one candidate.

## 2. Check the machine (once per machine)

Config: `~/.config/apple-release/config.env` (mode 0600, dir 0700; override with
`APPLE_RELEASE_CONFIG`). Create/update it with `scripts/configure.sh` — it
references files in place and prints only which keys changed:

```bash
scripts/configure.sh --team TEAMID10 \
  --asc-env /path/to/.appstoreconnect.env   # ios-testflight style env; the .p8 stays where it is
```

| Key | Needed for |
|---|---|
| `APPLE_TEAM_ID` | everything |
| `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | notarization (`notarytool --key`); iOS uploads |
| `SIGNING_KEYCHAIN`, `SIGNING_KEYCHAIN_PASSWORD_FILE` | Developer ID signing |
| `APP_IDENTITY` | macOS apps, disk images, CLI binaries (`Developer ID Application: …`) |
| `INSTALLER_IDENTITY` | installer packages (`Developer ID Installer: …`) |

Signing identities must be in the dedicated keychain. The user sets it up once
by running `scripts/setup-signing-keychain.command` **in a logged-in Terminal**
(`open -a Terminal scripts/setup-signing-keychain.command`); macOS asks them to
approve exporting identities from the login keychain. It creates (or extends)
the keychain, keeps only this team's Developer ID identities, records
`APP_IDENTITY`/`INSTALLER_IDENTITY`, and locks it. Re-run it after adding a
certificate. Keychains lock after one idle hour (and on sleep); every script
relocks as soon as it finishes. A keychain created by an older setup with a
15-minute timeout can fail during long builds: while it is unlocked, run
`security set-keychain-settings -lut 3600 KEYCHAIN` (or re-run setup). Check
readiness without unlocking:

```bash
bash -c 'source scripts/lib.sh; load_config; security find-identity -v -p basic "$SIGNING_KEYCHAIN"'
```

**No Developer ID Application identity?** An App Store Connect API key — even an
Admin one — cannot use cloud-managed Developer ID certificates (xcodebuild
export fails with `Cloud signing permission error` / 403 "You haven't been given
access to cloud-managed distribution certificates"). The Account Holder creates
one once: Xcode → Settings → Accounts → the team → Manage Certificates → ＋ →
Developer ID Application. Then re-run the setup command. Developer ID
certificates are limited per team; ask before creating one.

## 3. Build, sign, notarize, verify

`scripts/verify.sh` checks what a downloading Mac checks: signature, Developer
ID authority, hardened runtime, Gatekeeper's `source=Notarized Developer ID`
verdict, and the stapled ticket. The app, disk image and package routes run it;
report its output and do not call an artifact ready unless it passes. (A zipped
CLI binary cannot be stapled or assessed this way; prefer the installer.)

### 3a. iOS → TestFlight

Follow the `ios-testflight` skill (cloud-managed App Store distribution signing
with the same API key; no keychain needed). The upload is external: get
approval first.

### 3b. macOS app → notarized .zip or .dmg

```bash
scripts/release-macos-app.sh --project App.xcodeproj --scheme App [--dmg] [--out dist/release]
```

Archives with manual Developer ID Application signing and hardened runtime,
exports with method `developer-id`, notarizes and staples the app, then either
zips it or builds a disk image (app + `/Applications` link) that is itself
signed, notarized, stapled and verified. xcodebuild logs go to the output dir.
Apps whose entitlements need a provisioning profile (iCloud, push, …) need a
Developer ID profile; the archive log says so.

### 3c. Installer package

Build the unsigned `.pkg` with the project's own tooling, then:

```bash
scripts/release-pkg.sh path/to/unsigned.pkg [--out dist/release]
```

Signs with `productsign --keychain`, notarizes, staples, verifies.

### 3d. SwiftPM command-line tool

A bare Mach-O can be notarized but not stapled, so prefer an installer:

```bash
SCRIPTS=/path/to/skills/apple-release/scripts   # this skill's scripts dir
swift build -c release --arch arm64 --arch x86_64
mkdir -p staging/usr/local/bin unsigned
cp .build/apple/Products/Release/TOOL staging/usr/local/bin/
"$SCRIPTS/with-signing-keychain.sh" --search-list -- /bin/bash -c 'source "$1/lib.sh"; load_config
  codesign --force --options runtime --timestamp --keychain "$SIGNING_KEYCHAIN" \
    --sign "$APP_IDENTITY" "$2"' _ "$SCRIPTS" staging/usr/local/bin/TOOL
pkgbuild --root staging --identifier com.example.tool --version X.Y.Z \
  --install-location / unsigned/TOOL.pkg
"$SCRIPTS/release-pkg.sh" unsigned/TOOL.pkg
```

For a zip instead, `ditto -c -k` the signed binary and run `scripts/notarize.sh`
on the zip (Gatekeeper then checks the ticket online).

## Building blocks

| Script | Purpose |
|---|---|
| `with-signing-keychain.sh [--search-list] -- cmd…` | Unlock via the Security API (no password in argv, no TTY), run, always lock; `--search-list` temporarily prepends the keychain for xcodebuild and codesign (both ignore it otherwise) and restores the exact previous list. Runs are serialized (`lockf`, up to 2 h wait) |
| `notarize.sh ARTIFACT` | `notarytool submit --wait --timeout 2h` with the API key (.app is zipped first); saves Apple's log as `ARTIFACT.notary-log.json` on rejection; staples .app/.dmg/.pkg |
| `verify.sh ARTIFACT` | Distribution checks listed above |

## Gotchas

- Background Pi sessions get `errSecInteractionNotAllowed` from the login
  keychain; that is why signing uses the dedicated keychain.
- `security unlock-keychain KC < file` reads the TTY in Terminal, not stdin.
- `notarytool store-credentials` needs a real TTY; these scripts avoid stored
  profiles entirely by passing `--key/--key-id/--issuer`.
- LibreSSL PKCS#12 files need `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
  -macalg sha1` or the identity will not pair on import.
- `codesign` and `security cms` refuse untrusted self-signed test identities, so
  rehearse keychain handling with throwaway keychains under `/tmp` (absolute
  paths — a bare name creates it in `~/Library/Keychains`) and
  `SETUP_SOURCE_KEYCHAIN=… SETUP_VALID_ONLY=0 APPLE_RELEASE_CONFIG=…`.
- Check `security list-keychains -d user` is unchanged after any keychain work.
- A renewed certificate keeps the old name; setup refuses ambiguous duplicates.
  Delete the older certificate, then re-run setup.
- Rejections are usually missing hardened runtime, a missing secure timestamp,
  or unsigned nested code; read the saved notary log.
