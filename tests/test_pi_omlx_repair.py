from __future__ import annotations

import os
import subprocess
from itertools import combinations
from pathlib import Path

import pytest


SHARED_ROOT = Path(__file__).resolve().parents[1]
REPAIR = SHARED_ROOT / "bin" / "pi-omlx-repair"


CURRENT_AGENT_SESSION_FIXTURE = r'''export class AgentSession {
    async _prepareRetry(message) {
        const settings = this.settingsManager.getRetrySettings();
        this._retryAttempt++;
        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
        this._emit({
            type: "auto_retry_start",
            delayMs,
            errorMessage: message.errorMessage || "Unknown error",
        });
        return true;
    }
}
'''

CURRENT_SESSION_MANAGER_FIXTURE = r'''export function sessionEntryToContextMessages(entry) {
    return entry.type === "message" ? [entry.message] : [];
}
/**
 * Build the active, compaction-aware session entry list.
 */
export function buildContextEntries(entries) {
    return entries;
}
export function buildSessionContext(entries, leafId, byId) {
    const path = entries;
    const thinkingLevel = "off";
    const model = null;
    const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
    return { messages, thinkingLevel, model };
}
'''

CURRENT_INTERACTIVE_MODE_FIXTURE = r'''import { SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.js";
export class InteractiveMode {
    // Auto-retry state
    retryEscapeHandler;
    handleEvent(event) {
        switch (event.type) {
            case "message_end": {
                if (this.streamingComponent && event.message.role === "assistant") {
                    this.streamingMessage = event.message;
                    let errorMessage;
                    this.streamingComponent.updateContent(this.streamingMessage, false);
                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
                        if (!errorMessage) errorMessage = "Error";
                        for (const [, component] of this.pendingTools.entries()) {
                            component.updateResult({ isError: true });
                        }
                        this.pendingTools.clear();
                    }
                    this.streamingComponent = undefined;
                }
                break;
            }
            case "auto_retry_start": {
                // Set up escape to abort retry
                this.retryEscapeHandler = this.defaultEditor.onEscape;
                break;
            }
            case "auto_retry_end": {
                if (this.retryEscapeHandler) {
                    this.defaultEditor.onEscape = this.retryEscapeHandler;
                    this.retryEscapeHandler = undefined;
                }
                this.clearStatusIndicator("retry");
                // Show error only on final failure (success shows normal response)
                if (!event.success) {
                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
                }
                this.ui.requestRender();
                break;
            }
        }
    }
    renderSessionEntries(entries, options = {}) {
        const items = entries.flatMap((entry) => {
            if (entry.type === "custom") {
                return [entry];
            }
            return sessionEntryToContextMessages(entry);
        });
        this.renderSessionItems(items, options);
    }
}
'''

CURRENT_ANTHROPIC_MESSAGES_FIXTURE = r'''export async function streamAnthropic() {
        throw new Error("Anthropic stream ended before message_stop");
}
'''

CURRENT_OPENAI_COMPLETIONS_FIXTURE = r'''function hasToolHistory(messages) {
    return messages.length > 0;
}
function getDeferredToolNames(messages) {
    return new Set();
}
function getToolsByName(tools, names) {
    return [];
}
function isTextContentBlock(block) {
    return block.type === "text";
}
function sample(options, model, compat, stream, output, blocks, getContentIndex, finishBlock, choice) {
    let textBlock;
            const ensureTextBlock = () => {
                if (!textBlock) {
                    textBlock = { type: "text", text: "" };
                    blocks.push(textBlock);
                    stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
                }
                return textBlock;
            };
                    if (choice.delta.content !== null &&
                        choice.delta.content !== undefined &&
                        choice.delta.content.length > 0) {
                        const block = ensureTextBlock();
                        block.text += choice.delta.content;
                        stream.push({
                            type: "text_delta",
                            contentIndex: getContentIndex(block),
                            delta: choice.delta.content,
                            partial: output,
                        });
                    }
            for (const block of blocks) {
                finishBlock(block);
            }
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
}
function getCompat(model, detected) {
    return {
        deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
        sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
        supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
    };
}
'''


def fake_install(tmp_path: Path, provider_source: str) -> Path:
    install = tmp_path / "pi-install"
    compaction = install / "dist/core/compaction/compaction.js"
    agent_session = install / "dist/core/agent-session.js"
    session_manager = install / "dist/core/session-manager.js"
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    provider_dir = install / "node_modules/@earendil-works/pi-ai/dist/api"
    openai_provider = provider_dir / "openai-completions.js"
    anthropic_provider = provider_dir / "anthropic-messages.js"
    compaction.parent.mkdir(parents=True)
    interactive_mode.parent.mkdir(parents=True)
    provider_dir.mkdir(parents=True)
    compaction.write_text("// calculateContextTokens(assistantMsg.usage) > 0\n")
    agent_session.write_text(CURRENT_AGENT_SESSION_FIXTURE)
    session_manager.write_text(CURRENT_SESSION_MANAGER_FIXTURE)
    interactive_mode.write_text(CURRENT_INTERACTIVE_MODE_FIXTURE)
    openai_provider.write_text(provider_source)
    anthropic_provider.write_text(CURRENT_ANTHROPIC_MESSAGES_FIXTURE)
    return install


def run_repair(tmp_path: Path, install: Path) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.update(
        {
            "PI_INSTALL_DIR": str(install),
            "PI_OMLX_AGENT_DIR": str(tmp_path / "agent"),
            "PI_SHARED_DIR": str(SHARED_ROOT),
            "PI_LOCAL_EXTENSIONS_DIR": str(tmp_path / "no-local-extensions"),
        }
    )
    return subprocess.run([str(REPAIR)], capture_output=True, text=True, env=env)


def test_repairs_current_pi_layout_idempotently(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    provider = install / "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"

    first = run_repair(tmp_path, install)
    assert first.returncode == 0, first.stderr
    assert "Repaired oMLX Pi profile" in first.stdout

    patched = provider.read_text()
    assert patched.count("function createDsmlToolMarkupFilter") == 1
    assert patched.count("const dsmlTextFilter = createDsmlToolMarkupFilter") == 1
    assert patched.count("const flushDelta = dsmlTextFilter.flush();") == 1
    assert patched.count("stripDsmlToolMarkup: model.compat.stripDsmlToolMarkup ?? false") == 1

    agent_session = install / "dist/core/agent-session.js"
    session_manager = install / "dist/core/session-manager.js"
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    anthropic_provider = install / "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"
    assert "PI-SHARED RETRY BRANCH DETACH" not in agent_session.read_text()
    assert session_manager.read_text().count("PI-SHARED SUPERSEDED RETRY FILTER") == 1
    assert "export function omitSupersededRetryErrors(items)" in session_manager.read_text()
    assert interactive_mode.read_text().count("PI-SHARED RETRY ERROR COMPONENT STATE") == 1
    assert interactive_mode.read_text().count("PI-SHARED RETRY ERROR COMPONENT CAPTURE") == 1
    assert interactive_mode.read_text().count("PI-SHARED RECOVERED RETRY UI") == 1
    assert interactive_mode.read_text().count("PI-SHARED RETRY FAILURE RESTORE") == 1
    assert "omitSupersededRetryErrors(entries.flatMap" in interactive_mode.read_text()
    assert anthropic_provider.read_text().count("PI-SHARED PROTOCOL-NEUTRAL PREMATURE STREAM ERROR") == 1
    assert "Anthropic stream ended before message_stop" not in anthropic_provider.read_text()
    assert "Stream ended before a terminal response event" in anthropic_provider.read_text()
    runtime_files = (provider, agent_session, session_manager, interactive_mode, anthropic_provider)
    for runtime_file in runtime_files:
        subprocess.run(["node", "--check", str(runtime_file)], check=True, capture_output=True, text=True)

    behavior = subprocess.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            f'''import {{ omitSupersededRetryErrors }} from {str(session_manager)!r};
const user = {{ role: "user", content: "question" }};
const firstError = {{ role: "assistant", stopReason: "error", errorMessage: "first" }};
const customState = {{ type: "custom", customType: "work-plan", data: {{ active: 1 }} }};
const secondError = {{ role: "assistant", stopReason: "error", errorMessage: "second" }};
const success = {{ role: "assistant", stopReason: "stop", content: "ok" }};
const recovered = omitSupersededRetryErrors([user, firstError, customState, secondError, success]);
if (recovered.includes(firstError) || recovered.includes(secondError)) throw new Error("recovered errors remained");
if (!recovered.includes(customState) || !recovered.includes(success)) throw new Error("state or success was lost");
const exhausted = omitSupersededRetryErrors([user, firstError, customState, secondError]);
if (exhausted.includes(firstError) || !exhausted.includes(secondError) || !exhausted.includes(customState)) {{
    throw new Error("final failure or custom state filtering is wrong");
}}
''',
        ],
        capture_output=True,
        text=True,
    )
    assert behavior.returncode == 0, behavior.stderr

    first_patched = {runtime_file: runtime_file.read_text() for runtime_file in runtime_files}
    second = run_repair(tmp_path, install)
    assert second.returncode == 0, second.stderr
    assert all(runtime_file.read_text() == text for runtime_file, text in first_patched.items())


def test_repairs_pi_085_session_projection_without_dropping_cost_notices(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    old_projection = """            return sessionEntryToContextMessages(entry);
        });
"""
    current_projection = """            const messages = sessionEntryToContextMessages(entry);
            if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
                return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
            }
            return messages;
        });
"""
    source = interactive_mode.read_text()
    assert source.count(old_projection) == 1
    interactive_mode.write_text(source.replace(old_projection, current_projection, 1))

    result = run_repair(tmp_path, install)

    assert result.returncode == 0, result.stderr
    patched = interactive_mode.read_text()
    assert patched.count("omitSupersededRetryErrors(entries.flatMap") == 1
    assert patched.count("type: \"compaction_cost\"") == 1
    assert patched.count("kind: entry.type, usage: entry.usage") == 1


def test_fails_closed_when_retry_layout_is_unknown(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    session_manager = install / "dist/core/session-manager.js"
    session_manager.write_text("export function buildSessionContext() {}\n")

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "recovered-stream retry UX patch did not apply" in result.stderr
    assert "Repaired oMLX Pi profile" not in result.stdout


def test_fails_closed_when_marked_retry_patch_loses_semantic_anchor(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    assert run_repair(tmp_path, install).returncode == 0
    session_manager = install / "dist/core/session-manager.js"
    session_manager.write_text(
        session_manager.read_text().replace(
            "export function omitSupersededRetryErrors(items)",
            "function brokenRetryFilter(items)",
        )
    )

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "Invalid superseded-retry filter state" in result.stderr
    assert "Repaired oMLX Pi profile" not in result.stdout


INTERACTIVE_RETRY_MARKERS = (
    "// PI-SHARED RETRY ERROR COMPONENT STATE",
    "// PI-SHARED RETRY ERROR COMPONENT CAPTURE",
    "// PI-SHARED RECOVERED RETRY UI",
    "// PI-SHARED RETRY FAILURE RESTORE",
)


@pytest.mark.parametrize(
    "markers",
    [
        marker_set
        for size in range(1, len(INTERACTIVE_RETRY_MARKERS) + 1)
        for marker_set in combinations(INTERACTIVE_RETRY_MARKERS, size)
    ],
)
def test_fails_closed_for_partial_interactive_marker_sets(tmp_path: Path, markers: tuple[str, ...]):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    interactive_mode.write_text("\n".join(markers) + "\n" + interactive_mode.read_text())

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "recovered retry UI patch state" in result.stderr
    assert "Repaired oMLX Pi profile" not in result.stdout


def test_migrates_exact_legacy_retry_ui_patch(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    clean = """            case \"auto_retry_start\": {\n                // Set up escape to abort retry\n"""
    legacy = """            case \"auto_retry_start\": {\n                // PI-SHARED RECOVERED RETRY UI\n                // _prepareRetry has moved the failed attempt to an abandoned\n                // branch. Rebuild now so the transient error does not remain\n                // visible; a final failed attempt is still rendered normally.\n                this.rebuildChatFromMessages();\n                // Set up escape to abort retry\n"""
    interactive_mode.write_text(interactive_mode.read_text().replace(clean, legacy, 1))

    result = run_repair(tmp_path, install)

    assert result.returncode == 0, result.stderr
    patched = interactive_mode.read_text()
    assert legacy not in patched
    assert patched.count("PI-SHARED RETRY ERROR COMPONENT STATE") == 1
    assert "this.chatContainer.removeChild(component);" in patched


@pytest.mark.parametrize(
    "mutation",
    [
        "this.retryErrorComponents = [this.streamingComponent, ...this.pendingTools.values()];",
        "this.chatContainer.removeChild(component);",
        "                this.retryErrorComponents = [];\n                // Set up escape to abort retry",
        "this.rebuildChatFromMessages();",
        "                this.retryErrorComponents = [];\n                this.ui.requestRender();",
        "const items = omitSupersededRetryErrors(entries.flatMap((entry) => {",
    ],
)
def test_fails_closed_when_fully_marked_retry_behavior_is_incomplete(tmp_path: Path, mutation: str):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    assert run_repair(tmp_path, install).returncode == 0
    interactive_mode = install / "dist/modes/interactive/interactive-mode.js"
    patched = interactive_mode.read_text()
    assert patched.count(mutation) == 1
    interactive_mode.write_text(patched.replace(mutation, "/* removed retry behavior */", 1))

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "Invalid recovered retry UI patch state" in result.stderr
    assert "Repaired oMLX Pi profile" not in result.stdout


def test_fails_closed_when_provider_layout_is_unknown(tmp_path: Path):
    install = fake_install(tmp_path, "export {};\n")

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "DSML filter patch did not apply" in result.stderr
    assert "Repaired oMLX Pi profile" not in result.stdout


def test_fails_closed_when_existing_patch_markers_are_syntactically_corrupt(tmp_path: Path):
    install = fake_install(tmp_path, CURRENT_OPENAI_COMPLETIONS_FIXTURE)
    provider = install / "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
    assert run_repair(tmp_path, install).returncode == 0
    corrupt = "function incomplete(\n" + provider.read_text()
    provider.write_text(corrupt)

    result = run_repair(tmp_path, install)

    assert result.returncode != 0
    assert "Patched Pi provider is invalid" in result.stderr
    assert provider.read_text() == corrupt
    assert "Repaired oMLX Pi profile" not in result.stdout
