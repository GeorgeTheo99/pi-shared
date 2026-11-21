/**
 * Prompt-cache-aware batching for provider-context edits.
 *
 * Replacing an earlier tool result (summary or aged image) changes the prompt
 * prefix, so every token after that point is re-billed at the uncached input
 * price on the next call. Edits therefore stay pending until they are worth
 * one cache miss, and are then applied together so several edits cost a
 * single miss instead of one each.
 */

/**
 * Apply pending edits from message `i` onward when their combined savings are
 * at least this share of the context from message `i` to the end. At 0.5 the
 * re-billed suffix is no larger than the savings. At a 20× cache-read discount
 * the boundary case pays back after ~18 later turns; tail edits (savings near
 * the whole suffix) pay back within a few. Below that ratio the miss rarely
 * pays back before compaction, so those edits wait for a cold cache or pressure.
 */
export const CACHE_FLUSH_SAVINGS_RATIO = 0.5;
/** After this long without a provider call, assume the prompt cache expired and a flush is free. */
export const CACHE_IDLE_MS = 5 * 60_000;
/** Apply everything once the estimated context reaches this share of the model's window. */
export const CONTEXT_PRESSURE_RATIO = 0.5;
export const CHARS_PER_TOKEN = 4;
/** Approximate provider-context weight of one image part (~1.5K tokens, Anthropic-sized; Gemini bills fewer). */
export const IMAGE_CONTEXT_CHARS = 6_000;

export type PendingEdit = {
	key: string;
	messageIndex: number;
	savedChars: number;
};

function partChars(part: unknown): number {
	if (!part || typeof part !== "object") return 0;
	const value = part as Record<string, unknown>;
	switch (value.type) {
		case "text":
			return typeof value.text === "string" ? value.text.length : 0;
		case "thinking":
			return typeof value.thinking === "string" ? value.thinking.length : 0;
		case "image":
			return IMAGE_CONTEXT_CHARS;
		case "toolCall":
			return String(value.name ?? "").length + (JSON.stringify(value.arguments ?? {})?.length ?? 0);
		default:
			return JSON.stringify(value)?.length ?? 0;
	}
}

/** Approximate provider-context size of one message in characters. */
export function messageContextChars(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const value = message as { content?: unknown; output?: unknown; summary?: unknown };
	let total = 0;
	// bashExecution messages carry `output`; compaction and branch summaries carry `summary`.
	if (typeof value.output === "string") total += value.output.length;
	if (typeof value.summary === "string") total += value.summary.length;
	if (typeof value.content === "string") return total + value.content.length;
	if (Array.isArray(value.content)) {
		for (const part of value.content) total += partChars(part);
	}
	return total;
}

export function contextUnderPressure(messageChars: readonly number[], contextWindow: number | undefined) {
	if (!contextWindow || contextWindow <= 0) return false;
	const tokens = messageChars.reduce((sum, chars) => sum + chars, 0) / CHARS_PER_TOKEN;
	return tokens >= CONTEXT_PRESSURE_RATIO * contextWindow;
}

/**
 * Choose which pending edits to apply now. `messageChars` must describe the
 * context as it would be sent without any pending edit. Returns every pending
 * key when `flushAll` is set (cold cache or context pressure); otherwise the
 * edits at or after the earliest message index whose cumulative savings reach
 * CACHE_FLUSH_SAVINGS_RATIO of the suffix starting there.
 */
export function selectEditsToApply(
	pending: readonly PendingEdit[],
	messageChars: readonly number[],
	flushAll: boolean,
): Set<string> {
	if (pending.length === 0) return new Set();
	if (flushAll) return new Set(pending.map((edit) => edit.key));
	const suffix = new Array<number>(messageChars.length + 1).fill(0);
	for (let index = messageChars.length - 1; index >= 0; index -= 1) {
		suffix[index] = suffix[index + 1]! + messageChars[index]!;
	}
	const ordered = [...pending].sort((a, b) => b.messageIndex - a.messageIndex);
	let saved = 0;
	let cutoff = Number.POSITIVE_INFINITY;
	for (let position = 0; position < ordered.length;) {
		const messageIndex = ordered[position]!.messageIndex;
		while (position < ordered.length && ordered[position]!.messageIndex === messageIndex) {
			saved += ordered[position]!.savedChars;
			position += 1;
		}
		if (saved >= CACHE_FLUSH_SAVINGS_RATIO * (suffix[messageIndex] ?? 0)) cutoff = messageIndex;
	}
	return new Set(pending.filter((edit) => edit.messageIndex >= cutoff).map((edit) => edit.key));
}
