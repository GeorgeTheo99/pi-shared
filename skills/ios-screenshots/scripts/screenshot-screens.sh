#!/bin/bash
# Generic iOS per-screen screenshot harness driver.
#
# Boots a SwiftUI app in an iOS simulator once per screen id, passing a launch
# argument that selects which screen to render, and captures a PNG — without
# driving taps. App-agnostic: all project-specific values are parameters.
#
# The APP must cooperate (DEBUG-only) by:
#   1. Reading the launch arg "<LAUNCH_ARG> <id>" at startup.
#   2. Rendering a single screen for that id (a "ScreenshotHost" view) instead
#      of its normal auth-gated root.
#   3. (optional) Injecting fixtures so screens render POPULATED, not empty.
# See SKILL.md for the host/fixtures conventions.
#
# Requires FULL Xcode + a simulator (NOT a Command-Line-Tools-only machine).
#
# ─── Parameters (env vars, with sane defaults where possible) ─────────────────
#   PROJECT_DIR  (required) app root containing project.yml + <PROJECT>.xcodeproj
#   SCHEME       (required) xcodebuild scheme, e.g. MyApp_iOS
#   BUNDLE_ID    (required) app bundle id, e.g. com.example.MyApp
#   IDS          screen ids to shoot. Either set directly (space-separated) OR
#                provide IDS_CMD (a shell command that prints them).
#   IDS_CMD      command that prints the id list (overrides nothing if IDS set)
#   LAUNCH_ARG   launch argument name. Default: -screenshotScreen
#   APP_NAME     built .app name. Default: derived from SCHEME (strip _iOS/_macOS)
#   SIM_NAME     simulator device name. Default: "iPhone 17 Pro"
#   OUT_DIR      output dir for PNGs. Default: $PROJECT_DIR/build/screenshots
#   SETTLE       seconds to let a screen render before capture. Default: 2.2
#   RENDER_MODE  capture strategy:
#                  viewport      (default) `xcrun simctl io screenshot` — fast,
#                                but clips anything below the visible window.
#                  imagerenderer full-content capture: launches with
#                                RENDER_ARG "<id> <container-path>", the app
#                                renders the whole (unclipped) screen to a PNG
#                                in its container via SwiftUI ImageRenderer, and
#                                this driver copies it out. Requires the app to
#                                implement the RENDER_ARG contract (see SKILL.md).
#   RENDER_ARG   launch arg for imagerenderer mode. Default: -screenshotRender
#   RENDER_NAME  container-relative PNG path the app writes / driver reads.
#                Default: Documents/shot.png
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:?set PROJECT_DIR to the app root (contains project.yml)}"
SCHEME="${SCHEME:?set SCHEME to the xcodebuild scheme}"
BUNDLE_ID="${BUNDLE_ID:?set BUNDLE_ID to the app bundle id}"
LAUNCH_ARG="${LAUNCH_ARG:--screenshotScreen}"
SIM_NAME="${SIM_NAME:-iPhone 17 Pro}"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/build/screenshots}"
DD="${DD:-$PROJECT_DIR/build/dd-shots}"
SETTLE="${SETTLE:-2.2}"
RENDER_MODE="${RENDER_MODE:-viewport}"
RENDER_ARG="${RENDER_ARG:--screenshotRender}"
RENDER_NAME="${RENDER_NAME:-Documents/shot.png}"
# Default .app name: scheme minus a trailing _iOS / _macOS suffix.
APP_NAME="${APP_NAME:-${SCHEME%_iOS}}"
APP_NAME="${APP_NAME%_macOS}"

export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
command -v xcodegen >/dev/null || { echo "ERROR: xcodegen not found (run on a full-Xcode machine)" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "ERROR: xcodebuild not found (CLT-only machine?)" >&2; exit 1; }

# Resolve the screen id list.
if [ -z "${IDS:-}" ]; then
  if [ -n "${IDS_CMD:-}" ]; then
    IDS="$(eval "$IDS_CMD")"
  else
    echo "ERROR: provide IDS (space-separated) or IDS_CMD (command printing ids)" >&2
    exit 1
  fi
fi
[ -n "${IDS// /}" ] || { echo "ERROR: empty screen id list" >&2; exit 1; }
echo "==> Screens: $IDS"

echo "==> xcodegen generate"
( cd "$PROJECT_DIR" && xcodegen generate >/dev/null )

PROJECT_FILE=$(find "$PROJECT_DIR" -maxdepth 1 -name '*.xcodeproj' | head -1)
[ -n "$PROJECT_FILE" ] || { echo "ERROR: no .xcodeproj in $PROJECT_DIR" >&2; exit 1; }

echo "==> Resolve simulator '$SIM_NAME'"
DEV_UDID=$(xcrun simctl list devices available | awk -F'[()]' -v n="$SIM_NAME" '$0 ~ n {print $2; exit}')
[ -n "$DEV_UDID" ] || { echo "ERROR: simulator '$SIM_NAME' not found" >&2; exit 1; }
echo "    $SIM_NAME = $DEV_UDID"

echo "==> Build for simulator (Debug, unsigned)"
xcodebuild -project "$PROJECT_FILE" -scheme "$SCHEME" \
  -configuration Debug -destination "id=$DEV_UDID" \
  -derivedDataPath "$DD" build CODE_SIGNING_ALLOWED=NO \
  >/tmp/shots-build.log 2>&1 || { echo "BUILD FAILED — see /tmp/shots-build.log"; tail -20 /tmp/shots-build.log; exit 1; }
APP_PATH=$(find "$DD/Build/Products" -name "${APP_NAME}.app" -path '*-iphonesimulator*' | head -1)
[ -n "$APP_PATH" ] || { echo "ERROR: built ${APP_NAME}.app not found" >&2; exit 1; }
echo "    app: $APP_PATH"

echo "==> Boot simulator"
xcrun simctl boot "$DEV_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$DEV_UDID" -b >/dev/null 2>&1 || true
xcrun simctl install "$DEV_UDID" "$APP_PATH"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.png 2>/dev/null || true

# Resolve the app's data-container path (for imagerenderer mode). Requires the
# app to be installed first; done once after install below.
app_container() { xcrun simctl get_app_container "$DEV_UDID" "$BUNDLE_ID" data 2>/dev/null; }

for id in $IDS; do
  echo "==> $id"
  xcrun simctl terminate "$DEV_UDID" "$BUNDLE_ID" 2>/dev/null || true

  if [ "$RENDER_MODE" = "imagerenderer" ]; then
    CONTAINER="$(app_container)"
    [ -n "$CONTAINER" ] || { echo "    WARN: no app container for $id"; continue; }
    SHOT="$CONTAINER/$RENDER_NAME"
    rm -f "$SHOT" 2>/dev/null || true
    # App renders the full screen to $SHOT (container path) then exits.
    xcrun simctl launch "$DEV_UDID" "$BUNDLE_ID" "$RENDER_ARG" "$id" "$SHOT" >/dev/null
    # Wait for the app to write the file (it renders after its own settle).
    for _ in $(seq 1 40); do [ -f "$SHOT" ] && break; sleep 0.25; done
    if [ -f "$SHOT" ]; then
      cp "$SHOT" "$OUT_DIR/$id.png" && echo "    captured $OUT_DIR/$id.png (full-content)"
    else
      echo "    WARN: app did not write $RENDER_NAME for $id (falling back to viewport)"
      xcrun simctl launch "$DEV_UDID" "$BUNDLE_ID" "$LAUNCH_ARG" "$id" >/dev/null
      sleep "$SETTLE"
      xcrun simctl io "$DEV_UDID" screenshot "$OUT_DIR/$id.png" >/dev/null 2>&1 \
        && echo "    captured $OUT_DIR/$id.png (viewport fallback)" \
        || echo "    WARN: capture failed for $id"
    fi
  else
    xcrun simctl launch "$DEV_UDID" "$BUNDLE_ID" "$LAUNCH_ARG" "$id" >/dev/null
    sleep "$SETTLE"
    xcrun simctl io "$DEV_UDID" screenshot "$OUT_DIR/$id.png" >/dev/null 2>&1 \
      && echo "    captured $OUT_DIR/$id.png" \
      || echo "    WARN: capture failed for $id"
  fi
done

xcrun simctl terminate "$DEV_UDID" "$BUNDLE_ID" 2>/dev/null || true
echo "==> Done. PNGs in $OUT_DIR"
ls -1 "$OUT_DIR"/*.png 2>/dev/null | wc -l | xargs echo "    count:"
