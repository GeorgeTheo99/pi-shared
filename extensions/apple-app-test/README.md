# Apple App Test

Shared pi extension for iOS Simulator and macOS app build/run/test diagnostics.

## Commands

```text
/apple-detect [options]
/apple-simulators
/apple-build [options]
/apple-run [options]
/apple-test [options]
/apple-screenshot [options]
/apple-logs [options]
```

## Common options

```text
--cwd <dir>                 Repo/project directory
--project <path>            .xcodeproj path
--workspace <path>          .xcworkspace path
--scheme <name>             Xcode scheme
--platform ios|macos
--configuration <name>      Default: Debug
--derived-data <path>       Default: ~/.pi/apple-app-test/DerivedData/<project-scheme-platform>
--timeout <seconds>         Default: 600
--dry-run
```

## iOS examples

```text
/apple-detect --cwd ~/local_code/LanguageLearning/GreekFlow
/apple-simulators
/apple-build --cwd ~/local_code/LanguageLearning/GreekFlow --platform ios
/apple-run --cwd ~/local_code/LanguageLearning/GreekFlow --platform ios
/apple-screenshot --platform ios
/apple-logs --platform ios --scheme LanguageFlow --last 5m
/apple-test --cwd ~/local_code/LanguageLearning/GreekFlow --platform ios
```

`/apple-run --platform ios` builds, boots/selects a simulator, installs the `.app`, reads the bundle id from `Info.plist`, and launches it.

## macOS examples

```text
/apple-build --cwd ~/path/to/MacApp --platform macos
/apple-run --cwd ~/path/to/MacApp --platform macos
/apple-screenshot --platform macos
/apple-logs --platform macos --scheme MyMacApp --last 5m
/apple-test --cwd ~/path/to/MacApp --platform macos
```

`/apple-run --platform macos` builds and opens the produced `.app` with `open -a`.

## Notes

- This extension does not upload to TestFlight, deploy, push, or mutate CI/CD.
- XCUITest support works through `xcodebuild test` once the project has test targets.
- For arbitrary UI tapping/typing, add XCUITest targets or a dedicated automation framework later.
- Artifacts are stored under `~/.pi/apple-app-test/`.
