/**
 * App Testing Tools — native pi Playwright tools.
 *
 * This replaces the old MCP subprocess for app_* tools. The tool names and
 * behavior are kept compatible, but all browser work runs directly in this pi
 * extension.
 */

import { Type, StringEnum } from "@mariozechner/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { chromium, type BrowserContext, type Page, type Response } from "patchright";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const APP_BASE_URL = process.env.BROWSER_MCP_APP_BASE_URL ?? "http://127.0.0.1:8100";
const STORAGE_ROOT = expandHome(process.env.BROWSER_MCP_STORAGE_ROOT ?? "~/.local/share/browser-mcp");

const config = {
	baseUrl: APP_BASE_URL || undefined,
	allowedHosts: buildAllowedHosts(APP_BASE_URL, process.env.BROWSER_MCP_APP_ALLOWED_HOSTS),
	profileDir: expandHome(
		process.env.BROWSER_MCP_APP_PROFILE_DIR ?? join(STORAGE_ROOT, "profiles", "app"),
	),
	artifactDir: expandHome(
		process.env.BROWSER_MCP_APP_ARTIFACT_DIR ?? join(STORAGE_ROOT, "artifacts", "app"),
	),
	headless: envFlag("BROWSER_MCP_HEADLESS", true),
	defaultTimeoutMs: envInt("BROWSER_MCP_DEFAULT_TIMEOUT_MS", 15_000),
	viewportWidth: envInt("BROWSER_MCP_VIEWPORT_WIDTH", 1440),
	viewportHeight: envInt("BROWSER_MCP_VIEWPORT_HEIGHT", 1000),
	ignoreHttpsErrors: envFlag("BROWSER_MCP_IGNORE_HTTPS_ERRORS", false),
	browserChannel: process.env.BROWSER_MCP_BROWSER_CHANNEL,
	browserExecutablePath: process.env.BROWSER_MCP_BROWSER_EXECUTABLE_PATH,
	userAgent: process.env.BROWSER_MCP_USER_AGENT,
	consoleLogLimit: envInt("BROWSER_MCP_CONSOLE_LOG_LIMIT", 200),
	networkLogLimit: envInt("BROWSER_MCP_NETWORK_LOG_LIMIT", 400),
};

// Realistic browser identity used when BROWSER_MCP_USER_AGENT is unset.
// Vanilla headless Chromium advertises "HeadlessChrome" and navigator.webdriver=true;
// patchright fixes webdriver/CDP leaks, and this UA removes the remaining string tell.
const DEFAULT_STEALTH_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Launch args that further reduce automation tells (belt-and-suspenders with patchright).
const STEALTH_LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

function envFlag(name: string, defaultValue: boolean): boolean {
	const value = process.env[name];
	if (value == null) return defaultValue;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInt(name: string, defaultValue: number): number {
	const value = process.env[name];
	if (value == null || value.trim() === "") return defaultValue;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseHosts(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter(Boolean),
	);
}

function buildAllowedHosts(baseUrl: string | undefined, rawHosts: string | undefined): Set<string> {
	const hosts = parseHosts(rawHosts);
	if (baseUrl) {
		try {
			const host = new URL(baseUrl).hostname.toLowerCase();
			if (host) hosts.add(host);
		} catch {
			// Invalid base URL is reported later when a tool tries to resolve a path.
		}
	}
	return hosts;
}

function slug(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "artifact";
}

function utcNow(): string {
	return new Date().toISOString();
}

function hostMatchesRule(host: string, rule: string): boolean {
	if (rule.startsWith("*.")) return host.endsWith(rule.slice(1));
	return host === rule;
}

function resolveAppUrl(urlOrPath: string): string {
	if (!config.baseUrl && config.allowedHosts.size === 0) {
		throw new Error(
			"Configure BROWSER_MCP_APP_BASE_URL or BROWSER_MCP_APP_ALLOWED_HOSTS before using app-testing tools.",
		);
	}

	let candidate = urlOrPath.trim();
	if (!candidate) throw new Error("URL cannot be empty");

	if (candidate.startsWith("/") || !candidate.includes("://")) {
		if (!config.baseUrl) throw new Error("Relative paths require a configured base URL");
		candidate = new URL(candidate.replace(/^\/+/, ""), `${config.baseUrl.replace(/\/+$/, "")}/`).toString();
	}

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch (error) {
		throw new Error(`Invalid URL '${candidate}': ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https URLs are supported");

	const host = parsed.hostname.toLowerCase();
	if (!host) throw new Error("URL is missing a hostname");
	if (config.allowedHosts.size > 0) {
		for (const rule of config.allowedHosts) {
			if (hostMatchesRule(host, rule)) return parsed.toString();
		}
		throw new Error(`Host '${host}' is not allowed. Allowed hosts: ${JSON.stringify([...config.allowedHosts].sort())}`);
	}
	return parsed.toString();
}

function jsonText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function abortIfNeeded(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

// ---------------------------------------------------------------------------
// Native Playwright runtime
// ---------------------------------------------------------------------------

type ConsoleEntry = {
	timestamp: string;
	tab_index: number;
	url: string;
	type: string;
	text: string;
};

type NetworkEntry = Record<string, unknown>;

class NativeAppRuntime {
	private context: BrowserContext | null = null;
	private trackedPages = new Set<Page>();
	private activePageIndex = 0;
	private consoleLog: ConsoleEntry[] = [];
	private networkLog: NetworkEntry[] = [];
	private queue: Promise<void> = Promise.resolve();

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async shutdown(): Promise<void> {
		const context = this.context;
		this.context = null;
		this.trackedPages.clear();
		if (context) await context.close().catch(() => undefined);
	}

	private async ensureContext(): Promise<BrowserContext> {
		if (this.context) return this.context;

		await mkdir(config.profileDir, { recursive: true });
		await mkdir(config.artifactDir, { recursive: true });

		const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
			headless: config.headless,
			ignoreHTTPSErrors: config.ignoreHttpsErrors,
			viewport: { width: config.viewportWidth, height: config.viewportHeight },
			userAgent: config.userAgent ?? DEFAULT_STEALTH_USER_AGENT,
			args: STEALTH_LAUNCH_ARGS,
		};
		if (config.browserChannel) launchOptions.channel = config.browserChannel;
		if (config.browserExecutablePath) launchOptions.executablePath = config.browserExecutablePath;

		this.context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
		this.context.setDefaultTimeout(config.defaultTimeoutMs);
		this.context.on("page", (page) => {
			this.attachPage(page);
			this.activePageIndex = Math.max(this.context ? this.context.pages().length - 1 : 0, 0);
		});

		for (const page of this.context.pages()) this.attachPage(page);
		if (this.context.pages().filter((page) => !page.isClosed()).length === 0) {
			const page = await this.context.newPage();
			this.attachPage(page);
		}
		return this.context;
	}

	private attachPage(page: Page): void {
		if (this.trackedPages.has(page)) return;
		this.trackedPages.add(page);
		page.on("console", (message) => {
			this.pushConsole({
				timestamp: utcNow(),
				tab_index: this.indexForPage(page),
				url: page.url(),
				type: message.type(),
				text: message.text(),
			});
		});
		page.on("request", (request) => {
			this.pushNetwork({
				timestamp: utcNow(),
				kind: "request",
				tab_index: this.indexForPage(page),
				page_url: page.url(),
				method: request.method(),
				url: request.url(),
				resource_type: request.resourceType(),
			});
		});
		page.on("response", (response) => {
			this.pushNetwork({
				timestamp: utcNow(),
				kind: "response",
				tab_index: this.indexForPage(page),
				page_url: page.url(),
				status: response.status(),
				ok: response.ok(),
				url: response.url(),
				content_type: response.headers()["content-type"] ?? null,
			});
		});
	}

	private pushConsole(entry: ConsoleEntry): void {
		this.consoleLog.push(entry);
		if (this.consoleLog.length > config.consoleLogLimit) this.consoleLog.splice(0, this.consoleLog.length - config.consoleLogLimit);
	}

	private pushNetwork(entry: NetworkEntry): void {
		this.networkLog.push(entry);
		if (this.networkLog.length > config.networkLogLimit) this.networkLog.splice(0, this.networkLog.length - config.networkLogLimit);
	}

	private async pages(): Promise<Page[]> {
		const context = await this.ensureContext();
		let pages = context.pages().filter((page) => !page.isClosed());
		if (pages.length === 0) {
			const page = await context.newPage();
			this.attachPage(page);
			pages = [page];
		}
		return pages;
	}

	private indexForPage(page: Page): number {
		const pages = this.context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
		return pages.findIndex((candidate) => candidate === page);
	}

	private async activePage(): Promise<Page> {
		const pages = await this.pages();
		if (this.activePageIndex >= pages.length) this.activePageIndex = pages.length - 1;
		return pages[this.activePageIndex];
	}

	private async describePage(page?: Page, response?: Response | null): Promise<Record<string, unknown>> {
		const current = page ?? await this.activePage();
		return {
			url: current.url(),
			title: await current.title(),
			tab_index: this.indexForPage(current),
			status: response ? response.status() : null,
		};
	}

	async openUrl(url: string): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		const response = await page.goto(url, { waitUntil: "domcontentloaded" });
		return this.describePage(page, response);
	}

	async newTab(url?: string): Promise<Record<string, unknown>> {
		const context = await this.ensureContext();
		const page = await context.newPage();
		this.attachPage(page);
		this.activePageIndex = this.indexForPage(page);
		if (url) {
			const response = await page.goto(url, { waitUntil: "domcontentloaded" });
			return this.describePage(page, response);
		}
		return this.describePage(page);
	}

	async listTabs(): Promise<Array<Record<string, unknown>>> {
		const pages = await this.pages();
		return Promise.all(pages.map(async (page, index) => ({
			tab_index: index,
			active: index === this.activePageIndex,
			url: page.url(),
			title: await page.title(),
		})));
	}

	async setActiveTab(tabIndex: number): Promise<Record<string, unknown>> {
		const pages = await this.pages();
		if (tabIndex < 0 || tabIndex >= pages.length) throw new Error(`Invalid tab index ${tabIndex}. Open tabs: 0..${pages.length - 1}`);
		this.activePageIndex = tabIndex;
		const page = pages[tabIndex];
		await page.bringToFront();
		return this.describePage(page);
	}

	async closeTab(tabIndex?: number): Promise<Record<string, unknown>> {
		const pages = await this.pages();
		if (pages.length === 1) throw new Error("Cannot close the final tab. Reuse it instead.");
		const targetIndex = tabIndex ?? this.activePageIndex;
		if (targetIndex < 0 || targetIndex >= pages.length) throw new Error(`Invalid tab index ${targetIndex}. Open tabs: 0..${pages.length - 1}`);
		const page = pages[targetIndex];
		const closing: Record<string, unknown> = {
			closed_tab_index: targetIndex,
			closed_url: page.url(),
			closed_title: await page.title(),
		};
		await page.close();
		const remaining = await this.pages();
		this.activePageIndex = Math.min(this.activePageIndex, remaining.length - 1);
		closing.active_tab = await this.describePage(remaining[this.activePageIndex]);
		return closing;
	}

	async click(selector: string): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		await page.locator(selector).first().click();
		return this.describePage(page);
	}

	async typeText(selector: string, text: string, clear = true, submit = false): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		const locator = page.locator(selector).first();
		if (clear) await locator.fill("");
		await locator.fill(text);
		if (submit) await locator.press("Enter");
		return this.describePage(page);
	}

	async waitFor(selector?: string, urlContains?: string, state = "visible", timeoutMs = config.defaultTimeoutMs): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		if (selector) await page.waitForSelector(selector, { state: state as "visible" | "hidden" | "attached" | "detached", timeout: timeoutMs });
		if (urlContains) {
			const deadline = Date.now() + timeoutMs;
			while (!page.url().includes(urlContains)) {
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for url containing '${urlContains}'`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (!selector && !urlContains) await page.waitForLoadState("networkidle", { timeout: timeoutMs });
		return this.describePage(page);
	}

	async extractText(selector?: string, maxChars = 8_000): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		const locator = selector ? page.locator(selector).first() : page.locator("body");
		let text = await locator.innerText();
		if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n... [truncated at ${maxChars} chars]`;
		return {
			...await this.describePage(page),
			selector: selector ?? "body",
			text,
		};
	}

	async evaluate(script: string, arg?: unknown): Promise<Record<string, unknown>> {
		const source = script.trim();
		if (!source) throw new Error("JavaScript expression cannot be empty");
		const page = await this.activePage();
		const result = await page.evaluate(
			async ({ source, arg }) => {
				const evaluated = globalThis.eval(`(${source})`);
				if (typeof evaluated === "function") return await evaluated(arg);
				return evaluated;
			},
			{ source, arg },
		);
		return {
			...await this.describePage(page),
			result: result === undefined ? null : result,
			result_type: result === null ? "null" : typeof result,
			result_was_undefined: result === undefined,
		};
	}

	async screenshot(label?: string, fullPage = true): Promise<Record<string, unknown>> {
		const page = await this.activePage();
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
		const title = await page.title() || page.url() || "page";
		const path = join(config.artifactDir, `${stamp}-${slug(label ?? title)}.png`);
		await mkdir(config.artifactDir, { recursive: true });
		await page.screenshot({ path, fullPage });
		return {
			...await this.describePage(page),
			path,
		};
	}

	getConsoleLogs(limit = 50, level?: string): ConsoleEntry[] {
		const records = level ? this.consoleLog.filter((entry) => entry.type === level) : this.consoleLog;
		return records.slice(-limit);
	}

	getNetworkLog(limit = 50, statusMin?: number, urlContains?: string): NetworkEntry[] {
		return this.networkLog.filter((entry) => {
			const status = entry.status;
			if (statusMin != null && (typeof status !== "number" || status < statusMin)) return false;
			if (urlContains && !String(entry.url ?? "").includes(urlContains)) return false;
			return true;
		}).slice(-limit);
	}

	async pageState(): Promise<Record<string, unknown>> {
		return {
			active_page: await this.describePage(),
			tabs: await this.listTabs(),
			base_url: config.baseUrl ?? null,
			allowed_hosts: [...config.allowedHosts].sort(),
		};
	}
}

const runtime = new NativeAppRuntime();

async function apiRequest(args: {
	method: string;
	url_or_path: string;
	headers?: Record<string, string>;
	body?: string;
	timeout_seconds?: number;
	max_body_chars?: number;
}): Promise<Record<string, unknown>> {
	const method = args.method.toUpperCase();
	const response = await requestWithRedirects({
		method,
		url: resolveAppUrl(args.url_or_path),
		headers: args.headers,
		body: args.body,
		timeoutMs: (args.timeout_seconds ?? 30) * 1000,
		redirectsRemaining: 10,
	});
	const maxBodyChars = args.max_body_chars ?? 12_000;
	const truncated = response.body.length > maxBodyChars;
	return {
		method,
		url: response.url,
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers: response.headers,
		body: truncated ? response.body.slice(0, maxBodyChars) : response.body,
		truncated,
	};
}

async function requestWithRedirects(args: {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	redirectsRemaining: number;
}): Promise<{ url: string; status: number; headers: Record<string, string>; body: string }> {
	const response = await rawHttpRequest(args);
	const location = response.headers.location;
	if (
		location &&
		[301, 302, 303, 307, 308].includes(response.status) &&
		args.redirectsRemaining > 0
	) {
		const redirectedUrl = resolveAppUrl(new URL(location, args.url).toString());
		return requestWithRedirects({
			...args,
			url: redirectedUrl,
			method: response.status === 303 ? "GET" : args.method,
			body: response.status === 303 ? undefined : args.body,
			redirectsRemaining: args.redirectsRemaining - 1,
		});
	}
	return response;
}

function rawHttpRequest(args: {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
}): Promise<{ url: string; status: number; headers: Record<string, string>; body: string }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(args.url);
		const transport = parsed.protocol === "https:" ? https : http;
		const request = transport.request(
			parsed,
			{
				method: args.method,
				headers: args.headers,
				timeout: args.timeoutMs,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
				response.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [key, value] of Object.entries(response.headers)) {
						if (Array.isArray(value)) headers[key] = value.join(", ");
						else if (value != null) headers[key] = String(value);
					}
					resolve({
						url: args.url,
						status: response.statusCode ?? 0,
						headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		request.on("timeout", () => request.destroy(new Error(`Request timed out after ${args.timeoutMs}ms`)));
		request.on("error", reject);
		if (args.body != null) request.write(args.body);
		request.end();
	});
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const appOpenApp = defineTool({
	name: "app_open",
	label: "App Open",
	description: "Open the app at a relative path or approved absolute URL.",
	promptSnippet: "app_open to navigate to the app under test",
	promptGuidelines: [
		"Use app_open, app_click, app_type_text etc. for authenticated app testing against the configured base URL.",
		"Use app_api_request for direct HTTP API calls to app endpoints.",
	],
	parameters: Type.Object({
		url_or_path: Type.String({ description: 'Relative path (e.g. "/") or absolute URL', default: "/" }),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.openUrl(resolveAppUrl(params.url_or_path ?? "/")));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appOpenTab = defineTool({
	name: "app_open_tab",
	label: "App Open Tab",
	description: "Open a new tab, optionally navigating to an approved app URL.",
	promptSnippet: "app_open_tab to open a new tab in the app browser",
	parameters: Type.Object({
		url_or_path: Type.Optional(Type.String({ description: "Relative path or approved URL" })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const url = params.url_or_path ? resolveAppUrl(params.url_or_path) : undefined;
		const result = await runtime.run(() => runtime.newTab(url));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appListTabs = defineTool({
	name: "app_list_tabs",
	label: "App List Tabs",
	description: "List open tabs in the persistent app-testing browser context.",
	promptSnippet: "app_list_tabs to list app browser tabs",
	parameters: Type.Object({}),
	async execute(_id, _params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.listTabs());
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: { tabs: result } };
	},
});

const appSwitchTab = defineTool({
	name: "app_switch_tab",
	label: "App Switch Tab",
	description: "Switch the active tab by index.",
	promptSnippet: "app_switch_tab to switch app browser tab",
	parameters: Type.Object({
		tab_index: Type.Number({ description: "Tab index to switch to" }),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.setActiveTab(params.tab_index));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appCloseTab = defineTool({
	name: "app_close_tab",
	label: "App Close Tab",
	description: "Close a tab by index. Defaults to the active tab.",
	promptSnippet: "app_close_tab to close an app browser tab",
	parameters: Type.Object({
		tab_index: Type.Optional(Type.Number({ description: "Tab index to close" })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.closeTab(params.tab_index));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appClick = defineTool({
	name: "app_click",
	label: "App Click",
	description: "Click the first element matching a Playwright selector.",
	promptSnippet: "app_click to click an element in the app",
	parameters: Type.Object({
		selector: Type.String({ description: "Playwright CSS selector" }),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.click(params.selector));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appTypeText = defineTool({
	name: "app_type_text",
	label: "App Type Text",
	description: "Fill an input or textarea matched by selector.",
	promptSnippet: "app_type_text to type into an app input",
	parameters: Type.Object({
		selector: Type.String({ description: "Playwright CSS selector" }),
		text: Type.String({ description: "Text to type" }),
		clear: Type.Optional(Type.Boolean({ description: "Clear field first", default: true })),
		submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing", default: false })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.typeText(params.selector, params.text, params.clear ?? true, params.submit ?? false));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appWaitFor = defineTool({
	name: "app_wait_for",
	label: "App Wait For",
	description: "Wait for a selector, URL fragment, or page idle state.",
	promptSnippet: "app_wait_for to wait for an app condition",
	parameters: Type.Object({
		selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
		url_contains: Type.Optional(Type.String({ description: "URL fragment to wait for" })),
		state: Type.Optional(
			StringEnum(["visible", "hidden", "attached", "detached"] as const, {
				description: "Element state",
				default: "visible",
			}),
		),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms", default: 15000 })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.waitFor(params.selector, params.url_contains, params.state ?? "visible", params.timeout_ms ?? 15_000));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appExtractText = defineTool({
	name: "app_extract_text",
	label: "App Extract Text",
	description: "Extract visible text from the page or a specific selector.",
	promptSnippet: "app_extract_text to read text from the app page",
	parameters: Type.Object({
		selector: Type.Optional(Type.String({ description: "CSS selector, defaults to entire page" })),
		max_chars: Type.Optional(Type.Number({ description: "Max characters", default: 8000 })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.extractText(params.selector, params.max_chars ?? 8_000));
		const text = jsonText(result);
		const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		let output = truncation.content;
		if (truncation.truncated) {
			output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
		}
		return { content: [{ type: "text" as const, text: output }], details: { ...result, truncated: truncation.truncated } };
	},
});

const appEvaluate = defineTool({
	name: "app_evaluate",
	label: "App Evaluate",
	description: "Evaluate a JavaScript expression or function in the active app page and return a JSON-serializable result.",
	promptSnippet: "app_evaluate to inspect the active app page with JavaScript, such as computed styles, DOM state, and client-side data",
	parameters: Type.Object({
		script: Type.String({ description: "JavaScript expression, IIFE, or function expression. If it evaluates to a function, it is called with arg." }),
		arg: Type.Optional(Type.Unknown({ description: "Optional JSON-serializable argument passed to a function expression." })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.evaluate(params.script, params.arg));
		const text = jsonText(result);
		const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		let output = truncation.content;
		if (truncation.truncated) {
			output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
		}
		return { content: [{ type: "text" as const, text: output }], details: { ...result, truncated: truncation.truncated } };
	},
});

const appScreenshot = defineTool({
	name: "app_screenshot",
	label: "App Screenshot",
	description: "Capture a screenshot into the app-testing artifact directory.",
	promptSnippet: "app_screenshot to take an app screenshot",
	parameters: Type.Object({
		label: Type.Optional(Type.String({ description: "Label for the screenshot filename" })),
		full_page: Type.Optional(Type.Boolean({ description: "Capture full page", default: true })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.screenshot(params.label, params.full_page ?? true));
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appConsoleLogs = defineTool({
	name: "app_console_logs",
	label: "App Console Logs",
	description: "Return recent browser console events.",
	promptSnippet: "app_console_logs to get app console output",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Max entries", default: 50 })),
		level: Type.Optional(
			StringEnum(["log", "warn", "error", "info", "debug"] as const, { description: "Filter by level" }),
		),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = runtime.getConsoleLogs(params.limit ?? 50, params.level);
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: { logs: result } };
	},
});

const appNetworkLog = defineTool({
	name: "app_network_log",
	label: "App Network Log",
	description: "Return recent request and response events seen by the browser.",
	promptSnippet: "app_network_log to inspect app network traffic",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Max entries", default: 50 })),
		status_min: Type.Optional(Type.Number({ description: "Filter by minimum HTTP status code" })),
		url_contains: Type.Optional(Type.String({ description: "Filter by URL substring" })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = runtime.getNetworkLog(params.limit ?? 50, params.status_min, params.url_contains);
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: { entries: result } };
	},
});

const appApiRequest = defineTool({
	name: "app_api_request",
	label: "App API Request",
	description: "Send an HTTP request to an approved app endpoint.",
	promptSnippet: "app_api_request to make HTTP calls to the app API",
	parameters: Type.Object({
		method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const, {
			description: "HTTP method",
		}),
		url_or_path: Type.String({ description: "Relative path or approved absolute URL" }),
		headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers" })),
		body: Type.Optional(Type.String({ description: "Request body" })),
		timeout_seconds: Type.Optional(Type.Number({ description: "Timeout in seconds", default: 30 })),
		max_body_chars: Type.Optional(Type.Number({ description: "Max response body chars", default: 12000 })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const result = await apiRequest(params);
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

const appPageState = defineTool({
	name: "app_page_state",
	label: "App Page State",
	description: "Return the active tab URL, title, current tab list, and allowed hosts.",
	promptSnippet: "app_page_state to get current app browser state",
	parameters: Type.Object({}),
	async execute(_id, _params, signal) {
		abortIfNeeded(signal);
		const result = await runtime.run(() => runtime.pageState());
		return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
	},
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(appOpenApp);
	pi.registerTool(appOpenTab);
	pi.registerTool(appListTabs);
	pi.registerTool(appSwitchTab);
	pi.registerTool(appCloseTab);
	pi.registerTool(appClick);
	pi.registerTool(appTypeText);
	pi.registerTool(appWaitFor);
	pi.registerTool(appExtractText);
	pi.registerTool(appEvaluate);
	pi.registerTool(appScreenshot);
	pi.registerTool(appConsoleLogs);
	pi.registerTool(appNetworkLog);
	pi.registerTool(appApiRequest);
	pi.registerTool(appPageState);

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});
}
