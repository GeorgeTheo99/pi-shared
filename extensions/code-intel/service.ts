import { constants } from "node:fs";
import { access, open, opendir, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IntelError, LspClient } from "./client.ts";

export type Action = "status" | "definition" | "references" | "hover" | "diagnostics";
export type Query = { action: Action; path?: string; line?: number; column?: number };
type Config = { version: 1; adapter: "typescript-language-server"; workspace: string; executable: string; args: string[]; timeoutMs: number; tsserverPath?: string };
type Snapshot = { files: Map<string, string>; digest: string };
const MAX_FILE = 1024 * 1024;
const MAX_RESULT = 48 * 1024;
const sourcePattern = /\.(?:[cm]?[jt]sx?|json)$/i;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new IntelError("canceled", "Code intelligence canceled"); };

async function readBounded(path: string, max = MAX_FILE) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new IntelError("invalid_path", "Expected a regular file");
    if (info.size > max) throw new IntelError("source_limit", `File exceeds ${max} bytes: ${path}`);
    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > max) throw new IntelError("source_limit", `File exceeds ${max} bytes: ${path}`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)); }
    catch { throw new IntelError("invalid_source", `Invalid UTF-8: ${path}`); }
  } finally { await handle.close(); }
}

async function loadConfig(cwd: string, trusted: boolean) {
  if (!trusted) throw new IntelError("untrusted_project", "Trust this project in Pi before reading .pi/code-intel.json");
  const project = await realpath(cwd);
  const configPath = join(project, ".pi", "code-intel.json");
  let config: Config;
  let configText: string;
  try {
    const canonical = await realpath(configPath);
    if (!inside(project, canonical)) throw new IntelError("outside_workspace", "Configuration must remain inside the project");
    configText = await readBounded(canonical, 16384);
    config = JSON.parse(configText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new IntelError("not_configured", "Create trusted .pi/code-intel.json; no server was started");
    if (error instanceof SyntaxError) throw new IntelError("invalid_config", "Invalid code-intel JSON");
    throw error;
  }
  if (!config || config.version !== 1 || config.adapter !== "typescript-language-server" ||
      typeof config.workspace !== "string" || !config.workspace || typeof config.executable !== "string" || !isAbsolute(config.executable) ||
      !Array.isArray(config.args) || config.args.length > 32 || config.args.some(a => typeof a !== "string" || a.length > 4096) ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000 ||
      (config.tsserverPath !== undefined && (typeof config.tsserverPath !== "string" || !isAbsolute(config.tsserverPath))))
    throw new IntelError("invalid_config", "Expected version 1, typescript-language-server adapter, workspace, absolute executable, args, and timeoutMs (1000–60000)");
  if (["npx", "npm", "yarn", "pnpm", "bun", "bunx"].includes(basename(config.executable)))
    throw new IntelError("invalid_config", "Configure an installed server executable, not a package runner");
  const root = await realpath(resolve(project, config.workspace));
  if (!inside(project, root) || !(await stat(root)).isDirectory()) throw new IntelError("outside_workspace", "Workspace must be a directory inside the current project");
  try {
    await access(config.executable, constants.X_OK);
    if (!(await stat(config.executable)).isFile()) throw new Error("Not a file");
    if (config.tsserverPath) {
      await access(config.tsserverPath, constants.R_OK);
      if (!(await stat(config.tsserverPath)).isFile()) throw new Error("Invalid tsserverPath");
    }
  } catch { throw new IntelError("missing_executable", "Configured server/tsserver path is missing or inaccessible"); }
  return { config, root, configPath, configDigest: digest(configText) };
}

/** Explicitly bounded source scope; dependencies and external project references are not fingerprinted. */
async function snapshot(root: string, signal?: AbortSignal): Promise<Snapshot> {
  const files = new Map<string, string>();
  let total = 0, entries = 0;
  const visit = async (dir: string) => {
    check(signal);
    // opendir avoids allocating an unbounded directory listing.
    const directory = await opendir(dir);
    for await (const item of directory) {
      check(signal);
      if (++entries > 20000) throw new IntelError("source_limit", "Workspace exceeds 20000 entries");
      if (["node_modules", ".git"].includes(item.name)) continue;
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) throw new IntelError("unsupported_symlink", `Workspace symlinks are not fingerprinted: ${path}`);
      if (item.isDirectory()) await visit(path);
      else if (sourcePattern.test(item.name)) {
        const text = await readBounded(path);
        total += Buffer.byteLength(text);
        if (files.size >= 4096 || total > 32 * 1024 * 1024) throw new IntelError("source_limit", "Workspace exceeds 4096 source files or 32 MiB");
        files.set(path, text);
      }
    }
  };
  await visit(root);
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) hash.update(JSON.stringify([relative(root, path), digest(files.get(path)!)]));
  return { files, digest: hash.digest("hex") };
}

const lines = (text: string) => text.split(/\r\n|\r|\n/);
export function toLspPosition(text: string, line: number, column: number, encoding: string) {
  const row = lines(text)[line - 1];
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || row === undefined || column > [...row].length + 1)
    throw new IntelError("invalid_position", "Coordinates must be valid 1-based Unicode code-point positions");
  const prefix = [...row].slice(0, column - 1).join("");
  return { line: line - 1, character: encoding === "utf-8" ? Buffer.byteLength(prefix) : encoding === "utf-32" ? [...prefix].length : prefix.length };
}
export function fromLspPosition(text: string, position: any, encoding: string) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0)
    throw new IntelError("protocol_error", "Invalid result position");
  const row = lines(text)[position.line];
  if (row === undefined) throw new IntelError("protocol_error", "Result line is outside synchronized source");
  let units = 0, column = 1;
  for (const point of row) {
    if (units === position.character) return { line: position.line + 1, column };
    units += encoding === "utf-8" ? Buffer.byteLength(point) : encoding === "utf-32" ? 1 : point.length;
    column++;
  }
  if (units !== position.character) throw new IntelError("protocol_error", "Result column is outside source or splits a Unicode code point");
  return { line: position.line + 1, column };
}
function range(text: string, value: any, encoding: string) {
  const start = fromLspPosition(text, value?.start, encoding), end = fromLspPosition(text, value?.end, encoding);
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) throw new IntelError("protocol_error", "Reversed result range");
  return { start, end };
}

async function locations(raw: any, before: Snapshot, root: string, encoding: string) {
  if (raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length > 1000) throw new IntelError("result_limit", "More than 1000 locations; narrow the query");
  return Promise.all(items.map(async item => {
    const uri = item?.targetUri ?? item?.uri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) throw new IntelError("protocol_error", "Non-file location returned");
    const path = await realpath(fileURLToPath(uri));
    if (!inside(root, path) || !before.files.has(path)) throw new IntelError("outside_workspace", "Result targets source outside the fingerprinted workspace (including dependencies)");
    const text = before.files.get(path)!;
    return { path, range: range(text, item.targetSelectionRange ?? item.range, encoding), digest: digest(text) };
  }));
}

async function diagnostics(client: LspClient, uri: string, text: string, signal: AbortSignal) {
  // TLS publishDiagnostics omits document versions and may publish partial batches.
  // Use only this adapter's read-only, synchronous syntax/semantic commands instead.
  if (!client.capabilities.executeCommandProvider?.commands?.includes("typescript.tsserverRequest"))
    throw new IntelError("unsupported_method", "Current diagnostics require typescript.tsserverRequest (TLS 4.4+); unversioned push diagnostics are not freshness evidence");
  const output: any[] = [];
  for (const command of ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"]) {
    const response = await client.request("workspace/executeCommand", {
      command: "typescript.tsserverRequest", arguments: [command, { file: uri, includeLinePosition: true }, { expectsResult: true, isAsync: false, executionTarget: 0 }],
    }, signal);
    if (response?.type !== "response" || response.success !== true || !Array.isArray(response.body))
      throw new IntelError("incomplete_diagnostics", "Missing successful synchronous diagnostic response");
    for (const item of response.body) {
      if (output.length >= 1000) throw new IntelError("result_limit", "More than 1000 diagnostics");
      if (typeof item.message !== "string" || !item.startLocation || !item.endLocation)
        throw new IntelError("incomplete_diagnostics", "Malformed synchronous diagnostic");
      output.push({ message: item.message, code: item.code, category: item.category,
        range: range(text, { start: { line: item.startLocation.line - 1, character: item.startLocation.offset - 1 }, end: { line: item.endLocation.line - 1, character: item.endLocation.offset - 1 } }, "utf-16") });
    }
  }
  return { items: output, scope: "requested file; syntax and semantic only (not suggestions or project-wide diagnostics)", method: "typescript.tsserverRequest: synchronous syntax + semantic" };
}

export class CodeIntelService {
  private active?: { client?: LspClient; abort: AbortController };
  async close() { this.active?.abort.abort(); return this.active?.client?.close(); }

  async run(cwd: string, trusted: boolean, query: Query, signal?: AbortSignal) {
    if (this.active) throw new IntelError("busy", "A code_intel operation is already running");
    const operation = { abort: new AbortController(), client: undefined as LspClient | undefined };
    this.active = operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abort = () => operation.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      check(operation.abort.signal);
      const { config, root, configPath, configDigest } = await loadConfig(cwd, trusted);
      check(operation.abort.signal);
      if (!["status", "definition", "references", "hover", "diagnostics"].includes(query.action)) throw new IntelError("invalid_action", "Unsupported read-only action");
      if (query.action === "status") return { schemaVersion: 1, action: "status", status: "configured", workspace: root, configDigest,
        server: { adapter: config.adapter, executable: config.executable }, executableAccessible: true, execution: "not_started", freshness: "not_checked" };
      timer = setTimeout(() => { timedOut = true; abort(); }, config.timeoutMs);
      if (typeof query.path !== "string" || !query.path) throw new IntelError("invalid_path", "path is required");
      const path = await realpath(resolve(root, query.path));
      if (!inside(root, path) || !/\.[cm]?[jt]sx?$/i.test(path)) throw new IntelError("outside_workspace", "Expected a TS/JS file inside the configured workspace");
      const before = await snapshot(root, operation.abort.signal);
      const text = before.files.get(path);
      if (text === undefined) throw new IntelError("outside_workspace", "Requested source is excluded from the workspace snapshot");
      // Validate before starting any process.
      if (query.action !== "diagnostics") toLspPosition(text, query.line!, query.column!, "utf-16");
      check(operation.abort.signal);
      const client = operation.client = new LspClient(config.executable, config.args, root);
      const instanceId = randomUUID();
      // TLS's auto syntax server can answer before semantic project loading, returning
      // an import alias rather than its cross-file definition. Always use semantic routing.
      await client.initialize(pathToFileURL(root).href, { tsserver: { useSyntaxServer: "never", ...(config.tsserverPath ? { path: config.tsserverPath } : {}) } }, operation.abort.signal);
      const uri = pathToFileURL(path).href;
      const languageId = /\.[cm]?tsx?$/i.test(path) ? (extname(path) === ".tsx" ? "typescriptreact" : "typescript") : (extname(path) === ".jsx" ? "javascriptreact" : "javascript");
      const version = client.sync(uri, languageId, text);
      let result: unknown;
      if (query.action === "diagnostics") result = await diagnostics(client, uri, text, operation.abort.signal);
      else {
        if (!client.capabilities[`${query.action}Provider`]) throw new IntelError("unsupported_method", `Server does not advertise ${query.action}`);
        const raw = await client.request(`textDocument/${query.action}`, { textDocument: { uri },
          position: toLspPosition(text, query.line!, query.column!, client.encoding),
          ...(query.action === "references" ? { context: { includeDeclaration: true } } : {}) }, operation.abort.signal);
        if (query.action === "hover") {
          if (raw !== null && (!raw || !("contents" in raw))) throw new IntelError("protocol_error", "Malformed hover response");
          result = raw === null ? null : { contents: raw.contents, ...(raw.range ? { range: range(text, raw.range, client.encoding) } : {}) };
        } else result = await locations(raw, before, root, client.encoding);
      }
      const after = await snapshot(root, operation.abort.signal);
      if (before.digest !== after.digest || digest(await readBounded(configPath, 16384)) !== configDigest)
        throw new IntelError("stale_source", "Workspace/configuration changed during query; result discarded, retry");
      check(operation.abort.signal);
      const details = { schemaVersion: 1, action: query.action, status: "ok", workspace: root, configDigest,
        server: { adapter: config.adapter, executable: config.executable, reported: client.serverInfo, instanceId, positionEncoding: client.encoding },
        document: { path, uri, version, digest: digest(text) },
        sourceIdentity: { status: "matched_before_after", digest: before.digest, files: before.files.size,
          scope: "TS/JS/JSON files under workspace, excluding node_modules and .git; external dependencies, toolchain, and editor-only buffers are not fingerprinted; not an atomic snapshot" },
        result };
      if (Buffer.byteLength(JSON.stringify(details)) > MAX_RESULT) throw new IntelError("result_limit", "Result exceeds 48 KiB; narrow the query");
      clearTimeout(timer);
      const cleanup = await client.close();
      if (!cleanup.serverExited) throw new IntelError("cleanup_incomplete", "Language server exit was not confirmed");
      check(operation.abort.signal);
      return { ...details, cleanup };
    } catch (error) {
      if (timedOut) throw new IntelError("timeout", "Code intelligence exceeded configured deadline");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await operation.client?.close();
      this.active = undefined;
    }
  }
}
