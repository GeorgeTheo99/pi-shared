import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class IntelError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_HEADER = 8192;
const MAX_TRAFFIC = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void };

/** One bounded stdio connection. Server requests cannot cause edits or command execution. */
export class LspClient {
  readonly process: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private expected: number | undefined;
  private traffic = 0;
  private messages = 0;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private failure?: Error;
  private closing?: Promise<{ serverExited: boolean; descendants: "unverified" }>;
  private exited = false;
  private exitPromise: Promise<void>;
  stderrBytes = 0;
  serverInfo: unknown;
  capabilities: any;
  encoding: "utf-8" | "utf-16" | "utf-32" = "utf-16";
  private documents = new Map<string, { text: string; version: number }>();

  constructor(executable: string, args: string[], cwd: string) {
    this.process = spawn(executable, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: "pipe" });
    this.exitPromise = new Promise(resolve => {
      this.process.once("error", error => {
        this.exited = true;
        this.fail(new IntelError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_executable" : "startup_failed", error.message));
        resolve();
      });
      this.process.once("exit", (code, signal) => {
        this.exited = true;
        this.fail(new IntelError("server_exited", `Language server exited (${code ?? signal})`));
        resolve();
      });
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.process.stdout.on("end", () => this.fail(new IntelError("transport_closed", "Language server closed stdout")));
    this.process.stdin.on("error", error => this.fail(new IntelError("transport_error", error.message)));
    this.process.stdout.on("error", error => this.fail(new IntelError("transport_error", error.message)));
    this.process.stderr.on("error", () => {});
    // Always drain; retain no potentially sensitive server logs.
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderrBytes += chunk.length; });
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const item of this.pending.values()) { item.cleanup(); item.reject(this.failure); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }

  private receive(chunk: Buffer) {
    if (this.failure) return;
    try {
      this.traffic += chunk.length;
      if (this.traffic > MAX_TRAFFIC || this.buffer.length + chunk.length > MAX_MESSAGE + MAX_HEADER + 65536)
        throw new IntelError("transport_limit", "Language server output exceeded byte limit");
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        if (this.expected === undefined) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (this.buffer.length > MAX_HEADER) throw new IntelError("protocol_error", "Oversized LSP header");
            return;
          }
          if (end > MAX_HEADER) throw new IntelError("protocol_error", "Oversized LSP header");
          const lengths = this.buffer.subarray(0, end).toString("ascii").split("\r\n").filter(line => /^content-length:/i.test(line));
          if (lengths.length !== 1 || !/^content-length: *[0-9]+ *$/i.test(lengths[0]))
            throw new IntelError("protocol_error", "Expected one numeric Content-Length header");
          this.expected = Number(lengths[0].split(":")[1]);
          if (!Number.isSafeInteger(this.expected) || this.expected < 1 || this.expected > MAX_MESSAGE)
            throw new IntelError("transport_limit", "Invalid or oversized LSP message");
          this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.expected) return;
        const body = this.buffer.subarray(0, this.expected);
        this.buffer = this.buffer.subarray(this.expected);
        this.expected = undefined;
        if (++this.messages > 10000) throw new IntelError("transport_limit", "Too many LSP messages");
        let message: any;
        try { message = JSON.parse(decoder.decode(body)); }
        catch { throw new IntelError("protocol_error", "Invalid UTF-8/JSON in LSP message"); }
        if (!message || Array.isArray(message) || message.jsonrpc !== "2.0")
          throw new IntelError("protocol_error", "Invalid JSON-RPC envelope");
        if (typeof message.method === "string") {
          if (message.id !== undefined) {
            // No dynamic registration, configuration, workspace edits, or arbitrary callbacks.
            this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Read-only client: unsupported server request" } });
          }
          continue; // Push diagnostics are deliberately not treated as current evidence.
        }
        if (("result" in message) === ("error" in message) ||
            !["string", "number"].includes(typeof message.id) ||
            ("error" in message && (!message.error || typeof message.error.code !== "number" || typeof message.error.message !== "string")))
          throw new IntelError("protocol_error", "Invalid JSON-RPC response");
        const pending = this.pending.get(message.id);
        if (!pending) continue; // Late canceled response.
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) pending.reject(new IntelError(message.error.code === -32601 ? "unsupported_method" : "server_error", String(message.error.message).slice(0, 1000)));
        else pending.resolve(message.result);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private send(message: unknown) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_MESSAGE || this.process.stdin.writableLength + body.length > MAX_MESSAGE * 2)
      throw new IntelError("transport_limit", "LSP input exceeded byte limit");
    this.process.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  notify(method: string, params?: unknown) { this.send({ jsonrpc: "2.0", method, params }); }

  request(method: string, params?: unknown, signal?: AbortSignal, timeoutMs = 15000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new IntelError("canceled", "Request canceled"));
    if (this.pending.size >= 8) return Promise.reject(new IntelError("busy", "Too many pending LSP requests"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = (code: string) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        try { this.notify("$/cancelRequest", { id }); } catch { /* Connection already failed. */ }
        reject(new IntelError(code, `${method} ${code}`));
      };
      const abort = () => cancel("canceled");
      const timer = setTimeout(() => cancel("timeout"), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  async initialize(rootUri: string, initializationOptions: unknown, signal?: AbortSignal) {
    const result = await this.request("initialize", {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "code-intel" }],
      capabilities: { general: { positionEncodings: ["utf-8", "utf-16", "utf-32"] }, workspace: { applyEdit: false },
        textDocument: { synchronization: { dynamicRegistration: false }, definition: { linkSupport: true }, hover: { contentFormat: ["plaintext"] } } },
      initializationOptions,
    }, signal);
    if (!result?.capabilities) throw new IntelError("startup_failed", "Missing language-server capabilities");
    const encoding = result.capabilities.positionEncoding ?? "utf-16";
    if (!["utf-8", "utf-16", "utf-32"].includes(encoding)) throw new IntelError("unsupported_encoding", String(encoding));
    this.encoding = encoding;
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo ?? { name: "not_reported" };
    this.notify("initialized", {});
  }

  sync(uri: string, languageId: string, text: string) {
    const previous = this.documents.get(uri);
    if (previous?.text === text) return previous.version;
    const sync = this.capabilities?.textDocumentSync;
    const change = typeof sync === "number" ? sync : sync?.change;
    if (!previous && !(typeof sync === "number" ? sync > 0 : sync?.openClose))
      throw new IntelError("unsupported_sync", "Server does not support document open/close");
    if (previous && change !== 1 && change !== 2) throw new IntelError("unsupported_sync", "Server cannot synchronize changes");
    const version = (previous?.version ?? 0) + 1;
    if (!previous) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.documents.set(uri, { text, version });
    return version;
  }

  close() {
    return this.closing ??= this.shutdown();
  }

  private async shutdown() {
    if (!this.failure && !this.exited) {
      try {
        for (const uri of this.documents.keys()) this.notify("textDocument/didClose", { textDocument: { uri } });
        await this.request("shutdown", null, undefined, 500);
        this.notify("exit");
      } catch { /* Escalate below, even if graceful shutdown fails. */ }
    }
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
      clearTimeout(timer);
    };
    await wait(500);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, signal);
        else if (!this.exited) this.process.kill(signal);
      } catch { /* Already gone, or cleanup cannot be confirmed. */ }
    };
    kill("SIGTERM");
    if (!this.exited) await wait(300);
    // Also clean up ordinary in-group children left after the server exits.
    kill("SIGKILL");
    if (!this.exited) await wait(300);
    this.fail(new IntelError("closed", "Language server connection closed"));
    this.process.stdin.destroy(); this.process.stdout.destroy(); this.process.stderr.destroy();
    if (!this.exited) this.process.unref();
    return { serverExited: this.exited, descendants: "unverified" as const };
  }
}
