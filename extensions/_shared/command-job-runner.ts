import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import { startManagedProcess, type ManagedProcessHandle } from "./managed-process.ts";
import { CommandJobStore, COMMAND_TERMINAL, type CommandRecord } from "./command-job-store.ts";

export interface CommandStart {
	command: string;
	args?: string[];
	cwd: string;
	/** Caller workspace scope; command cwd may be a subdirectory. */
	project?: string;
	timeoutSeconds: number;
	label?: string;
	readiness?: { kind: "tcp" | "http"; port: number; path?: string; timeoutSeconds: number };
}
const LOG_LIMIT = 2 * 1024 * 1024;
const READ_LIMIT = 64 * 1024;
function positive(value: number, max: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`${name} must be in (0, ${max}]`);
}
function probe(spec: NonNullable<CommandStart["readiness"]>, timeout: number): Promise<boolean> {
	return new Promise(resolve => {
		let done = false;
		const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); connection.destroy(); resolve(ok); } };
		// Literal loopback only; no DNS, proxy, redirects, credentials, or response bodies.
		const connection = spec.kind === "tcp"
			? net.connect({ host: "127.0.0.1", port: spec.port }, () => finish(true))
			: http.get({ host: "127.0.0.1", port: spec.port, path: spec.path || "/" }, res => { res.destroy(); finish(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300); });
		connection.on("error", () => finish(false));
		const timer = setTimeout(() => finish(false), timeout);
	});
}
interface LiveJob {
	record: CommandRecord;
	handle?: ManagedProcessHandle;
	done: Promise<void>;
	failing?: string;
}
/** Owns execution only while this runtime lives. Disk records are evidence, not resumable processes. */
export class CommandJobRunner {
	readonly store: CommandJobStore;
	readonly owner = crypto.randomUUID();
	private live = new Map<string, LiveJob>();
	private closing = false;
	private starts = new Set<Promise<CommandRecord>>();
	constructor(store = new CommandJobStore()) { this.store = store; }
	async start(input: CommandStart, signal?: AbortSignal): Promise<CommandRecord> {
		if (this.closing) throw new Error("Command runner is shutting down");
		if (signal?.aborted) throw new Error("Command startup aborted");
		const pending = this.startImpl(input, signal);
		this.starts.add(pending);
		try { return await pending; } finally { this.starts.delete(pending); }
	}
	private async startImpl(input: CommandStart, signal?: AbortSignal): Promise<CommandRecord> {
		if (!input.command || input.command.includes("\0") || Buffer.byteLength(input.command) > 4096) throw new Error("Invalid executable");
		const args = input.args ?? [];
		if (!Array.isArray(args) || args.length > 1024 || args.some(v => typeof v !== "string" || v.includes("\0")) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error("Invalid or oversized argv");
		positive(input.timeoutSeconds, 86400, "timeoutSeconds");
		if (input.label && (input.label.length > 160 || /[\r\n\x00-\x1f]/.test(input.label))) throw new Error("Label must be at most 160 printable characters");
		if (input.readiness) {
			const r = input.readiness;
			if (!["tcp", "http"].includes(r.kind) || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error("Invalid readiness probe");
			positive(r.timeoutSeconds, input.timeoutSeconds, "readiness timeoutSeconds");
			if (r.path && (!r.path.startsWith("/") || r.path.length > 2048 || /[^\x21-\x7e]/.test(r.path))) throw new Error("Invalid readiness path");
		}
		const cwd = fs.realpathSync(input.cwd);
		const project = fs.realpathSync(input.project ?? input.cwd);
		if (!fs.statSync(cwd).isDirectory() || !fs.statSync(project).isDirectory()) throw new Error("cwd/project is not a directory");
		const now = Date.now();
		const record: CommandRecord = {
			version: 1, id: `cmd_${crypto.randomUUID()}`, owner: this.owner, ownerPid: process.pid,
			project, label: input.label || path.basename(input.command), createdAt: now, updatedAt: now,
			status: "starting", readiness: input.readiness ? "pending" : "not_requested",
			stdoutBytes: 0, stderrBytes: 0, stdoutOmitted: 0, stderrOmitted: 0,
		};
		await this.store.reserve(record, 8, 100, signal);
		if (signal?.aborted || this.closing) {
			record.status = "canceled"; record.cleanup = "confirmed"; record.exitCode = null;
			record.finishedAt = Date.now(); record.reason = "Canceled before spawning";
			await this.store.update(record.id, this.owner, () => record);
			if (signal?.aborted) throw new Error("Command startup aborted before spawning");
			return record;
		}
		const live: LiveJob = { record, done: Promise.resolve() };
		this.live.set(record.id, live);
		live.done = this.execute(live, { ...input, cwd, args });
		return { ...record };
	}
	private async execute(live: LiveJob, input: CommandStart): Promise<void> {
		const r = live.record;
		let stdout: number | undefined;
		let stderr: number | undefined;
		let heartbeat: NodeJS.Timeout | undefined;
		let publishing = Promise.resolve();
		let stopped = false;
		const save = () => {
			publishing = publishing.then(async () => {
				const next = await this.store.update(r.id, this.owner, current => {
					if (current.cancelRequested) r.cancelRequested = true;
					return { ...r, updatedAt: Date.now() };
				});
				if (next.cancelRequested && !COMMAND_TERMINAL.has(r.status)) {
					r.status = "canceling";
					live.handle?.terminate("aborted", "Command canceled by owner or explicit request");
				}
			});
			return publishing;
		};
		const append = (stream: "stdout" | "stderr", chunk: string | Buffer) => {
			if (live.failing) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const byteKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
			const omitKey = stream === "stdout" ? "stdoutOmitted" : "stderrOmitted";
			const retain = Math.min(buffer.length, LOG_LIMIT - r[byteKey]);
			try {
				let written = 0;
				while (written < retain) {
					const n = fs.writeSync((stream === "stdout" ? stdout : stderr)!, buffer, written, retain - written);
					if (n <= 0) throw new Error("Log write made no progress");
					written += n;
				}
				r[byteKey] += retain;
				r[omitKey] += buffer.length - retain;
			} catch {
				live.failing = "Log storage failed; output evidence incomplete";
				live.handle?.terminate("output_limit", live.failing);
			}
		};
		try {
			stdout = fs.openSync(path.join(this.store.jobDir(r.id), "stdout.log"), "wx", 0o600);
			stderr = fs.openSync(path.join(this.store.jobDir(r.id), "stderr.log"), "wx", 0o600);
			if (this.closing) r.cancelRequested = true;
			live.handle = startManagedProcess({
				command: input.command, args: input.args ?? [], cwd: input.cwd, env: process.env,
				runTimeoutMs: input.timeoutSeconds * 1000, termGraceMs: 250, cleanupOnExit: true,
				maxStderrBytes: 8192, maxEventBytes: 65536, limitStdoutEvents: false,
				onStdoutChunk: chunk => append("stdout", chunk), onStderrChunk: chunk => append("stderr", chunk),
			});
			r.pid = live.handle.pid;
			r.status = "running";
			await save();
			let beatPending = false;
			heartbeat = setInterval(() => {
				if (beatPending) return;
				beatPending = true;
				void save().catch(() => { live.failing = "Job state storage failed"; live.handle?.terminate("aborted", live.failing); }).finally(() => { beatPending = false; });
			}, 500);
			heartbeat.unref();
			const readinessTask = (async () => {
				if (!input.readiness) return;
				const deadline = r.createdAt + input.readiness.timeoutSeconds * 1000;
				while (!stopped && Date.now() < deadline) {
					if (await probe(input.readiness, Math.min(500, Math.max(1, deadline - Date.now())))) {
						if (!stopped) r.readiness = "ready";
						return;
					}
					if (!stopped) await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
				}
				if (r.readiness === "pending") r.readiness = "failed";
			})();
			const result = await live.handle.completion;
			stopped = true;
			await readinessTask;
			r.exitCode = result.observedExitCode;
			r.exitSignal = result.exitSignal;
			r.cleanup = result.cleanup;
			r.status = live.failing ? "failed" : result.terminationReason === "timeout" ? "timed_out"
				: result.terminationReason === "aborted" ? "canceled"
				: result.terminationReason || result.exitCode !== 0 ? "failed" : "succeeded";
			r.reason = live.failing || result.terminationReason;
			if (r.cleanup === "unconfirmed") r.reason = `${r.reason || "process finished"}; cleanup unconfirmed (original group may remain; escaped descendants are not tracked)`;
		} catch (error) {
			stopped = true;
			if (live.handle) { live.handle.terminate("aborted", "Command manager failed"); await live.handle.completion; }
			r.status = "failed";
			r.reason = "Command setup or state persistence failed; inspect local environment";
			r.cleanup = live.handle ? "unconfirmed" : "confirmed";
		} finally {
			stopped = true;
			if (heartbeat) clearInterval(heartbeat);
			for (const fd of [stdout, stderr]) if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
			if (r.readiness === "pending") r.readiness = "failed";
			r.finishedAt = Date.now();
			// Recover a rejected publishing chain for one final bounded best effort.
			await publishing.catch(() => undefined);
			publishing = Promise.resolve();
			try { await save(); } catch { /* Existing lease becomes lost; never fabricate durable success. */ }
			this.live.delete(r.id);
		}
	}
	async completion(id: string): Promise<CommandRecord | undefined> {
		await this.live.get(id)?.done;
		return this.store.read(id);
	}
	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.allSettled([...this.starts]);
		for (const job of this.live.values()) {
			job.record.cancelRequested = true;
			job.handle?.terminate("aborted", "Command owner shutting down");
		}
		await Promise.all([...this.live.values()].map(job => job.done));
	}
}

export function commandLogs(store: CommandJobStore, id: string, project: string, stream: "stdout" | "stderr", cursor?: string, maxBytes = 8192) {
	const r = store.read(id);
	if (!r || r.project !== project) throw new Error("Unknown command job in this project");
	if (!["stdout", "stderr"].includes(stream) || !Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > READ_LIMIT) throw new Error("Invalid log stream or byte limit (4–65536)");
	let offset = 0;
	if (cursor) {
		if (cursor.length > 512) throw new Error("Invalid log cursor");
		try {
			const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (parsed.id !== id || parsed.stream !== stream || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
			offset = parsed.offset;
		} catch { throw new Error("Invalid or mismatched log cursor"); }
	}
	const file = path.join(store.jobDir(id), `${stream}.log`);
	let fd: number;
	try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
	catch (error: any) { if (error?.code === "ENOENT" && r.status === "starting") return { text: "", cursor, retainedBytes: 0, pending: true }; throw error; }
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > LOG_LIMIT || offset > stat.size) throw new Error("Invalid or expired log cursor/file");
		const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
		const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
		const value = buffer.subarray(0, read);
		// Bytes are authoritative (base64); text is a convenient UTF-8 view and may
		// split a multibyte character at a cursor boundary or contain replacement characters.
		return { text: value.toString("utf8"), base64: value.toString("base64"), cursor: Buffer.from(JSON.stringify({ id, stream, offset: offset + read })).toString("base64url"), retainedBytes: stat.size, omittedBytes: stream === "stdout" ? r.stdoutOmitted : r.stderrOmitted, hasMore: offset + read < stat.size, terminal: COMMAND_TERMINAL.has(r.status) };
	} finally { fs.closeSync(fd); }
}

let shared: CommandJobRunner | undefined;
export function getCommandRunner(): CommandJobRunner { return shared ??= new CommandJobRunner(); }
export async function shutdownCommandRunner(): Promise<void> { const runner = shared; shared = undefined; await runner?.shutdown(); }
