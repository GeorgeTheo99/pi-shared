#!/usr/bin/env python3
"""Patch installed Pi retry handling for recovered premature streams.

Pi persists retryable assistant errors before scheduling auto-retry. This patch
keeps those records for audit/cost accounting while omitting superseded attempts
from restored model context and transcript rendering. The live TUI removes only
the failed attempt's components while retrying and restores them if backoff is
canceled.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


LEGACY_BRANCH_MARKER = "// PI-SHARED RETRY BRANCH DETACH"
SESSION_MARKER = "// PI-SHARED SUPERSEDED RETRY FILTER"
INTERACTIVE_STATE_MARKER = "// PI-SHARED RETRY ERROR COMPONENT STATE"
INTERACTIVE_CAPTURE_MARKER = "// PI-SHARED RETRY ERROR COMPONENT CAPTURE"
INTERACTIVE_START_MARKER = "// PI-SHARED RECOVERED RETRY UI"
INTERACTIVE_END_MARKER = "// PI-SHARED RETRY FAILURE RESTORE"
ANTHROPIC_MARKER = "// PI-SHARED PROTOCOL-NEUTRAL PREMATURE STREAM ERROR"


def _find_anthropic_messages(install_dir: Path) -> Path:
    candidates = [
        install_dir / "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
        install_dir / "node_modules/@mariozechner/pi-ai/dist/api/anthropic-messages.js",
        install_dir / "../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
        install_dir / "../../node_modules/@mariozechner/pi-ai/dist/api/anthropic-messages.js",
    ]
    for candidate in candidates:
        resolved = Path(os.path.realpath(candidate))
        if resolved.is_file():
            return resolved
    raise SystemExit("Pi Anthropic Messages provider not found")


def _remove_legacy_branch_patch(text: str, path: Path) -> str:
    """Migrate the first local implementation without abandoning extension state."""
    if LEGACY_BRANCH_MARKER not in text:
        return text
    old = """        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);\n        // PI-SHARED RETRY BRANCH DETACH\n        // Keep the failed attempt in the append-only session tree for audit/cost\n        // accounting, but move the active leaf back before retrying. A recovered\n        // error then stays out of restored model context and the visible branch.\n        const retryBranch = this.sessionManager.getBranch();\n        for (let index = retryBranch.length - 1; index >= 0; index--) {\n            const entry = retryBranch[index];\n            if (entry.type === \"message\" && entry.message === message) {\n                if (entry.parentId === null) {\n                    this.sessionManager.resetLeaf();\n                }\n                else {\n                    this.sessionManager.branch(entry.parentId);\n                }\n                break;\n            }\n        }\n        this._emit({\n"""
    new = """        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);\n        this._emit({\n"""
    if text.count(old) != 1:
        raise SystemExit(f"Invalid legacy retry branch patch state in {path}")
    text = text.replace(old, new, 1)
    if LEGACY_BRANCH_MARKER in text:
        raise SystemExit(f"Legacy retry branch marker remains in {path}")
    return text


def _patch_session_manager(text: str, path: Path) -> str:
    if SESSION_MARKER not in text:
        insert_before = """/**\n * Build the active, compaction-aware session entry list.\n"""
        helper = """// PI-SHARED SUPERSEDED RETRY FILTER\n// Retry attempts remain in the append-only session tree for audit/cost totals.\n// Only the last assistant outcome before the next user turn belongs in restored\n// model context or the visible transcript. Plain custom state entries are kept.\nexport function omitSupersededRetryErrors(items) {\n    return items.filter((item, index) => {\n        if (item?.role !== \"assistant\" || item.stopReason !== \"error\") {\n            return true;\n        }\n        for (let later = index + 1; later < items.length; later++) {\n            const candidate = items[later];\n            if (candidate?.role === \"user\") {\n                return true;\n            }\n            if (candidate?.role === \"assistant\") {\n                return false;\n            }\n        }\n        return true;\n    });\n}\n\n"""
        if text.count(insert_before) != 1:
            raise SystemExit(f"Expected session-context insertion point not found exactly once in {path}")
        text = text.replace(insert_before, helper + insert_before, 1)

        old_build = """    const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);\n    return { messages, thinkingLevel, model };\n"""
        new_build = """    const messages = omitSupersededRetryErrors(buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages));\n    return { messages, thinkingLevel, model };\n"""
        if text.count(old_build) != 1:
            raise SystemExit(f"Expected session-context message projection not found exactly once in {path}")
        text = text.replace(old_build, new_build, 1)

    required = [
        SESSION_MARKER,
        "export function omitSupersededRetryErrors(items)",
        "const messages = omitSupersededRetryErrors(buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages));",
    ]
    for anchor in required:
        if text.count(anchor) != 1:
            raise SystemExit(f"Invalid superseded-retry filter state in {path}: {anchor!r}")
    return text


def _patch_interactive_mode(text: str, path: Path) -> str:
    old_import = 'import { SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.js";\n'
    new_import = 'import { omitSupersededRetryErrors, SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.js";\n'
    markers = {
        INTERACTIVE_STATE_MARKER,
        INTERACTIVE_CAPTURE_MARKER,
        INTERACTIVE_START_MARKER,
        INTERACTIVE_END_MARKER,
    }
    present_markers = {marker for marker in markers if marker in text}
    patched_anchors = [
        new_import.strip(),
        """    // Auto-retry state
    retryEscapeHandler;
    // PI-SHARED RETRY ERROR COMPONENT STATE
    retryErrorComponents = [];
""",
        """                    this.streamingComponent.updateContent(this.streamingMessage, false);
                    // PI-SHARED RETRY ERROR COMPONENT CAPTURE
                    if (this.streamingMessage.stopReason === "error") {
                        this.retryErrorComponents = [this.streamingComponent, ...this.pendingTools.values()];
                    }
                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
""",
        """            case "auto_retry_start": {
                // PI-SHARED RECOVERED RETRY UI
                // Hide only this failed attempt while retrying. Its session entry
                // remains active until another assistant outcome supersedes it.
                for (const component of this.retryErrorComponents) {
                    this.chatContainer.removeChild(component);
                }
                this.retryErrorComponents = [];
                // Set up escape to abort retry
""",
        """                // Show error only on final failure (success shows normal response)
                if (!event.success) {
                    // PI-SHARED RETRY FAILURE RESTORE
                    // Cancellation happens after the prior components were hidden
                    // and before a replacement assistant message exists. Restore
                    // the active transcript in that case; exhausted retries leave
                    // their final error components in place.
                    if (this.retryErrorComponents.length === 0) {
                        this.rebuildChatFromMessages();
                    }
                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
                }
                this.retryErrorComponents = [];
                this.ui.requestRender();
""",
        "        const items = omitSupersededRetryErrors(entries.flatMap((entry) => {\n",
        "        }));\n        this.renderSessionItems(items, options);\n",
    ]

    def validate_fully_patched(candidate: str) -> None:
        for anchor in patched_anchors:
            if candidate.count(anchor) != 1:
                raise SystemExit(f"Invalid recovered retry UI patch state in {path}: {anchor!r}")

    if present_markers == markers:
        validate_fully_patched(text)
        return text
    if present_markers == {INTERACTIVE_START_MARKER}:
        legacy_anchor = """            case \"auto_retry_start\": {\n                // PI-SHARED RECOVERED RETRY UI\n                // _prepareRetry has moved the failed attempt to an abandoned\n                // branch. Rebuild now so the transient error does not remain\n                // visible; a final failed attempt is still rendered normally.\n                this.rebuildChatFromMessages();\n                // Set up escape to abort retry\n"""
        unexpected = [anchor for anchor in patched_anchors if anchor != INTERACTIVE_START_MARKER]
        if text.count(legacy_anchor) != 1 or any(anchor in text for anchor in unexpected):
            raise SystemExit(f"Invalid partial recovered retry UI patch state in {path}")
    elif present_markers:
        raise SystemExit(f"Invalid partial recovered retry UI patch state in {path}")
    elif any(anchor in text for anchor in patched_anchors):
        raise SystemExit(f"Invalid unmarked recovered retry UI patch state in {path}")

    if new_import not in text:
        if text.count(old_import) != 1:
            raise SystemExit(f"Expected session-manager import not found exactly once in {path}")
        text = text.replace(old_import, new_import, 1)

    if INTERACTIVE_STATE_MARKER not in text:
        old_state = """    // Auto-retry state\n    retryEscapeHandler;\n"""
        new_state = """    // Auto-retry state\n    retryEscapeHandler;\n    // PI-SHARED RETRY ERROR COMPONENT STATE\n    retryErrorComponents = [];\n"""
        if text.count(old_state) != 1:
            raise SystemExit(f"Expected auto-retry state block not found exactly once in {path}")
        text = text.replace(old_state, new_state, 1)

    if INTERACTIVE_CAPTURE_MARKER not in text:
        old_capture = """                    this.streamingComponent.updateContent(this.streamingMessage, false);\n                    if (this.streamingMessage.stopReason === \"aborted\" || this.streamingMessage.stopReason === \"error\") {\n"""
        new_capture = """                    this.streamingComponent.updateContent(this.streamingMessage, false);\n                    // PI-SHARED RETRY ERROR COMPONENT CAPTURE\n                    if (this.streamingMessage.stopReason === \"error\") {\n                        this.retryErrorComponents = [this.streamingComponent, ...this.pendingTools.values()];\n                    }\n                    if (this.streamingMessage.stopReason === \"aborted\" || this.streamingMessage.stopReason === \"error\") {\n"""
        if text.count(old_capture) != 1:
            raise SystemExit(f"Expected assistant message-end block not found exactly once in {path}")
        text = text.replace(old_capture, new_capture, 1)

    legacy_start = """            case \"auto_retry_start\": {\n                // PI-SHARED RECOVERED RETRY UI\n                // _prepareRetry has moved the failed attempt to an abandoned\n                // branch. Rebuild now so the transient error does not remain\n                // visible; a final failed attempt is still rendered normally.\n                this.rebuildChatFromMessages();\n                // Set up escape to abort retry\n"""
    clean_start = """            case \"auto_retry_start\": {\n                // Set up escape to abort retry\n"""
    new_start = """            case \"auto_retry_start\": {\n                // PI-SHARED RECOVERED RETRY UI\n                // Hide only this failed attempt while retrying. Its session entry\n                // remains active until another assistant outcome supersedes it.\n                for (const component of this.retryErrorComponents) {\n                    this.chatContainer.removeChild(component);\n                }\n                this.retryErrorComponents = [];\n                // Set up escape to abort retry\n"""
    if INTERACTIVE_START_MARKER in text:
        if legacy_start in text:
            text = text.replace(legacy_start, new_start, 1)
    else:
        if text.count(clean_start) != 1:
            raise SystemExit(f"Expected auto-retry start block not found exactly once in {path}")
        text = text.replace(clean_start, new_start, 1)

    if INTERACTIVE_END_MARKER not in text:
        old_end = """                // Show error only on final failure (success shows normal response)\n                if (!event.success) {\n                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || \"Unknown error\"}`);\n                }\n                this.ui.requestRender();\n"""
        new_end = """                // Show error only on final failure (success shows normal response)\n                if (!event.success) {\n                    // PI-SHARED RETRY FAILURE RESTORE\n                    // Cancellation happens after the prior components were hidden\n                    // and before a replacement assistant message exists. Restore\n                    // the active transcript in that case; exhausted retries leave\n                    // their final error components in place.\n                    if (this.retryErrorComponents.length === 0) {\n                        this.rebuildChatFromMessages();\n                    }\n                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || \"Unknown error\"}`);\n                }\n                this.retryErrorComponents = [];\n                this.ui.requestRender();\n"""
        if text.count(old_end) != 1:
            raise SystemExit(f"Expected auto-retry end block not found exactly once in {path}")
        text = text.replace(old_end, new_end, 1)

    old_render_start = "        const items = entries.flatMap((entry) => {\n"
    old_render_end = "        });\n        this.renderSessionItems(items, options);\n"
    new_render_start = "        const items = omitSupersededRetryErrors(entries.flatMap((entry) => {\n"
    new_render_end = "        }));\n        this.renderSessionItems(items, options);\n"
    if new_render_start not in text:
        if text.count(old_render_start) != 1 or text.count(old_render_end) != 1:
            raise SystemExit(f"Expected session rendering projection not found exactly once in {path}")
        text = text.replace(old_render_start, new_render_start, 1)
        text = text.replace(old_render_end, new_render_end, 1)

    validate_fully_patched(text)
    return text


def _patch_anthropic_message(text: str, path: Path) -> str:
    old = '        throw new Error("Anthropic stream ended before message_stop");\n'
    previous = (
        "        // PI-SHARED PROTOCOL-NEUTRAL PREMATURE STREAM ERROR\n"
        '        throw new Error("Stream ended before message_stop (transport interrupted)");\n'
    )
    new = (
        "        // PI-SHARED PROTOCOL-NEUTRAL PREMATURE STREAM ERROR\n"
        '        throw new Error("Stream ended before a terminal response event");\n'
    )
    if previous in text:
        text = text.replace(previous, new, 1)
    elif ANTHROPIC_MARKER not in text:
        if text.count(old) != 1:
            raise SystemExit(f"Expected premature-stream error not found exactly once in {path}")
        text = text.replace(old, new, 1)
    required = [ANTHROPIC_MARKER, 'throw new Error("Stream ended before a terminal response event");']
    for anchor in required:
        if text.count(anchor) != 1:
            raise SystemExit(f"Invalid protocol-neutral stream error patch state in {path}: {anchor!r}")
    if "Anthropic stream ended before message_stop" in text or "transport interrupted" in text:
        raise SystemExit(f"Stale premature-stream wording remains in {path}")
    return text


def _syntax_check(node: str, path: Path, text: str) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".js", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, path.stat().st_mode & 0o777)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        checked = subprocess.run([node, "--check", str(temporary)], capture_output=True, text=True)
        if checked.returncode != 0:
            raise SystemExit(f"Refusing invalid patched Pi file {path}: {checked.stderr.strip()}")
    finally:
        temporary.unlink(missing_ok=True)


def patch_install(install_dir: Path) -> None:
    install_dir = install_dir.expanduser().resolve()
    agent_session = install_dir / "dist/core/agent-session.js"
    session_manager = install_dir / "dist/core/session-manager.js"
    interactive_mode = install_dir / "dist/modes/interactive/interactive-mode.js"
    anthropic_messages = _find_anthropic_messages(install_dir)
    files = {
        agent_session: _remove_legacy_branch_patch,
        session_manager: _patch_session_manager,
        interactive_mode: _patch_interactive_mode,
        anthropic_messages: _patch_anthropic_message,
    }
    for path in files:
        if not path.is_file():
            raise SystemExit(f"Required Pi runtime file not found: {path}")

    node = shutil.which("node")
    if not node:
        raise SystemExit("node is required to syntax-check patched Pi files")

    originals = {path: path.read_text() for path in files}
    patched = {path: patcher(originals[path], path) for path, patcher in files.items()}
    for path, text in patched.items():
        _syntax_check(node, path, text)

    for path, text in patched.items():
        if text == originals[path]:
            continue
        backup = path.with_suffix(path.suffix + ".pre-retry-ux.bak")
        if not backup.exists():
            backup.write_text(originals[path])
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            os.fchmod(fd, path.stat().st_mode & 0o777)
            with os.fdopen(fd, "w") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} PI_INSTALL_DIR")
    patch_install(Path(sys.argv[1]))
