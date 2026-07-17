export const ASK_PARENT_TITLE_PREFIX = "[pi-spawn-subagent:ask-parent:v1] ";
export const ASK_PARENT_PLACEHOLDER = "Answer from the parent agent";
export const DEFAULT_INTERACTIVE_EXCHANGES = 10;
export const MAX_INTERACTIVE_EXCHANGES = 20;
export const MAX_INTERACTIVE_QUESTION_BYTES = 64 * 1024;
export const MAX_INTERACTIVE_ANSWER_BYTES = 64 * 1024;
export const MAX_INTERACTIVE_MESSAGE_BYTES = 64 * 1024;
export const MAX_INTERACTIVE_ID_CHARS = 160;

export interface InteractiveQuestion {
	id: string;
	exchange: number;
	text: string;
	askedAt: string;
	untrusted: true;
}

export function normalizeInteractiveExchangeLimit(value: unknown): number | undefined {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_INTERACTIVE_EXCHANGES
		? Number(value)
		: undefined;
}

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
