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
