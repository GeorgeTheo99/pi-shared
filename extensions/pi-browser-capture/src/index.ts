import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_DIR = path.join(os.homedir(), ".pi", "browser-capture");

type BrowserState = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

let state: BrowserState | null = null;

function normalizePath(inputPath: string | undefined, defaultName: string, cwd: string) {
  const raw = (inputPath || "").trim();
  if (!raw) return path.join(DEFAULT_DIR, defaultName);
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  return path.isAbsolute(withoutAt)
    ? withoutAt
    : path.join(cwd, withoutAt);
}

async function ensureDirFor(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureState() {
  if (!state) throw new Error("Browser is not open. Call browser_open first.");
  if (state.page.isClosed()) throw new Error("Browser page is closed. Call browser_open first.");
  return state;
}

async function closeState() {
  if (!state) return;
  try {
    await state.context.close();
  } catch {}
  try {
    await state.browser.close();
  } catch {}
  state = null;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await closeState();
  });

  pi.registerTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a Chromium browser page, optionally navigate to a URL, and keep it available for later browser tools.",
    promptSnippet: "Open a browser session for navigation, screenshots, exports, and page interaction.",
    promptGuidelines: [
      "Use browser_open before using browser_navigate, browser_click, browser_type, browser_screenshot, or browser_export_pdf.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Optional URL to open immediately" })),
      headless: Type.Optional(Type.Boolean({ description: "Run headless browser. Defaults to true." })),
      viewportWidth: Type.Optional(Type.Number({ description: "Viewport width in pixels. Defaults to 1440." })),
      viewportHeight: Type.Optional(Type.Number({ description: "Viewport height in pixels. Defaults to 900." })),
    }),
    async execute(_id, params, signal) {
      await closeState();
      const browser = await chromium.launch({ headless: params.headless ?? true });
      const context = await browser.newContext({
        viewport: {
          width: params.viewportWidth ?? 1440,
          height: params.viewportHeight ?? 900,
        },
      });
      const page = await context.newPage();
      state = { browser, context, page };
      if (params.url) {
        await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
      if (signal) signal.addEventListener("abort", () => void closeState(), { once: true });
      return {
        content: [{ type: "text", text: `Browser ready${params.url ? ` at ${page.url()}` : ""}.` }],
        details: { url: page.url() || params.url || null },
      };
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the open browser page to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      waitUntil: Type.Optional(Type.String({ description: 'Load state to wait for: load, domcontentloaded, networkidle, or commit. Defaults to domcontentloaded.' })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      const waitUntil = (params.waitUntil as "load" | "domcontentloaded" | "networkidle" | "commit" | undefined) ?? "domcontentloaded";
      await page.goto(params.url, { waitUntil, timeout: 60000 });
      if (waitUntil !== "networkidle") {
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
      return {
        content: [{ type: "text", text: `Navigated to ${page.url()}` }],
        details: { url: page.url() },
      };
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element on the open page using a Playwright selector.",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector to click" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 15000." })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      await page.click(params.selector, { timeout: params.timeoutMs ?? 15000 });
      return {
        content: [{ type: "text", text: `Clicked ${params.selector}` }],
        details: { url: page.url(), selector: params.selector },
      };
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Fill or type text into an element on the open page using a Playwright selector.",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector to fill" }),
      text: Type.String({ description: "Text to enter" }),
      pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 15000." })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      await page.fill(params.selector, params.text, { timeout: params.timeoutMs ?? 15000 });
      if (params.pressEnter) {
        await page.press(params.selector, "Enter", { timeout: params.timeoutMs ?? 15000 });
      }
      return {
        content: [{ type: "text", text: `Entered text into ${params.selector}` }],
        details: { url: page.url(), selector: params.selector },
      };
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description: "Wait for a selector to appear, or wait for a fixed timeout on the open page.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Optional selector to wait for" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout or sleep duration in milliseconds. Defaults to 5000." })),
      state: Type.Optional(Type.String({ description: 'Selector state: attached, detached, visible, or hidden. Defaults to visible.' })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      const timeoutMs = params.timeoutMs ?? 5000;
      if (params.selector) {
        const waitState = (params.state as "attached" | "detached" | "visible" | "hidden" | undefined) ?? "visible";
        await page.waitForSelector(params.selector, { timeout: timeoutMs, state: waitState });
        return {
          content: [{ type: "text", text: `Selector ready: ${params.selector}` }],
          details: { url: page.url(), selector: params.selector, state: waitState },
        };
      }
      await page.waitForTimeout(timeoutMs);
      return {
        content: [{ type: "text", text: `Waited ${timeoutMs}ms` }],
        details: { url: page.url(), waitedMs: timeoutMs },
      };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page and save it to disk.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output image path. Defaults under ~/.pi/browser-capture/." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture full page. Defaults to true." })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      const outPath = normalizePath(params.path, `screenshot-${Date.now()}.png`, process.cwd());
      await ensureDirFor(outPath);
      await page.screenshot({ path: outPath, fullPage: params.fullPage ?? true });
      return {
        content: [{ type: "text", text: `Saved screenshot to ${outPath}` }],
        details: { path: outPath, url: page.url() },
      };
    },
  });

  pi.registerTool({
    name: "browser_export_pdf",
    label: "Browser Export PDF",
    description: "Export the current page to PDF and save it to disk.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output PDF path. Defaults under ~/.pi/browser-capture/." })),
      format: Type.Optional(Type.String({ description: "Page format such as A4 or Letter. Defaults to A4." })),
      landscape: Type.Optional(Type.Boolean({ description: "Render in landscape orientation." })),
      printBackground: Type.Optional(Type.Boolean({ description: "Print CSS backgrounds. Defaults to true." })),
    }),
    async execute(_id, params) {
      const { page } = await ensureState();
      const outPath = normalizePath(params.path, `page-${Date.now()}.pdf`, process.cwd());
      await ensureDirFor(outPath);
      await page.pdf({
        path: outPath,
        format: params.format ?? "A4",
        landscape: params.landscape ?? false,
        printBackground: params.printBackground ?? true,
      });
      return {
        content: [{ type: "text", text: `Saved PDF to ${outPath}` }],
        details: { path: outPath, url: page.url() },
      };
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the active browser session.",
    parameters: Type.Object({}),
    async execute() {
      await closeState();
      return {
        content: [{ type: "text", text: "Closed browser session." }],
        details: {},
      };
    },
  });
}
