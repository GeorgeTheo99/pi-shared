---
name: ios-screenshots
description: Capture a PNG of every screen of a native SwiftUI/Xcode app by booting it in an iOS simulator with a launch-arg that selects one screen at a time — no UI taps. Use when the user wants per-screen screenshots for design review, visual QA, parity audits, or docs. Requires full Xcode + a simulator (not a CLT-only machine). Sibling to the ios-testflight skill.
---

# Per-screen iOS screenshots (simulator harness)

Boot a SwiftUI app once per screen in an iOS simulator, pass a launch argument
that selects which screen to render, and capture a PNG. No taps, no navigation
driving — each screen renders directly, so the loop is fast and deterministic.

The generic driver lives at `scripts/screenshot-screens.sh`. The app must
cooperate with a small DEBUG-only harness (below). Everything app-specific is a
parameter; the script itself is portable across SwiftUI apps.

## Prerequisites (verify first, do not assume)

- **Full Xcode** (not just Command Line Tools): `xcodebuild -version` must
  print a version, and a simulator must exist. CLT-only machines have no SDK /
  no simulator and cannot run this.
- **xcodegen**: `which xcodegen` (`brew install xcodegen`). The driver runs
  `xcodegen generate`, so the app should keep a `project.yml` as source of truth.
- A simulator device installed (default `iPhone 17 Pro`; override with `SIM_NAME`).

## The app-side contract (DEBUG only, ~3 small pieces)

The driver only knows how to launch the app with `<LAUNCH_ARG> <id>` and grab a
screenshot. The app decides what that renders. Adopt this pattern once:

1. **Launch-arg branch** in the App entry (gated `#if DEBUG`): if
   `ProcessInfo.processInfo.arguments` contains `<LAUNCH_ARG>` followed by an id,
   render a single-screen host instead of the normal auth-gated root.

   ```swift
   @ViewBuilder private var rootContent: some View {
       #if DEBUG
       if let id = Self.screenshotScreenID {
           ScreenshotHost(screenID: id).environment(AppSession.screenshot())
       } else { RootView() }
       #else
       RootView()
       #endif
   }
   ```

2. **ScreenshotHost** — a `switch screenID { ... }` mapping each id to its
   SwiftUI screen. For detail screens that need a model, decode a JSON literal
   into a sample (works even when model types are `Decodable`-only).

3. **Populated state via fixtures (optional but recommended)** — a DEBUG
   `AppSession.screenshot()` factory that marks the session logged-in and swaps
   in a fixture transport returning canned JSON for every GET endpoint, so
   screens render POPULATED instead of empty. Without this you still get layout
   + chrome + empty states, which is often enough for a first pass.

All three are `#if DEBUG` + launch-arg gated → **zero Release/TestFlight impact.**

> Keep `ScreenshotHost`, the fixtures transport, and the screenshot `AppSession`
> factory in the APP, not in this skill — only the launch-arg name and the
> driver loop are shared. If the app has a screen contract (e.g. a `screens.json`),
> feed its ids to the driver via `IDS_CMD` so the shot list stays in sync.

## Run it

```bash
# Minimum: point at the app, give it a scheme + bundle id, and a screen list.
PROJECT_DIR=/path/to/app \
SCHEME=MyApp_iOS \
BUNDLE_ID=com.example.MyApp \
IDS="home devices chat settings" \
bash scripts/screenshot-screens.sh
```

Drive the id list from a contract instead of hardcoding:

```bash
PROJECT_DIR=/path/to/app SCHEME=MyApp_iOS BUNDLE_ID=com.example.MyApp \
IDS_CMD="python3 -c \"import json;print(' '.join(s['id'] for s in json.load(open('$PROJECT_DIR/spec/screens.json'))['screens']))\"" \
bash scripts/screenshot-screens.sh
```

PNGs land in `$OUT_DIR` (default `$PROJECT_DIR/build/screenshots`). On a remote
build host, `scp` them back to view.

## Parameters

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PROJECT_DIR` | yes | — | App root (contains `project.yml` + `.xcodeproj`) |
| `SCHEME` | yes | — | xcodebuild scheme (e.g. `MyApp_iOS`) |
| `BUNDLE_ID` | yes | — | App bundle id |
| `IDS` | yes* | — | Space-separated screen ids (*or use `IDS_CMD`) |
| `IDS_CMD` | yes* | — | Command that prints the id list (used when `IDS` unset) |
| `LAUNCH_ARG` | no | `-screenshotScreen` | Launch-arg name the app reads |
| `APP_NAME` | no | `SCHEME` minus `_iOS`/`_macOS` | Built `.app` name |
| `SIM_NAME` | no | `iPhone 17 Pro` | Simulator device |
| `OUT_DIR` | no | `$PROJECT_DIR/build/screenshots` | PNG output dir |
| `SETTLE` | no | `2.2` | Seconds to let a screen render before capture |

## How the driver works (steps it runs)

1. Resolve the id list (`IDS` or `IDS_CMD`).
2. `xcodegen generate` in `PROJECT_DIR`.
3. `xcodebuild` for an iOS Simulator destination — Debug, unsigned
   (`CODE_SIGNING_ALLOWED=NO`). Build log at `/tmp/shots-build.log` on failure.
4. Boot `SIM_NAME`, install the built `.app`.
5. For each id: `terminate` → `simctl launch … <LAUNCH_ARG> <id>` →
   `sleep $SETTLE` → `simctl io … screenshot $OUT_DIR/<id>.png`.
6. Collect PNGs; print the count.

## Gotchas

- **CLT-only machine**: no `xcodebuild` SDK / no simulator — build on a full-Xcode
  host. (E.g. a desktop/server, not a laptop with only Command Line Tools.)
- **`SETTLE` too low**: async-loaded screens capture mid-render. Bump it
  (e.g. `SETTLE=3.5`) for heavier screens.
- **Detail screens need a model**: decode a JSON literal into a sample inside
  `ScreenshotHost`; don't widen the app's wire types just for the harness.
- **Empty vs populated**: without the fixtures transport you get empty/default
  states. Add `AppSession.screenshot()` + a fixture transport for realistic shots.
- **Keep it DEBUG-gated**: the launch-arg branch, host, and fixtures must all be
  `#if DEBUG` so Release/TestFlight builds never include the harness.
