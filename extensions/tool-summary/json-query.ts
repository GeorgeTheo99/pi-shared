// JSON Pointer selection from validated source spans: numbers are never converted
// to JavaScript Numbers. Bounds apply to the entire document, not just the match.
export const MAX_JSON_SOURCE_CHARS = 5_000_000;
export const MAX_JSON_POINTER_CHARS = 4_096;
const MAX_DEPTH = 128;
const MAX_NODES = 200_000;

export class JsonQueryError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "JsonQueryError";
		this.code = code;
	}
}

function fail(code: string, message: string): never {
	throw new JsonQueryError(code, message);
}

export function pointerTokens(pointer: string): string[] {
	if (typeof pointer !== "string" || pointer.length > MAX_JSON_POINTER_CHARS) {
		fail("invalid_pointer", `JSON Pointer must be a string of at most ${MAX_JSON_POINTER_CHARS} characters.`);
	}
	if (pointer === "") return [];
	if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) {
		fail("invalid_pointer", "Use an RFC 6901 JSON Pointer: empty for root, otherwise /tokens with ~0 and ~1 escapes; URI fragments are unsupported.");
	}
	return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export type JsonSelection = {
	start: number;
	end: number;
	valueType: "object" | "array" | "string" | "number" | "boolean" | "null";
};

export function selectJsonSpan(text: string, pointer: string): JsonSelection | undefined {
	const tokens = pointerTokens(pointer);
	if (text.length > MAX_JSON_SOURCE_CHARS) fail("input_too_large", `JSON source exceeds ${MAX_JSON_SOURCE_CHARS} characters.`);
	let position = 0;
	let nodes = 0;
	let selected: JsonSelection | undefined;
	let invalidArrayIndex = false;
	const invalid = (): never => fail("invalid_json", `Invalid JSON at UTF-16 offset ${position}.`);
	const whitespace = () => {
		while (position < text.length && /[\x20\t\r\n]/.test(text[position]!)) position += 1;
	};
	const string = () => {
		if (text[position++] !== '"') invalid();
		while (position < text.length) {
			const char = text[position++]!;
			if (char === '"') return;
			if (char.charCodeAt(0) < 32) invalid();
			if (char !== "\\") continue;
			const escape = text[position++];
			if (escape === "u") {
				if (!/^[\da-fA-F]{4}$/.test(text.slice(position, position + 4))) invalid();
				position += 4;
			} else if (!escape || !'"\\/bfnrt'.includes(escape)) invalid();
		}
		invalid();
	};
	const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	const value = (depth: number, matched: number): void => {
		if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail("complexity_limit", "JSON exceeds the depth (128) or value-count (200000) guard.");
		whitespace();
		const start = position;
		const char = text[position];
		let valueType: JsonSelection["valueType"];
		if (char === "{" || char === "[") {
			const object = char === "{";
			if (!object && matched >= 0 && matched < tokens.length && !/^(?:0|[1-9]\d*)$/.test(tokens[matched]!)) {
				invalidArrayIndex = true;
			}
			valueType = object ? "object" : "array";
			const close = object ? "}" : "]";
			const keys = new Set<string>();
			let index = 0;
			position += 1;
			whitespace();
			if (text[position] !== close) {
				while (true) {
					let key = String(index++);
					if (object) {
						const keyStart = position;
						string();
						key = JSON.parse(text.slice(keyStart, position)) as string;
						if (keys.has(key)) fail("ambiguous_pointer", "Duplicate object keys make JSON Pointer recall ambiguous.");
						keys.add(key);
						whitespace();
						if (text[position++] !== ":") invalid();
					}
					value(depth + 1, matched >= 0 && matched < tokens.length && tokens[matched] === key ? matched + 1 : -1);
					whitespace();
					if (text[position] === close) break;
					if (text[position++] !== ",") invalid();
					whitespace();
				}
			}
			position += 1;
		} else if (char === '"') {
			valueType = "string";
			string();
		} else if (text.startsWith("true", position) || text.startsWith("false", position)) {
			valueType = "boolean";
			position += char === "t" ? 4 : 5;
		} else if (text.startsWith("null", position)) {
			valueType = "null";
			position += 4;
		} else {
			valueType = "number";
			number.lastIndex = position;
			const match = number.exec(text);
			if (!match) invalid();
			position = number.lastIndex;
		}
		if (matched === tokens.length) selected = { start, end: position, valueType };
	};
	value(0, 0);
	whitespace();
	if (position !== text.length) invalid();
	if (invalidArrayIndex) fail("invalid_array_index", "An array pointer token must be a canonical nonnegative index; leading zeros, signs, and '-' are unsupported.");
	return selected;
}

/** JSON serialization only; fidelity cannot exceed the already stored JS value. */
export function serializeDetails(details: unknown): string {
	let nodes = 0;
	let estimatedChars = 0;
	try {
		const text = JSON.stringify(details, function (key, value) {
			if (++nodes > MAX_NODES) fail("complexity_limit", "Details exceed the value-count guard.");
			// Bound string expansion before JSON.stringify allocates the full document.
			if (key.length > MAX_JSON_SOURCE_CHARS) fail("input_too_large", "Details key exceeds the JSON source guard.");
			estimatedChars += JSON.stringify(key).length + 2;
			if (typeof value === "string") {
				if (value.length > MAX_JSON_SOURCE_CHARS) fail("input_too_large", "Details string exceeds the JSON source guard.");
				estimatedChars += JSON.stringify(value).length;
			}
			if (estimatedChars > MAX_JSON_SOURCE_CHARS) fail("input_too_large", "Details exceed the JSON source guard.");
			return value;
		});
		if (text === undefined) fail("details_not_serializable", "Stored details have no JSON representation.");
		if (text.length > MAX_JSON_SOURCE_CHARS) fail("input_too_large", "Details exceed the JSON source guard.");
		return text;
	} catch (error) {
		if (error instanceof JsonQueryError) throw error;
		fail("details_not_serializable", "Stored details could not be serialized as JSON (for example, a cycle or BigInt).");
	}
}
