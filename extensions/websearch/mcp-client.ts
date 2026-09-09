import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "research", "config.json");
export const DEFAULT_LOCAL_MCP = ["http://127.0.0.1:8889/mcp"];
export const WEB_SEARCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_TIMEOUT_MS = 65_000;

type Environment = Record<string, string | undefined>;

export interface McpToolCallResult {
	/** Index in the original endpointUrls argument; use it to recover the private configured URL. */
	endpointIndex?: number;
	/** Redacted diagnostic label only, not a reusable request URL. */
	endpointUrl?: string;
	checked: string[];
	text?: string;
	result?: unknown;
	error?: string;
}

export interface McpToolCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	requestId?: string;
	env?: Environment;
	fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function readSearchConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function resolveConfiguredMcpUrls(
	env: Environment,
	config: Record<string, unknown>,
	defaults = DEFAULT_LOCAL_MCP,
): string[] {
	const envValues = [env.PI_WEBSEARCH_MCP_URL, env.SEARCH_MCP_URL, env.WEBSEARCH_MCP_URL].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	const configValues = [config.websearchMcpUrl, config.mcpUrl].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	const configured = [...envValues, ...configValues];
	const candidates = configured.length > 0 ? configured : defaults;
	return [...new Set(candidates.map((value) => normalizeBaseUrl(value.trim())))];
}

export function readConfiguredMcpUrls(): string[] {
	return resolveConfiguredMcpUrls(process.env, readSearchConfig());
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
	return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function isLoopbackEndpoint(endpointUrl: string): boolean {
	try {
		const hostname = new URL(endpointUrl).hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, "")
			.replace(/\.$/, "");
		return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
	} catch {
		return false;
	}
}

export function mcpRequestHeaders(
	endpointUrl: string,
	env: Environment = process.env,
	includeTavilyKey = true,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	const loopback = isLoopbackEndpoint(endpointUrl);
	let secure = false;
	try {
		secure = new URL(endpointUrl).protocol === "https:";
	} catch {
		// Invalid endpoints fail in fetch without receiving credentials.
	}

	if (secure || loopback) {
		const brokerToken = firstNonEmpty([
			env.PI_WEBSEARCH_MCP_API_KEY,
			env.SEARCH_MCP_API_KEY,
		]);
		if (brokerToken) headers.Authorization = `Bearer ${brokerToken}`;
	}
	if (loopback && includeTavilyKey) {
		const tavilyKey = firstNonEmpty([
			env.PI_WEBSEARCH_TAVILY_API_KEY,
			env.TAVILY_API_KEY,
		]);
		if (tavilyKey) headers["X-Tavily-Key"] = tavilyKey;
	}
	return headers;
}

interface ValidatedEndpoint {
	url?: string;
	label: string;
	error?: string;
}

function validateEndpoint(endpointUrl: string): ValidatedEndpoint {
	let parsed: URL;
	try {
		parsed = new URL(endpointUrl);
	} catch {
		return { label: "[invalid MCP endpoint]", error: "Invalid MCP endpoint URL" };
	}
	const label = new URL(parsed);
	label.username = "";
	label.password = "";
	label.hash = "";
	for (const key of label.searchParams.keys()) {
		if (/(?:api[-_]?key|token|secret|password|auth|signature|sig)/i.test(key)) {
			label.searchParams.set(key, "[redacted]");
		}
	}
	const safeLabel = label.toString().replace(/\/$/, parsed.pathname.endsWith("/") ? "/" : "");
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { label: safeLabel, error: "MCP endpoint must use http or https" };
	}
	if (parsed.username || parsed.password) {
		return { label: safeLabel, error: "Embedded MCP URL credentials are not supported" };
	}
	return { url: endpointUrl, label: safeLabel };
}

function safeError(message: string, endpoints: string[], env: Environment): string {
	const secrets = new Set<string>();
	for (const endpoint of endpoints) {
		const validated = validateEndpoint(endpoint);
		message = message.split(endpoint).join(validated.label);
		try {
			const parsed = new URL(endpoint);
			for (const [key, value] of parsed.searchParams) {
				if (/(?:api[-_]?key|token|secret|password|auth|signature|sig)/i.test(key) && value) secrets.add(value);
			}
			if (parsed.password) secrets.add(decodeURIComponent(parsed.password));
		} catch { /* Invalid endpoint errors do not contain its raw URL. */ }
	}
	for (const key of ["PI_WEBSEARCH_MCP_API_KEY", "SEARCH_MCP_API_KEY", "PI_WEBSEARCH_TAVILY_API_KEY", "TAVILY_API_KEY"]) {
		if (env[key]?.trim()) secrets.add(env[key]!.trim());
	}
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		for (const value of new Set([secret, encodeURIComponent(secret)])) message = message.split(value).join("[redacted]");
	}
	return message.slice(0, 2048);
}

export function throwIfCallerAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason !== undefined) throw signal.reason;
	const error = new Error("Operation cancelled");
	error.name = "AbortError";
	throw error;
}

function createDeadline(timeoutMs: number, callerSignal?: AbortSignal) {
	throwIfCallerAborted(callerSignal);
	const controller = new AbortController();
	let timedOut = false;
	const onCallerAbort = () => controller.abort(callerSignal?.reason);
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		const error = new Error(`MCP request deadline exceeded after ${timeoutMs}ms`);
		error.name = "TimeoutError";
		controller.abort(error);
	}, timeoutMs);

	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
	const body = response.body;
	if (!body) return;
	let onAbort: () => void = () => {};
	try {
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			// Start disposal even on abort, but bound the cleanup wait by the request deadline.
			body.cancel().then(resolve, reject);
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function mcpResultText(result: unknown): string | undefined {
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			const parts = content
				.map((item) =>
					item && typeof item === "object" && ((item as { type?: unknown }).type === undefined || (item as { type?: unknown }).type === "text") && typeof (item as { text?: unknown }).text === "string"
						? (item as { text: string }).text
						: undefined,
				)
				.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
			if (parts.length) return parts.join("\n");
		}

		const structured = (result as { structuredContent?: unknown }).structuredContent;
		if (structured && typeof structured === "object" && Object.keys(structured).length > 0) return JSON.stringify(structured);
	}
	// Never serialize an empty/malformed MCP envelope into apparent page evidence.
	return undefined;
}

export async function mcpToolCall(
	endpointUrls: string[],
	toolName: string,
	args: Record<string, unknown>,
	options: McpToolCallOptions = {},
): Promise<McpToolCallResult> {
	const {
		signal: callerSignal,
		timeoutMs = 20_000,
		requestId = "pi-websearch",
		env = process.env,
		fetchImpl = fetch,
	} = options;
	const checked: string[] = [];
	const payload = {
		jsonrpc: "2.0",
		id: requestId,
		method: "tools/call",
		params: { name: toolName, arguments: args },
	};
	const deadline = createDeadline(timeoutMs, callerSignal);
	const timeoutError = `MCP request deadline exceeded after ${timeoutMs}ms`;
	let lastError: string | undefined;

	try {
		for (const [endpointIndex, endpointUrl] of endpointUrls.entries()) {
			throwIfCallerAborted(callerSignal);
			if (deadline.didTimeout()) {
				lastError = timeoutError;
				break;
			}
			const endpoint = validateEndpoint(endpointUrl);
			checked.push(endpoint.label);
			if (!endpoint.url) {
				lastError = endpoint.error;
				continue;
			}
			try {
				const response = await fetchImpl(endpoint.url, {
					method: "POST",
					headers: mcpRequestHeaders(endpoint.url, env, toolName === "web_search"),
					body: JSON.stringify(payload),
					redirect: "error",
					signal: deadline.signal,
				});
				throwIfCallerAborted(callerSignal);
				if (deadline.didTimeout()) {
					lastError = timeoutError;
					break;
				}
				if (!response.ok) {
					lastError = `HTTP ${response.status} ${response.statusText}`;
					try {
						await cancelResponseBody(response, deadline.signal);
					} catch {
						// Preserve the HTTP failure when body cleanup also fails.
					}
					throwIfCallerAborted(callerSignal);
					if (deadline.didTimeout()) {
						lastError = timeoutError;
						break;
					}
					continue;
				}

				const data = (await response.json()) as { result?: unknown; error?: unknown };
				throwIfCallerAborted(callerSignal);
				if (deadline.didTimeout()) {
					lastError = timeoutError;
					break;
				}
				if (data.error !== undefined) {
					lastError = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
					continue;
				}
				if (!("result" in data)) {
					lastError = "Malformed MCP response: missing result";
					continue;
				}

				const text = mcpResultText(data.result);
				if (
					data.result && typeof data.result === "object" &&
					(data.result as { isError?: unknown }).isError === true
				) {
					lastError = text || "MCP tool reported an error";
					continue;
				}
				if (!text) {
					lastError = "Malformed MCP response: empty result content";
					continue;
				}
				return { endpointIndex, endpointUrl: endpoint.label, checked, result: data.result, text };
			} catch (error) {
				throwIfCallerAborted(callerSignal);
				if (deadline.didTimeout()) {
					lastError = timeoutError;
					break;
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		return { checked, error: safeError(lastError ?? "MCP broker unavailable", endpointUrls, env) };
	} finally {
		deadline.dispose();
	}
}
