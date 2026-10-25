import assert from "node:assert/strict";
import test from "node:test";

import { truncateUtf8Head } from "../extensions/_shared/text-bounds.ts";

for (const maxBytes of [64, 100, 1024, 4096]) {
	test(`UTF-8 truncation stays within the exact ${maxBytes}-byte cap`, () => {
		const output = truncateUtf8Head("🙂é漢字".repeat(5000), maxBytes, "live output");
		assert.ok(Buffer.byteLength(output, "utf8") <= maxBytes);
		assert.match(output, /truncated/);
	});
}

test("tool allowlists drop MCP with --no-mcp only on runtimes that support it", async () => {
	const { supportsNoMcpFlag, toolAllowlistArgs } = await import("../extensions/_shared/pi-agent-runner.ts");
	assert.deepEqual(toolAllowlistArgs(["read", "ls"], "1.3.0"), ["--tools", "read,ls", "--no-mcp"]);
	assert.deepEqual(toolAllowlistArgs(["read", "mcp__radius__*"], "1.3.0"), ["--tools", "read,mcp__radius__*"]);
	assert.deepEqual(toolAllowlistArgs(["read", "ask_parent"], "1.0.4"), ["--tools", "read,ask_parent", "--no-mcp"]);
	// Pre-1.0.4 runtimes reject --no-mcp and already exclude MCP tools under --tools.
	assert.deepEqual(toolAllowlistArgs(["read"], "1.0.3"), ["--tools", "read"]);
	assert.deepEqual(toolAllowlistArgs(["read"], undefined), ["--tools", "read"]);
	for (const [version, expected] of [["0.99.9", false], ["1.0.3", false], ["1.0.4", true], ["1.1.0", true], ["2.0.0", true], ["garbage", false]] as const) {
		assert.equal(supportsNoMcpFlag(version), expected, version);
	}
});
