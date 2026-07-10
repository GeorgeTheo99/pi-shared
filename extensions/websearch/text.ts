const MAX_TOOL_OUTPUT_CHARS = 64_000;
const MAX_TOOL_LINE_CHARS = 8_000;
const TRUNCATION_MARKER = "\n\n[Output truncated locally to keep Pi's terminal renderer responsive.]";

function finiteLimit(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function normalizeToolText(
	text: string,
	maxChars = MAX_TOOL_OUTPUT_CHARS,
): string {
	const safeMaxChars = finiteLimit(maxChars, MAX_TOOL_OUTPUT_CHARS);
	const normalized = text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
	let truncated = false;
	const boundedLines = normalized.split("\n").map((line) => {
		if (line.length <= MAX_TOOL_LINE_CHARS) return line;
		truncated = true;
		return line.slice(0, MAX_TOOL_LINE_CHARS);
	});
	let bounded = boundedLines.join("\n");
	const contentLimit = truncated
		? Math.max(0, safeMaxChars - TRUNCATION_MARKER.length)
		: safeMaxChars;
	if (bounded.length > contentLimit) {
		bounded = bounded.slice(0, Math.max(0, safeMaxChars - TRUNCATION_MARKER.length));
		truncated = true;
	}
	if (!truncated) return bounded;
	if (safeMaxChars < TRUNCATION_MARKER.length) return bounded.slice(0, safeMaxChars);
	return `${bounded.slice(0, safeMaxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function normalizeCount(value: number, fallback: number): number {
	return finiteLimit(value, fallback);
}

export const TOOL_OUTPUT_CHAR_LIMIT = MAX_TOOL_OUTPUT_CHARS;
