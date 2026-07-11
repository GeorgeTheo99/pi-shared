import { spawn, spawnSync } from "node:child_process";

export type ManagedTerminationReason = "aborted" | "timeout" | "output_limit" | "spawn_error";

export interface ManagedProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	runTimeoutMs: number;
	termGraceMs: number;
	maxStderrBytes: number;
	maxEventBytes: number;
	onSpawn?: (pid: number | undefined) => void;
	onStdoutLine?: (line: string) => void;
}

export interface ManagedProcessResult {
	exitCode: number;
	exitSignal: NodeJS.Signals | null;
	stderr: string;
	stderrTruncated: boolean;
	terminationReason?: ManagedTerminationReason;
	errorMessage?: string;
}

class BoundedTailBuffer {
	private tail = Buffer.alloc(0);
	private omittedBytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	append(value: string | Buffer): void {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
		const combined = Buffer.concat([this.tail, chunk]);
		if (combined.length <= this.maxBytes) {
			this.tail = combined;
			return;
		}
		const omitted = combined.length - this.maxBytes;
		this.omittedBytes += omitted;
		this.tail = combined.subarray(omitted);
	}

	get truncated(): boolean {
		return this.omittedBytes > 0;
	}

	toString(): string {
		const text = this.tail.toString("utf8");
		return this.omittedBytes > 0 ? `[stderr truncated: ${this.omittedBytes} bytes omitted]\n${text}` : text;
	}
}

function abortError(message = "Subagent execution aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			// Windows has no process-group signal equivalent. taskkill is part of
			// the OS and /T is required to avoid leaking grandchildren. /F is
			// intentionally immediate because a cooperative tree-wide grace
			// period requires a Job Object, which Node does not expose here.
			const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			if (killed.error) process.kill(pid, signal);
		} else process.kill(-pid, signal);
	} catch (error: any) {
		if (error?.code !== "ESRCH") {
			try {
				process.kill(pid, signal);
			} catch {
				// Process already exited or cannot be signaled.
			}
		}
	}
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
	if (options.signal?.aborted) throw abortError();
	return new Promise<ManagedProcessResult>((resolve) => {
		const stderr = new BoundedTailBuffer(options.maxStderrBytes);
		let stdoutBuffer = "";
		let closed = false;
		let settled = false;
		let terminationReason: ManagedTerminationReason | undefined;
		let errorMessage: string | undefined;
		let forceKillTimer: NodeJS.Timeout | undefined;
		let runTimer: NodeJS.Timeout | undefined;
		let proc: ReturnType<typeof spawn>;

		const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			closed = true;
			// A detached leader can exit on SIGTERM while a descendant ignores it.
			// Kill the process group before clearing the escalation timer so a
			// successful leader shutdown cannot leak the rest of the tree.
			if (terminationReason) terminateProcessTree(proc?.pid, "SIGKILL");
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (runTimer) clearTimeout(runTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (stdoutBuffer.trim() && Buffer.byteLength(stdoutBuffer, "utf8") <= options.maxEventBytes) {
				options.onStdoutLine?.(stdoutBuffer);
			}
			resolve({
				exitCode: exitCode ?? 1,
				exitSignal,
				stderr: stderr.toString(),
				stderrTruncated: stderr.truncated,
				terminationReason,
				errorMessage,
			});
		};

		const requestTermination = (reason: ManagedTerminationReason, message?: string) => {
			if (closed || terminationReason) return;
			terminationReason = reason;
			errorMessage = message;
			terminateProcessTree(proc?.pid, "SIGTERM");
			forceKillTimer = setTimeout(() => {
				if (!closed) terminateProcessTree(proc?.pid, "SIGKILL");
			}, options.termGraceMs);
			forceKillTimer.unref?.();
		};

		function onAbort() {
			requestTermination("aborted", "Subagent execution was aborted.");
		}

		try {
			proc = spawn(options.command, options.args, {
				cwd: options.cwd,
				env: options.env,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error: unknown) {
			terminationReason = "spawn_error";
			errorMessage = error instanceof Error ? error.message : String(error);
			finish(1, null);
			return;
		}

		options.onSpawn?.(proc.pid);
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => {
			if (closed) return;
			stdoutBuffer += chunk;
			if (Buffer.byteLength(stdoutBuffer, "utf8") > options.maxEventBytes && !stdoutBuffer.includes("\n")) {
				requestTermination(
					"output_limit",
					`Subagent emitted an unterminated JSON event larger than ${options.maxEventBytes} bytes.`,
				);
				stdoutBuffer = "";
				return;
			}
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (Buffer.byteLength(line, "utf8") > options.maxEventBytes) {
					requestTermination("output_limit", `Subagent JSON event exceeded ${options.maxEventBytes} bytes.`);
					continue;
				}
				options.onStdoutLine?.(line);
			}
		});
		proc.stderr!.on("data", (chunk) => stderr.append(chunk));
		proc.on("error", (error) => {
			if (!proc.pid) {
				terminationReason = "spawn_error";
				errorMessage = error.message;
				finish(1, null);
				return;
			}
			requestTermination("spawn_error", error.message);
		});
		proc.on("close", (code, signal) => finish(code, signal));

		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		runTimer = setTimeout(() => {
			requestTermination("timeout", `Subagent exceeded the ${options.runTimeoutMs}ms execution timeout.`);
		}, options.runTimeoutMs);
		runTimer.unref?.();
	});
}
