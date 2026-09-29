#!/usr/bin/env python3
"""Classify an Apple project for release and print JSON evidence.

Usage: detect.py [PROJECT_DIR]

kind is one of: ios-app, macos-app, multiplatform-app, swiftpm-executable,
swiftpm-library, installer-package, xcodegen-ungenerated, unknown. The result
is evidence for the agent, not a decision: confirm the target with the user
when more than one scheme or platform could be shipped.
"""
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SKIP = {".git", ".build", "build", "DerivedData", "node_modules", "Pods", "dist", ".venv"}


def candidates(root, pattern, depth=3):
    """Files/dirs matching pattern within depth, pruning build output and bundle internals."""
    found = []
    for current, dirs, files in os.walk(root):
        level = len(Path(current).relative_to(root).parts)
        found += [Path(current) / name for name in dirs + files if fnmatch.fnmatch(name, pattern)]
        dirs[:] = [] if level + 1 >= depth else [
            d for d in dirs if d not in SKIP and not d.endswith((".xcodeproj", ".xcworkspace", ".app"))]
    return sorted(found)


def xcodebuild_json(*args):
    result = subprocess.run(["xcodebuild", *args, "-json"], capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def scheme_platforms(container_flag, container, scheme):
    settings = xcodebuild_json(container_flag, str(container), "-scheme", scheme,
                               "-configuration", "Release", "-showBuildSettings") or []
    platforms, apps = set(), []
    for target in settings:
        values = target.get("buildSettings", {})
        if values.get("WRAPPER_EXTENSION") != "app":
            continue
        apps.append(values.get("PRODUCT_NAME") or target.get("target"))
        platforms.update(values.get("SUPPORTED_PLATFORMS", values.get("PLATFORM_NAME", "")).split())
    return sorted(platforms), apps


def classify_xcode(root):
    workspaces = candidates(root, "*.xcworkspace")
    projects = candidates(root, "*.xcodeproj")
    container_flag, container = ("-workspace", workspaces[0]) if workspaces else \
        ("-project", projects[0]) if projects else (None, None)
    if not container:
        return None
    listing = xcodebuild_json("-list", container_flag, str(container)) or {}
    info = listing.get("workspace") or listing.get("project") or {}
    schemes = []
    for scheme in info.get("schemes", []):
        platforms, apps = scheme_platforms(container_flag, container, scheme)
        if apps:
            schemes.append({"scheme": scheme, "apps": apps, "platforms": platforms})
    macos = any("macosx" in s["platforms"] for s in schemes)
    ios = any("iphoneos" in s["platforms"] for s in schemes)
    kind = "multiplatform-app" if macos and ios else "macos-app" if macos else "ios-app" if ios else "unknown"
    return {"kind": kind, container_flag.lstrip("-"): str(container), "app_schemes": schemes,
            "other_containers": [str(p) for p in (workspaces + projects) if p != container]}


def classify_swiftpm(root):
    manifest = root / "Package.swift"
    if not manifest.is_file():
        return None
    text = manifest.read_text(errors="replace")
    executables = re.findall(r'\.executable(?:Target)?\(\s*name:\s*"([^"]+)"', text)
    return {"kind": "swiftpm-executable" if executables else "swiftpm-library",
            "package": str(manifest), "executables": executables}


def installer_scripts(root):
    hits = []
    for path in candidates(root, "*", depth=3):
        if path.is_file() and path.suffix in {".sh", ".py", ""} and path.stat().st_size < 512_000:
            try:
                if re.search(r"\b(pkgbuild|productbuild)\b", path.read_text(errors="ignore")):
                    hits.append(str(path))
            except OSError:
                continue
    return hits


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    result = classify_xcode(root)
    if result is None and (root / "project.yml").is_file():
        result = {"kind": "xcodegen-ungenerated", "spec": str(root / "project.yml"),
                  "next": "run `xcodegen generate`, then detect again"}
    if result is None:
        result = classify_swiftpm(root)
    packages = installer_scripts(root)
    if result is None:
        result = {"kind": "installer-package" if packages else "unknown"}
    if packages:
        result["installer_build_scripts"] = packages
    result["root"] = str(root)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
