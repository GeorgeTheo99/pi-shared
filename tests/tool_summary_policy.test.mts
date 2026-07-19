import assert from "node:assert/strict";
import test from "node:test";

import {
	candidateForToolResult,
	deterministicReduce,
	deterministicReductionCanPreserve,
	exactLineRange,
	MAX_RECALL_OUTPUT_CHARS,
	makeSummaryReplacement,
	replacementIsWorthwhile,
	resolvePolicy,
	searchExactLines,
	summaryBodyBudget,
	SUMMARY_HARD_MAX_CHARS,
	toolContentHash,
} from "../extensions/tool-summary/policy.ts";
import {
	defaultToolSummaryConfig,
	estimatedContextSavings,
	makeCompletedSummaryRecord,
	makeExposureRecord,
	makeSkippedSummaryRecord,
	makeSummaryRetryRecord,
	restoreToolSummaryState,
	TOOL_SUMMARY_COMPLETE_TYPE,
	TOOL_SUMMARY_CONFIG_TYPE,
	TOOL_SUMMARY_EXPOSURE_TYPE,
	TOOL_SUMMARY_RETRY_TYPE,
	TOOL_SUMMARY_SKIP_TYPE,
	updatedConfig,
} from "../extensions/tool-summary/state.ts";

const textContent = (text: string) => [{ type: "text" as const, text }];

function candidate(toolName: string, text: string, isError = false) {
	return candidateForToolResult(
		{
			toolCallId: "call-policy-test",
			toolName,
			isError,
			content: textContent(text),
		},
		{ standard: 4_001, highFidelity: 4_001 },
	);
}

function defaultCandidate(toolName: string, text: string, isError = false) {
	return candidateForToolResult({
		toolCallId: "call-default-policy-test",
		toolName,
		isError,
		content: textContent(text),
	});
}

test("policy uses the agreed 24K high-fidelity and 16K standard thresholds", () => {
	assert.equal(defaultCandidate("read", "x".repeat(24_000)), undefined);
	assert.ok(defaultCandidate("read", "x".repeat(24_001)));
	assert.equal(defaultCandidate("web_fetch", "x".repeat(16_000)), undefined);
	assert.ok(defaultCandidate("web_fetch", "x".repeat(16_001)));
	assert.equal(defaultCandidate("read", "x".repeat(2_400)), undefined);
});

test("policy assigns LLM, deterministic, error, unknown, and exempt classes", () => {
	assert.equal(resolvePolicy("read", textContent("prose"), false).method, "llm");
	assert.equal(resolvePolicy("read", textContent("error"), true).method, "deterministic");
	assert.equal(resolvePolicy("bash", textContent("log"), false).method, "deterministic");
	assert.equal(resolvePolicy("app_api_request", textContent('{"id":"abc"}'), false).method, "deterministic");
	assert.equal(resolvePolicy("app_api_request", textContent("<html>prose</html>"), false).method, "llm");
	assert.equal(
		resolvePolicy(
			"app_api_request",
			textContent(JSON.stringify({ status: 200, headers: { "content-type": "text/html" }, body: "<html>prose</html>" })),
			false,
		).method,
		"llm",
	);
	assert.equal(resolvePolicy("custom_tool", textContent('{"rows":[1,2]}'), false).method, "deterministic");
	assert.equal(resolvePolicy("custom_tool", textContent("long prose"), false).method, "llm");
	assert.equal(resolvePolicy("tool_result_recall", textContent("x"), false).class, "exempt");
	assert.equal(resolvePolicy("memory_read", textContent("x"), false).class, "exempt");
	assert.equal(resolvePolicy("edit", textContent("x"), false).class, "exempt");
	assert.equal(
		resolvePolicy(
			"read",
			[{ type: "image", data: "base64", mimeType: "image/png" }],
			false,
		).class,
		"exempt",
	);
});

test("candidate hashes the exact content and keys changes to raw content", () => {
	const first = candidate("bash", "x".repeat(8_001));
	const second = candidate("bash", `${"x".repeat(8_000)}y`);
	assert.ok(first && second);
	assert.notEqual(first.rawHash, second.rawHash);
	assert.equal(first.rawHash, toolContentHash(first.content));
	assert.match(first.key, new RegExp(`:${first.rawHash}$`));
});

test("deterministic reducers are stable, bounded, and retain exact critical lines and tails", () => {
	const source = [
		"starting command",
		...Array.from({ length: 120 }, (_, index) => `ordinary line ${index}`),
		"ERROR assertion failed at /Users/example/project/file.ts:42",
		"stderr: exit code 17 request_id=req_123 sha256=abcdef0123456789",
		...Array.from({ length: 120 }, (_, index) => `later line ${index}`),
		"FINAL LOG LINE",
	].join("\n");
	const first = deterministicReduce(source, 1_600, "tail");
	const second = deterministicReduce(source, 1_600, "tail");
	assert.equal(first, second);
	assert.ok(first.length <= 1_600);
	assert.match(first, /ERROR assertion failed at \/Users\/example\/project\/file\.ts:42/);
	assert.match(first, /exit code 17/);
	assert.match(first, /FINAL LOG LINE/);
});

test("oversized early error lines cannot hide later exact exit codes", () => {
	const source = [
		`ERROR ${"oversized".repeat(900)}`,
		...Array.from({ length: 300 }, (_, index) => `ordinary output ${index}`),
		"stderr: command failed with exit code 73",
		"AssertionError at /Users/example/project/test.ts:88",
	].join("\n");
	const item = candidate("bash", source, true);
	assert.ok(item);
	const body = deterministicReduce(
		source,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.match(replacement, /exit code 73/);
	assert.match(replacement, /AssertionError at \/Users\/example\/project\/test\.ts:88/);
	assert.ok(replacement.length <= SUMMARY_HARD_MAX_CHARS);
});

test("critical values survive inside one oversized error line", () => {
	const source = `${"prefix".repeat(1_500)} stderr: command failed with exit code 91 at /Users/example/project/very-important.ts:144 ${"suffix".repeat(1_500)}`;
	const item = candidate("bash", source, true);
	assert.ok(item);
	const body = deterministicReduce(
		source,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.match(replacement, /exit code 91/);
	assert.match(replacement, /\/Users\/example\/project\/very-important\.ts:144/);
});

test("later root-cause windows outrank earlier generic error decoys", () => {
	const decoys = Array.from(
		{ length: 12 },
		(_, index) => `ERROR decoy-${index} ${"noise".repeat(100)}`,
	).join(" ");
	const source = `${decoys} ${"middle".repeat(500)} stderr: root command failed with exit code 91 at /Users/example/root-cause.ts:201 ${"tail".repeat(1_000)}`;
	const item = candidate("bash", source, true);
	assert.ok(item);
	const body = deterministicReduce(
		source,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.match(replacement, /exit code 91/);
	assert.match(replacement, /\/Users\/example\/root-cause\.ts:201/);
});

test("FATAL and AssertionError root causes outrank generic error decoys", () => {
	const decoys = Array.from(
		{ length: 12 },
		(_, index) => `ERROR decoy-${index} ${"noise".repeat(100)}`,
	).join(" ");
	const source = `${decoys} ${"middle".repeat(500)} FATAL service stopped; AssertionError expected=17 actual=19 ${"tail".repeat(1_000)}`;
	const item = candidate("bash", source, true);
	assert.ok(item);
	const body = deterministicReduce(
		source,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.match(replacement, /FATAL service stopped/);
	assert.match(replacement, /AssertionError expected=17 actual=19/);
});

test("an early padded FATAL line cannot suppress later separate root-cause lines", () => {
	const source = [
		`FATAL decoy ${"padding".repeat(150)}`,
		...Array.from({ length: 700 }, (_, index) => `ordinary line ${index}`),
		"stderr: actual command failed with exit code 73",
		"AssertionError expected=alpha actual=beta",
	].join("\n");
	const item = candidate("bash", source, true);
	assert.ok(item);
	const body = deterministicReduce(
		source,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.match(replacement, /exit code 73/);
	assert.match(replacement, /AssertionError expected=alpha actual=beta/);
});

test("tiny deterministic budgets never exceed their exact cap", () => {
	for (const limit of [1, 8, 16, 32]) {
		assert.ok(deterministicReduce("x".repeat(500), limit).length <= limit);
	}
});

test("summary body budgets enforce 40% savings at the minimum threshold", () => {
	const item = candidateForToolResult(
		{
			toolCallId: "call-low-threshold",
			toolName: "bash",
			isError: true,
			content: textContent(`ERROR ${"x".repeat(4_103)}`),
		},
		{ standard: 4_001, highFidelity: 16_000 },
	);
	assert.ok(item);
	const body = deterministicReduce(
		item.rawText,
		summaryBodyBudget(item, "deterministic"),
		"tail",
	);
	const replacement = makeSummaryReplacement(item, body, "deterministic");
	assert.equal(replacementIsWorthwhile(item.rawChars, replacement), true);
});

test("structured reduction preserves unsafe-size JSON integer lexemes exactly", () => {
	const source = `{"request_id":9007199254740993,"payload":"${"x".repeat(10_000)}","status":"error"}`;
	const reduced = deterministicReduce(source, 1_500, "structured");
	assert.match(reduced, /9007199254740993/);
	assert.doesNotMatch(reduced, /9007199254740992/);
});

test("structured reducer formats lexically before selecting important identifiers", () => {
	const source = JSON.stringify({
		rows: Array.from({ length: 400 }, (_, index) => ({ index, value: "v".repeat(20) })),
		error: "failed",
		request_id: "req_exact_123",
	});
	const reduced = deterministicReduce(source, 1_500, "structured");
	assert.ok(reduced.length <= 1_500);
	assert.match(reduced, /request_id/);
	assert.match(reduced, /req_exact_123/);
	assert.match(reduced, /error/);
});

test("deterministic reduction preserves every HTTP failure and diff file header that fits", () => {
	const required = [
		"status: 404 path=/missing",
		'"statusCode": 503,',
		"responseStatus=418",
		"httpStatusCode: 502",
		'"status-code": 401,',
		"status code 403",
		"response.status = 451",
		"HTTP/2 429 Too Many Requests",
		"diff --git a/src/one.ts b/src/one.ts",
		"--- a/src/one.ts",
		"+++ b/src/one.ts",
		"diff --git a/src/two.ts b/src/two.ts",
		"--- /dev/null",
		"+++ b/src/two.ts",
	];
	const source = [
		"status: 200 path=/healthy",
		...Array.from({ length: 300 }, (_, index) => `ordinary line ${index}`),
		...required,
		...Array.from({ length: 300 }, (_, index) => `tail line ${index}`),
	].join("\n");
	assert.equal(deterministicReductionCanPreserve(source, 2_500), true);
	const reduced = deterministicReduce(source, 2_500, "tail");
	assert.ok(reduced.length <= 2_500);
	for (const line of required) assert.ok(reduced.includes(line), `missing required line: ${line}`);
});

test("structured reduction retains the only non-2xx response", () => {
	const source = JSON.stringify({
		responses: Array.from({ length: 25 }, (_, index) => ({
			url: `https://example.test/request/${index}/${"x".repeat(80)}`,
			status: index === 17 ? 404 : 200,
		})),
	});
	const reduced = deterministicReduce(source, 1_200, "structured");
	assert.ok(reduced.length <= 1_200);
	assert.match(reduced, /"status": 404/);
});

test("required evidence overflow is detected instead of silently dropping lines", () => {
	const source = Array.from(
		{ length: 80 },
		(_, index) => `diff --git a/${"long-path/".repeat(5)}file-${index}.ts b/${"long-path/".repeat(5)}file-${index}.ts`,
	).join("\n");
	assert.equal(deterministicReductionCanPreserve(source, 1_000), false);
	assert.equal(deterministicReductionCanPreserve(source, source.length), true);
});

test("unpaired prose dividers are not treated as diff file headers", () => {
	const source = [
		...Array.from({ length: 80 }, (_, index) => `--- prose divider ${index}`),
		...Array.from({ length: 400 }, (_, index) => `ordinary line ${index}`),
	].join("\n");
	assert.equal(deterministicReductionCanPreserve(source, 500), true);
});

test("replacement obeys the 3K target and 4K hard cap and only applies at 40% savings", () => {
	const item = candidate("bash", "line\n".repeat(3_000));
	assert.ok(item);
	const replacement = makeSummaryReplacement(item, "summary ".repeat(1_000), "deterministic");
	assert.ok(replacement.length <= SUMMARY_HARD_MAX_CHARS);
	assert.match(replacement, /toolCallId: call-policy-test/);
	assert.match(replacement, /tool_result_recall/);
	assert.equal(replacementIsWorthwhile(item.rawChars, replacement), true);
	assert.equal(replacementIsWorthwhile(5_000, "x".repeat(3_001)), false);
});

test("persistence restores config and freezes the first valid completion per epoch", () => {
	const base = defaultToolSummaryConfig(1);
	const paused = updatedConfig(base, { mode: "pause" }, 2);
	const item = candidate("bash", "line\n".repeat(2_000));
	assert.ok(item);
	const exposure = makeExposureRecord(paused, item, 3);
	const replacement = makeSummaryReplacement(item, "first", "deterministic");
	const first = makeCompletedSummaryRecord(paused, {
		...item,
		replacement,
		source: "deterministic",
	});
	const later = { ...first, replacement: replacement.replace("first", "later"), createdAt: first.createdAt + 1 };
	const state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_CONFIG_TYPE, data: paused },
		{ type: "custom", customType: TOOL_SUMMARY_EXPOSURE_TYPE, data: exposure },
		{ type: "custom", customType: TOOL_SUMMARY_COMPLETE_TYPE, data: first },
		{ type: "custom", customType: TOOL_SUMMARY_COMPLETE_TYPE, data: later },
	]);
	assert.equal(state.config.mode, "pause");
	assert.equal(state.exposures.get(item.key)?.rawHash, item.rawHash);
	assert.equal(state.summaries.get(item.key)?.replacement, replacement);
});

test("former default thresholds migrate while custom pairs remain unchanged", () => {
	const base = defaultToolSummaryConfig(1);
	const legacyDefaults = { ...base, standardThreshold: 8_000, highFidelityThreshold: 16_000 };
	let state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_CONFIG_TYPE, data: legacyDefaults },
	]);
	assert.equal(state.config.standardThreshold, 16_000);
	assert.equal(state.config.highFidelityThreshold, 24_000);

	const custom = { ...base, standardThreshold: 9_000, highFidelityThreshold: 18_000 };
	state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_CONFIG_TYPE, data: custom },
	]);
	assert.equal(state.config.standardThreshold, 9_000);
	assert.equal(state.config.highFidelityThreshold, 18_000);
});

test("retry cooldowns persist and are superseded by terminal summaries", () => {
	const base = defaultToolSummaryConfig(1);
	const item = candidate("read", "report\n".repeat(1_000));
	assert.ok(item);
	const retry = makeSummaryRetryRecord(base, { ...item, attempt: 1, retryAfter: 40_000 }, 10_000);
	let state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_RETRY_TYPE, data: retry },
	]);
	assert.equal(state.retries.get(item.key)?.attempt, 1);
	assert.equal(state.summaries.size, 0);

	const replacement = makeSummaryReplacement(item, "successful retry", "model");
	const summary = makeCompletedSummaryRecord(base, { ...item, replacement, source: "model" }, 50_000);
	state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_RETRY_TYPE, data: retry },
		{ type: "custom", customType: TOOL_SUMMARY_COMPLETE_TYPE, data: summary },
	]);
	assert.equal(state.retries.size, 0);
	assert.equal(state.summaries.get(item.key)?.replacement, replacement);
});

test("not-worthwhile terminal records persist without copying raw content", () => {
	const base = defaultToolSummaryConfig(1);
	const item = candidate("bash", "line\n".repeat(2_000));
	assert.ok(item);
	const skipped = makeSkippedSummaryRecord(base, item, 2);
	const state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_SKIP_TYPE, data: skipped },
	]);
	assert.equal(state.skips.get(item.key)?.reason, "not-worthwhile");
	assert.equal("rawText" in skipped, false);
	assert.equal("content" in skipped, false);
});

test("reset epochs exclude older exposures and summaries without deleting history", () => {
	const base = defaultToolSummaryConfig(1);
	const item = candidate("bash", "line\n".repeat(2_000));
	assert.ok(item);
	const exposure = makeExposureRecord(base, item, 2);
	const replacement = makeSummaryReplacement(item, "summary", "deterministic");
	const summary = makeCompletedSummaryRecord(base, { ...item, replacement, source: "deterministic" }, 3);
	const reset = updatedConfig(base, { epoch: "reset-epoch" }, 4);
	const state = restoreToolSummaryState([
		{ type: "custom", customType: TOOL_SUMMARY_EXPOSURE_TYPE, data: exposure },
		{ type: "custom", customType: TOOL_SUMMARY_COMPLETE_TYPE, data: summary },
		{ type: "custom", customType: TOOL_SUMMARY_CONFIG_TYPE, data: reset },
	]);
	assert.equal(state.exposures.size, 0);
	assert.equal(state.summaries.size, 0);
});

test("estimated savings aggregates only persisted replacement sizes", () => {
	const base = defaultToolSummaryConfig(1);
	const one = candidate("bash", "a\n".repeat(5_000));
	const two = candidateForToolResult({
		toolCallId: "call-two",
		toolName: "bash",
		isError: false,
		content: textContent("b\n".repeat(9_000)),
	});
	assert.ok(one && two);
	const records = [one, two].map((item) => {
		const replacement = makeSummaryReplacement(item, "short", "deterministic");
		return makeCompletedSummaryRecord(base, { ...item, replacement, source: "deterministic" });
	});
	const savings = estimatedContextSavings(records);
	assert.equal(savings.count, 2);
	assert.equal(savings.savedChars, savings.rawChars - savings.replacementChars);
});

test("exact line helpers preserve requested substrings and literal search matches", () => {
	const source = "alpha\nBeta value\r\ngamma\nlast";
	const range = exactLineRange(source, 2, 3);
	assert.equal(range.text, "Beta value\r\ngamma\n");
	assert.equal(range.startLine, 2);
	assert.equal(range.endLine, 3);
	assert.deepEqual(
		searchExactLines(source, "VALUE", false).map((line) => ({ number: line.number, text: line.text })),
		[{ number: 2, text: "Beta value\r" }],
	);
	assert.equal(searchExactLines(source, "VALUE", true).length, 0);
	assert.equal(MAX_RECALL_OUTPUT_CHARS, 50_000);
});
