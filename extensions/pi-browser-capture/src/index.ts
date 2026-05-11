import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const DEFAULT_DIR = path.join(os.homedir(), ".pi", "browser-capture");
const STORAGE_ROOT = expandHome(process.env.BROWSER_MCP_STORAGE_ROOT ?? DEFAULT_DIR);

type WaitState = "attached" | "detached" | "visible" | "hidden";
type LoadState = "load" | "domcontentloaded" | "networkidle" | "commit";
type ConsoleEntry = {
  timestamp: string;
  tab_index: number;
  url: string;
  type: string;
  text: string;
};

type RuntimeOptions = {
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
};

const config = {
  profileDir: expandHome(process.env.BROWSER_MCP_WEB_PROFILE_DIR ?? path.join(STORAGE_ROOT, "profile")),
  artifactDir: expandHome(process.env.BROWSER_MCP_WEB_ARTIFACT_DIR ?? DEFAULT_DIR),
  headless: envFlag("BROWSER_MCP_HEADLESS", true),
  defaultTimeoutMs: envInt("BROWSER_MCP_DEFAULT_TIMEOUT_MS", 15_000),
  viewportWidth: envInt("BROWSER_MCP_VIEWPORT_WIDTH", 1440),
  viewportHeight: envInt("BROWSER_MCP_VIEWPORT_HEIGHT", 900),
  ignoreHttpsErrors: envFlag("BROWSER_MCP_IGNORE_HTTPS_ERRORS", false),
  browserChannel: process.env.BROWSER_MCP_BROWSER_CHANNEL,
  browserExecutablePath: process.env.BROWSER_MCP_BROWSER_EXECUTABLE_PATH,
  userAgent: process.env.BROWSER_MCP_USER_AGENT,
  consoleLogLimit: envInt("BROWSER_MCP_CONSOLE_LOG_LIMIT", 200),
  allowPrivateHosts: envFlag("BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS", false),
};

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

function expandHome(inputPath: string): string {
  return inputPath === "~" || inputPath.startsWith("~/") ? path.join(os.homedir(), inputPath.slice(2)) : inputPath;
}

function normalizeOutputPath(inputPath: string | undefined, defaultName: string, cwd: string) {
  const raw = (inputPath || "").trim();
  if (!raw) return path.join(config.artifactDir, defaultName);
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  return path.isAbsolute(withoutAt) ? withoutAt : path.join(cwd, withoutAt);
}

async function ensureDirFor(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "artifact";
}

function utcNow(): string {
  return new Date().toISOString();
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function validatePublicHost(host: string): void {
  const normalized = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!normalized) throw new Error("URL is missing a hostname");
  if (config.allowPrivateHosts) return;
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    throw new Error("Private hosts are blocked for browser_* tools. Use app_* tools or set BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS=true.");
  }
  const ipVersion = net.isIP(normalized);
  if ((ipVersion === 4 && isPrivateIpv4(normalized)) || (ipVersion === 6 && isPrivateIpv6(normalized))) {
    throw new Error("Private IPs are blocked for browser_* tools. Use app_* tools or set BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS=true.");
  }
}

function resolveExternalUrl(url: string): string {
  const candidate = url.trim();
  if (!candidate) throw new Error("URL cannot be empty");
  if (candidate.startsWith("/") || !candidate.includes("://")) throw new Error("browser_* tools require an absolute URL");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new Error(`Invalid URL '${candidate}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https URLs are supported");
  validatePublicHost(parsed.hostname);
  return parsed.toString();
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cancelled");
}

class BrowserRuntime {
  private context: BrowserContext | null = null;
  private trackedPages = new Set<Page>();
  private activePageIndex = 0;
  private consoleLog: ConsoleEntry[] = [];
  private queue: Promise<void> = Promise.resolve();
  private options: RuntimeOptions = {};

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
    this.activePageIndex = 0;
    if (context) await context.close().catch(() => undefined);
  }

  async reset(options: RuntimeOptions = {}): Promise<void> {
    await this.shutdown();
    this.options = options;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    await fs.mkdir(config.profileDir, { recursive: true });
    await fs.mkdir(config.artifactDir, { recursive: true });

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.options.headless ?? config.headless,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
      viewport: {
        width: this.options.viewportWidth ?? config.viewportWidth,
        height: this.options.viewportHeight ?? config.viewportHeight,
      },
    };
    if (config.browserChannel) launchOptions.channel = config.browserChannel;
    if (config.browserExecutablePath) launchOptions.executablePath = config.browserExecutablePath;
    if (config.userAgent) launchOptions.userAgent = config.userAgent;

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
      this.consoleLog.push({
        timestamp: utcNow(),
        tab_index: this.indexForPage(page),
        url: page.url(),
        type: message.type(),
        text: message.text(),
      });
      if (this.consoleLog.length > config.consoleLogLimit) this.consoleLog.splice(0, this.consoleLog.length - config.consoleLogLimit);
    });
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

  async open(url?: string, options: RuntimeOptions = {}): Promise<Record<string, unknown>> {
    await this.reset(options);
    const page = await this.activePage();
    if (!url) return this.describePage(page);
    const response = await page.goto(resolveExternalUrl(url), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    return this.describePage(page, response);
  }

  async navigate(url: string, waitUntil: LoadState = "domcontentloaded"): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const response = await page.goto(resolveExternalUrl(url), { waitUntil, timeout: 60_000 });
    if (waitUntil !== "networkidle") await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    return this.describePage(page, response);
  }

  async newTab(url?: string): Promise<Record<string, unknown>> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.attachPage(page);
    this.activePageIndex = this.indexForPage(page);
    if (!url) return this.describePage(page);
    const response = await page.goto(resolveExternalUrl(url), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    return this.describePage(page, response);
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
    if (pages.length === 1) throw new Error("Cannot close the final tab. Use browser_close to close the browser session.");
    const targetIndex = tabIndex ?? this.activePageIndex;
    if (targetIndex < 0 || targetIndex >= pages.length) throw new Error(`Invalid tab index ${targetIndex}. Open tabs: 0..${pages.length - 1}`);
    const page = pages[targetIndex];
    const result: Record<string, unknown> = {
      closed_tab_index: targetIndex,
      closed_url: page.url(),
      closed_title: await page.title(),
    };
    await page.close();
    const remaining = await this.pages();
    this.activePageIndex = Math.min(targetIndex, remaining.length - 1);
    result.active_tab = await this.describePage(remaining[this.activePageIndex]);
    return result;
  }

  async click(selector: string, timeoutMs = config.defaultTimeoutMs): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    await page.locator(selector).first().click({ timeout: timeoutMs });
    return this.describePage(page);
  }

  async typeText(selector: string, text: string, clear = true, submit = false, timeoutMs = config.defaultTimeoutMs): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const locator = page.locator(selector).first();
    if (clear) await locator.fill("", { timeout: timeoutMs });
    await locator.fill(text, { timeout: timeoutMs });
    if (submit) await locator.press("Enter", { timeout: timeoutMs });
    return this.describePage(page);
  }

  async waitFor(selector?: string, urlContains?: string, state: WaitState = "visible", timeoutMs = config.defaultTimeoutMs): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    if (selector) await page.waitForSelector(selector, { state, timeout: timeoutMs });
    if (urlContains) {
      const deadline = Date.now() + timeoutMs;
      while (!page.url().includes(urlContains)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for URL containing '${urlContains}'`);
        await page.waitForTimeout(100);
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

  async screenshot(outputPath?: string, label?: string, fullPage = true, cwd = process.cwd()): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
    const title = await page.title() || page.url() || "page";
    const defaultName = `${stamp}-${slug(label ?? title)}.png`;
    const outPath = normalizeOutputPath(outputPath, defaultName, cwd);
    await ensureDirFor(outPath);
    await page.screenshot({ path: outPath, fullPage });
    return {
      ...await this.describePage(page),
      path: outPath,
    };
  }

  async exportPdf(outputPath?: string, format = "A4", landscape = false, printBackground = true, cwd = process.cwd()): Promise<Record<string, unknown>> {
    const page = await this.activePage();
    const outPath = normalizeOutputPath(outputPath, `page-${Date.now()}.pdf`, cwd);
    await ensureDirFor(outPath);
    await page.pdf({ path: outPath, format, landscape, printBackground });
    return {
      ...await this.describePage(page),
      path: outPath,
    };
  }

  getConsoleLogs(limit = 50, level?: string): ConsoleEntry[] {
    const records = level ? this.consoleLog.filter((entry) => entry.type === level) : this.consoleLog;
    return records.slice(-limit);
  }

  async pageState(): Promise<Record<string, unknown>> {
    return {
      active_page: await this.describePage(),
      tabs: await this.listTabs(),
      private_hosts_enabled: config.allowPrivateHosts,
      artifact_dir: config.artifactDir,
      profile_dir: config.profileDir,
    };
  }
}

const runtime = new BrowserRuntime();

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: jsonText(result) }], details: result };
}

function truncatedTextResult(result: Record<string, unknown>) {
  const text = jsonText(result);
  const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  let output = truncation.content;
  if (truncation.truncated) {
    output += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
  }
  return { content: [{ type: "text" as const, text: output }], details: { ...result, truncated: truncation.truncated } };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });

  pi.registerTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a Chromium browser session, optionally navigate to an absolute public URL, and keep it available for later browser tools.",
    promptSnippet: "browser_open to open a browser session for navigation, tabs, screenshots, PDF export, console logs, and page interaction",
    promptGuidelines: [
      "Use browser_* tools for actual browser interaction with public web pages.",
      "Use web_search for informational research and current-facts lookup instead of browsing search result pages manually.",
      "Use app_* tools for local/private app testing; browser_* blocks private hosts unless BROWSER_MCP_WEB_ALLOW_PRIVATE_HOSTS=true.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Optional absolute public URL to open immediately" })),
      headless: Type.Optional(Type.Boolean({ description: "Run headless browser. Defaults to BROWSER_MCP_HEADLESS or true." })),
      viewportWidth: Type.Optional(Type.Number({ description: "Viewport width in pixels. Defaults to 1440." })),
      viewportHeight: Type.Optional(Type.Number({ description: "Viewport height in pixels. Defaults to 900." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.open(params.url, {
        headless: params.headless,
        viewportWidth: params.viewportWidth,
        viewportHeight: params.viewportHeight,
      }));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the active browser tab to an absolute public URL.",
    promptSnippet: "browser_navigate to navigate the active browser tab",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute public URL to navigate to" }),
      waitUntil: Type.Optional(Type.String({ description: "Load state: load, domcontentloaded, networkidle, or commit. Defaults to domcontentloaded." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const waitUntil = (params.waitUntil as LoadState | undefined) ?? "domcontentloaded";
      const result = await runtime.run(() => runtime.navigate(params.url, waitUntil));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_open_tab",
    label: "Browser Open Tab",
    description: "Open a new browser tab, optionally navigating to an absolute public URL.",
    promptSnippet: "browser_open_tab to open a new browser tab",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Optional absolute public URL to open" })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.newTab(params.url));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_list_tabs",
    label: "Browser List Tabs",
    description: "List open browser tabs.",
    promptSnippet: "browser_list_tabs to list browser tabs",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      abortIfNeeded(signal);
      const tabs = await runtime.run(() => runtime.listTabs());
      return { content: [{ type: "text" as const, text: jsonText(tabs) }], details: { tabs } };
    },
  });

  pi.registerTool({
    name: "browser_switch_tab",
    label: "Browser Switch Tab",
    description: "Switch the active browser tab by index.",
    promptSnippet: "browser_switch_tab to switch the active browser tab",
    parameters: Type.Object({
      tab_index: Type.Number({ description: "Tab index to switch to" }),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.setActiveTab(params.tab_index));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_close_tab",
    label: "Browser Close Tab",
    description: "Close a browser tab by index. Defaults to the active tab.",
    promptSnippet: "browser_close_tab to close a browser tab",
    parameters: Type.Object({
      tab_index: Type.Optional(Type.Number({ description: "Tab index to close" })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.closeTab(params.tab_index));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click the first element matching a Playwright selector in the active browser tab.",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright CSS selector" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 15000." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.click(params.selector, params.timeoutMs ?? config.defaultTimeoutMs));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Fill an input or textarea matched by selector in the active browser tab.",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright CSS selector" }),
      text: Type.String({ description: "Text to type" }),
      clear: Type.Optional(Type.Boolean({ description: "Clear field first. Defaults to true." })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing. Defaults to false." })),
      pressEnter: Type.Optional(Type.Boolean({ description: "Alias for submit." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 15000." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const submit = params.submit ?? params.pressEnter ?? false;
      const result = await runtime.run(() => runtime.typeText(params.selector, params.text, params.clear ?? true, submit, params.timeoutMs ?? config.defaultTimeoutMs));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description: "Wait for a selector, URL fragment, or page idle state in the active browser tab.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
      urlContains: Type.Optional(Type.String({ description: "URL fragment to wait for" })),
      state: Type.Optional(Type.String({ description: "Element state: attached, detached, visible, or hidden. Defaults to visible." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout or sleep duration in milliseconds. Defaults to 15000." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.waitFor(params.selector, params.urlContains, (params.state as WaitState | undefined) ?? "visible", params.timeoutMs ?? config.defaultTimeoutMs));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_extract_text",
    label: "Browser Extract Text",
    description: "Extract visible text from the active browser page or a specific selector.",
    promptSnippet: "browser_extract_text to read visible text from the browser page",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector, defaults to the page body" })),
      max_chars: Type.Optional(Type.Number({ description: "Maximum characters before truncation. Defaults to 8000." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.extractText(params.selector, params.max_chars ?? 8_000));
      return truncatedTextResult(result);
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the active browser tab and save it to disk.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output image path. Defaults under ~/.pi/browser-capture/." })),
      label: Type.Optional(Type.String({ description: "Label for the generated screenshot filename when path is omitted." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture full page. Defaults to true." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.screenshot(params.path, params.label, params.fullPage ?? true, ctx.cwd));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_export_pdf",
    label: "Browser Export PDF",
    description: "Export the active browser tab to PDF and save it to disk.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output PDF path. Defaults under ~/.pi/browser-capture/." })),
      format: Type.Optional(Type.String({ description: "Page format such as A4 or Letter. Defaults to A4." })),
      landscape: Type.Optional(Type.Boolean({ description: "Render in landscape orientation." })),
      printBackground: Type.Optional(Type.Boolean({ description: "Print CSS backgrounds. Defaults to true." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.exportPdf(params.path, params.format ?? "A4", params.landscape ?? false, params.printBackground ?? true, ctx.cwd));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_console_logs",
    label: "Browser Console Logs",
    description: "Return recent browser console events.",
    promptSnippet: "browser_console_logs to inspect recent browser console output",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries. Defaults to 50." })),
      level: Type.Optional(Type.String({ description: "Filter by level: log, warn, error, info, or debug." })),
    }),
    async execute(_id, params, signal) {
      abortIfNeeded(signal);
      const logs = runtime.getConsoleLogs(params.limit ?? 50, params.level);
      return { content: [{ type: "text" as const, text: jsonText(logs) }], details: { logs } };
    },
  });

  pi.registerTool({
    name: "browser_page_state",
    label: "Browser Page State",
    description: "Return the active browser tab URL, title, tab list, and browser configuration info.",
    promptSnippet: "browser_page_state to inspect current browser state",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      abortIfNeeded(signal);
      const result = await runtime.run(() => runtime.pageState());
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the active browser session.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      abortIfNeeded(signal);
      await runtime.run(() => runtime.shutdown());
      return { content: [{ type: "text" as const, text: "Closed browser session." }], details: {} };
    },
  });

}
