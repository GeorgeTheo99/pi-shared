from __future__ import annotations

import os
import subprocess
from pathlib import Path


SHARED_ROOT = Path(__file__).resolve().parents[1]
REPAIR = SHARED_ROOT / "bin" / "pi-omlx-repair"


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
    provider = install / "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
    compaction.parent.mkdir(parents=True)
    provider.parent.mkdir(parents=True)
    compaction.write_text("// calculateContextTokens(assistantMsg.usage) > 0\n")
    provider.write_text(provider_source)
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


def test_repairs_pi_08010_deferred_tool_layout_idempotently(tmp_path: Path):
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
    subprocess.run(["node", "--check", str(provider)], check=True, capture_output=True, text=True)

    second = run_repair(tmp_path, install)
    assert second.returncode == 0, second.stderr
    assert provider.read_text() == patched


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
