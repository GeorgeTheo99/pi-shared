import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function resolveEndpoint(raw: string): string {
  // Keep in sync with bin/pi-browser-check. Reject URL-parser normalization,
  // credentials, redirects, and non-loopback hosts before reading the token.
  if (raw !== raw.trim() || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/mcp$/.test(raw)) {
    throw new Error("BROWSER_WORKER_MCP_URL must be an uncredentialed loopback HTTP URL ending in /mcp with an explicit port");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BROWSER_WORKER_MCP_URL must be a valid loopback MCP URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !url.port ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("BROWSER_WORKER_MCP_URL must be an uncredentialed loopback HTTP URL ending in /mcp");
  }
  return url.href;
}

function endpoint(): string {
  return resolveEndpoint(process.env.BROWSER_WORKER_MCP_URL ?? "http://127.0.0.1:8890/mcp");
}

function token(): string {
  const tokenFile = process.env.BROWSER_WORKER_MCP_TOKEN_FILE ??
    join(homedir(), "srv", "browser-worker", "shared", "tokens", "pi-production");
  let value: string;
  try {
    value = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error("browser-worker token file is missing or unreadable (BROWSER_WORKER_MCP_TOKEN_FILE)");
  }
  if (!value) throw new Error("browser-worker token file is empty");
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error("browser-worker token file must contain a single printable ASCII token");
  return value;
}

async function probe(): Promise<void> {
  const url = endpoint();
  const bearer = token();
  const id = `pi-check-${randomUUID()}`;
  let payload: {
    jsonrpc?: string;
    id?: string;
    result?: { tools?: Array<{ name?: string } | null>; nextCursor?: unknown };
    error?: unknown;
  } | null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) throw new Error("oversized response");
    payload = JSON.parse(body);
  } catch {
    // Do not echo service responses or fetch errors which may contain secrets.
    throw new Error("browser-worker tools/list failed (unavailable, timeout, HTTP/auth failure, redirect, invalid JSON, or oversized response)");
  }
  const tools = payload?.result?.tools;
  const names = Array.isArray(tools) ? tools.map((tool) => tool?.name) : [];
  if (payload?.jsonrpc !== "2.0" || payload.id !== id || "error" in payload ||
      names.length !== 2 || !names.includes("browser_fetch") || !names.includes("browser_inspect") ||
      payload.result?.nextCursor != null) {
    throw new Error("MCP service is not the expected browser-worker (requires exactly browser_fetch and browser_inspect; websearch-shim is separate)");
  }
}

async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `pi-${randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`browser-worker returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    error?: unknown;
  };
  if (payload.error || !payload.result) throw new Error("browser-worker returned an MCP error");
  const text = payload.result.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("browser-worker returned no text content");
  if (payload.result.isError) throw new Error(text);
  return text;
}

const browserFetch = defineTool({
  name: "browser_fetch",
  label: "Browser Fetch",
  description: "Render one public web page in an isolated browser and return its visible text.",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute public HTTP(S) URL", minLength: 1, maxLength: 8192 }),
    max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, default: 20000 })),
    wait_until: Type.Optional(
      StringEnum(["load", "domcontentloaded", "networkidle", "commit"] as const),
    ),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
    include_links: Type.Optional(Type.Boolean({ default: false })),
    include_screenshot: Type.Optional(Type.Boolean({ default: false })),
  }),
  async execute(_id, params, signal) {
    const text = await call("browser_fetch", params, signal);
    return { content: [{ type: "text" as const, text }] };
  },
});

const browserInspect = defineTool({
  name: "browser_inspect",
  label: "Browser Inspect",
  description: "Create or operate a short-lived browser session using one explicit action.",
  parameters: Type.Object({
    action: StringEnum([
      "open",
      "state",
      "close",
      "cleanup_scope",
      "navigate",
      "open_tab",
      "list_tabs",
      "switch_tab",
      "close_tab",
      "extract_text",
      "extract_links",
      "wait",
      "console",
      "screenshot",
      "export_pdf",
      "click",
      "type",
      "evaluate",
    ] as const),
    session_id: Type.Optional(Type.String({ maxLength: 128 })),
    scope_id: Type.Optional(Type.String({ maxLength: 128 })),
    url: Type.Optional(Type.String({ maxLength: 8192 })),
    selector: Type.Optional(Type.String({ maxLength: 2000 })),
    text: Type.Optional(Type.String({ maxLength: 20000 })),
    tab_index: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
    wait_until: Type.Optional(
      StringEnum(["load", "domcontentloaded", "networkidle", "commit"] as const, {
        default: "domcontentloaded",
      }),
    ),
    state: Type.Optional(
      StringEnum(["attached", "detached", "visible", "hidden"] as const, {
        default: "visible",
      }),
    ),
    url_contains: Type.Optional(Type.String({ maxLength: 2000 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, default: 20000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    clear: Type.Optional(Type.Boolean({ default: true })),
    submit: Type.Optional(Type.Boolean({ default: false })),
    full_page: Type.Optional(Type.Boolean({ default: true })),
    format: Type.Optional(StringEnum(["A4", "Letter"] as const, { default: "A4" })),
    landscape: Type.Optional(Type.Boolean({ default: false })),
    print_background: Type.Optional(Type.Boolean({ default: true })),
    script: Type.Optional(Type.String({ maxLength: 20000 })),
    arg: Type.Optional(Type.Any()),
  }),
  async execute(_id, params, signal) {
    const text = await call("browser_inspect", params, signal);
    return { content: [{ type: "text" as const, text }] };
  },
});

export default async function register(pi: ExtensionAPI) {
  // Async factory initialization is awaited by Pi before tools are exposed.
  // Importing this module alone performs no network or token-file access.
  try {
    await probe();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "readiness check failed";
    const message = `Optional public browser tools disabled: ${reason}. ` +
      "Run pi-shared/bin/pi-browser-check; configure BROWSER_WORKER_MCP_URL " +
      "(default http://127.0.0.1:8890/mcp) and BROWSER_WORKER_MCP_TOKEN_FILE " +
      "(default ~/srv/browser-worker/shared/tokens/pi-production) for a separately managed browser-worker. " +
      "Obtain its token from that service's operator; no worker or token is provisioned by Pi. " +
      "See pi-shared/extensions/pi-browser-capture/README.md, then restart Pi or /reload. app_* tools are unaffected.";
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(`WARN: ${message}`);
    });
    return;
  }
  pi.registerTool(browserFetch);
  pi.registerTool(browserInspect);
}
