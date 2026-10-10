/**
 * App Testing Tools — native pi Playwright tools.
 *
 * One action-based app_inspect tool (mirroring browser_inspect) over a persistent
 * Patchright context for local/private apps. All browser work runs directly in
 * this pi extension; nothing goes through browser-worker.
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
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

const APP_INSPECT_ACTIONS = [
	"open",
	"open_tab",
	"list_tabs",
	"switch_tab",
	"close_tab",
	"click",
	"type",
	"wait",
	"extract_text",
	"evaluate",
	"screenshot",
	"console",
	"network",
	"request",
	"state",
] as const;

type AppInspectParams = {
	action: (typeof APP_INSPECT_ACTIONS)[number];
	url?: string;
	tab_index?: number;
	selector?: string;
	text?: string;
	clear?: boolean;
	submit?: boolean;
	url_contains?: string;
	state?: "visible" | "hidden" | "attached" | "detached";
	timeout_ms?: number;
	max_chars?: number;
	script?: string;
	arg?: unknown;
	label?: string;
	full_page?: boolean;
	limit?: number;
	level?: "log" | "warn" | "error" | "info" | "debug";
	status_min?: number;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
	headers?: Record<string, string>;
	body?: string;
	timeout_seconds?: number;
	max_body_chars?: number;
};

function need<T>(value: T | undefined, name: string, action: string): T {
	if (value === undefined || value === null) throw new Error(`app_inspect action=${action} requires ${name}`);
	return value;
}

function plain(details: unknown): { text: string; details: unknown } {
	return { text: jsonText(details), details };
}

function truncated(result: Record<string, unknown>): { text: string; details: unknown } {
	const truncation = truncateHead(jsonText(result), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	}
	return { text, details: { ...result, truncated: truncation.truncated } };
}

async function runAppInspect(params: AppInspectParams): Promise<{ text: string; details: unknown }> {
	const { action } = params;
	switch (action) {
		case "open":
			return plain(await runtime.run(() => runtime.openUrl(resolveAppUrl(params.url ?? "/"))));
		case "open_tab": {
			const url = params.url ? resolveAppUrl(params.url) : undefined;
			return plain(await runtime.run(() => runtime.newTab(url)));
		}
		case "list_tabs": {
			const tabs = await runtime.run(() => runtime.listTabs());
			return { text: jsonText(tabs), details: { tabs } };
		}
		case "switch_tab": {
			const index = need(params.tab_index, "tab_index", action);
			return plain(await runtime.run(() => runtime.setActiveTab(index)));
		}
		case "close_tab":
			return plain(await runtime.run(() => runtime.closeTab(params.tab_index)));
		case "click": {
			const selector = need(params.selector, "selector", action);
			return plain(await runtime.run(() => runtime.click(selector)));
		}
		case "type": {
			const selector = need(params.selector, "selector", action);
			const text = need(params.text, "text", action);
			return plain(await runtime.run(() => runtime.typeText(selector, text, params.clear ?? true, params.submit ?? false)));
		}
		case "wait":
			return plain(await runtime.run(() =>
				runtime.waitFor(params.selector, params.url_contains, params.state ?? "visible", params.timeout_ms ?? 15_000),
			));
		case "extract_text":
			return truncated(await runtime.run(() => runtime.extractText(params.selector, params.max_chars ?? 8_000)));
		case "evaluate": {
			const script = need(params.script, "script", action);
			return truncated(await runtime.run(() => runtime.evaluate(script, params.arg)));
		}
		case "screenshot":
			return plain(await runtime.run(() => runtime.screenshot(params.label, params.full_page ?? true)));
		case "console": {
			const logs = runtime.getConsoleLogs(params.limit ?? 50, params.level);
			return { text: jsonText(logs), details: { logs } };
		}
		case "network": {
			const entries = runtime.getNetworkLog(params.limit ?? 50, params.status_min, params.url_contains);
			return { text: jsonText(entries), details: { entries } };
		}
		case "request":
			return plain(await apiRequest({
				method: need(params.method, "method", action),
				url_or_path: need(params.url, "url", action),
				headers: params.headers,
				body: params.body,
				timeout_seconds: params.timeout_seconds,
				max_body_chars: params.max_body_chars,
			}));
		case "state":
			return plain(await runtime.run(() => runtime.pageState()));
		default:
			throw new Error(`Unknown app_inspect action: ${String(action)}`);
	}
}

const appInspect = defineTool({
	name: "app_inspect",
	label: "App Inspect",
	description:
		"Operate the persistent, authenticated local/private app-testing browser through one explicit action. " +
		"Relative paths resolve against the configured app base URL; absolute URLs must be on allowed hosts. " +
		"request sends a direct HTTP call to an app endpoint.",
	promptSnippet: "app_inspect to explore, debug, or call the API of a local/private app",
	promptGuidelines: [
		"Use app_inspect to explore or debug local/private apps in the persistent authenticated app browser; use app_test instead for reproducible pass/fail runs in a fresh context.",
		"app_inspect never reaches public sites: use browser_inspect for signed-out public sites and Peekaboo for signed-in ones.",
		"app_inspect action=wait is a page wait, not a process/job wait; use wait_for_ready for managed command readiness or wait_for_jobs for completion.",
	],
	parameters: Type.Object({
		action: StringEnum(APP_INSPECT_ACTIONS, {
			description:
				"open/open_tab: navigate (url); list_tabs/switch_tab/close_tab: tabs (tab_index); click/type: selector (+text, clear, submit); " +
				"wait: selector, url_contains, state; extract_text: selector, max_chars; evaluate: script, arg; screenshot: label, full_page; " +
				"console: limit, level; network: limit, status_min, url_contains; request: method, url, headers, body; state: page/tab state",
		}),
		url: Type.Optional(Type.String({ description: "Relative path or approved absolute URL (open defaults to /)" })),
		tab_index: Type.Optional(Type.Number({ description: "switch_tab/close_tab: tab index (close defaults to active tab)" })),
		selector: Type.Optional(Type.String({ description: "Playwright CSS selector (extract_text defaults to the whole page)" })),
		text: Type.Optional(Type.String({ description: "type: text to fill" })),
		clear: Type.Optional(Type.Boolean({ description: "type: clear field first", default: true })),
		submit: Type.Optional(Type.Boolean({ description: "type: press Enter after typing", default: false })),
		url_contains: Type.Optional(Type.String({ description: "wait: URL fragment to wait for; network: URL substring filter" })),
		state: Type.Optional(
			StringEnum(["visible", "hidden", "attached", "detached"] as const, { description: "wait: element state", default: "visible" }),
		),
		timeout_ms: Type.Optional(Type.Number({ description: "wait: timeout in ms", default: 15000 })),
		max_chars: Type.Optional(Type.Number({ description: "extract_text: max characters", default: 8000 })),
		script: Type.Optional(Type.String({ description: "evaluate: JavaScript expression, IIFE, or function expression (called with arg)" })),
		arg: Type.Optional(Type.Unknown({ description: "evaluate: optional JSON-serializable argument for a function expression" })),
		label: Type.Optional(Type.String({ description: "screenshot: filename label" })),
		full_page: Type.Optional(Type.Boolean({ description: "screenshot: capture full page", default: true })),
		limit: Type.Optional(Type.Number({ description: "console/network: max entries", default: 50 })),
		level: Type.Optional(
			StringEnum(["log", "warn", "error", "info", "debug"] as const, { description: "console: filter by level" }),
		),
		status_min: Type.Optional(Type.Number({ description: "network: minimum HTTP status" })),
		method: Type.Optional(
			StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const, { description: "request: HTTP method" }),
		),
		headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "request: headers" })),
		body: Type.Optional(Type.String({ description: "request: body" })),
		timeout_seconds: Type.Optional(Type.Number({ description: "request: timeout in seconds", default: 30 })),
		max_body_chars: Type.Optional(Type.Number({ description: "request: max response body chars", default: 12000 })),
	}),
	async execute(_id, params, signal) {
		abortIfNeeded(signal);
		const { text, details } = await runAppInspect(params as AppInspectParams);
		return { content: [{ type: "text" as const, text }], details };
	},
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool(appInspect);

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});
}
