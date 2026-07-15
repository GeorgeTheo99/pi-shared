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
	onStdoutChunk?: (chunk: string) => void;
	onStdoutLine?: (line: string) => void;
	limitStdoutEvents?: boolean;
	stdin?: "ignore" | "pipe";
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

export interface ManagedProcessHandle {
	readonly pid: number | undefined;
	readonly completion: Promise<ManagedProcessResult>;
	writeStdin(data: string): Promise<void>;
	writeJsonLine(value: unknown): Promise<void>;
	endStdin(): Promise<void>;
	terminate(reason: ManagedTerminationReason, message?: string): void;
}

export function startManagedProcess(options: ManagedProcessOptions): ManagedProcessHandle {
	const stderr = new BoundedTailBuffer(options.maxStderrBytes);
	let stdoutBuffer = "";
	let closed = false;
	let settled = false;
	let stdinEnded = false;
	let stdinError: Error | undefined;
	let terminationReason: ManagedTerminationReason | undefined;
	let errorMessage: string | undefined;
	let forceKillTimer: NodeJS.Timeout | undefined;
	let settlementTimer: NodeJS.Timeout | undefined;
	let runTimer: NodeJS.Timeout | undefined;
	let proc: ReturnType<typeof spawn> | undefined;
	let resolveCompletion!: (result: ManagedProcessResult) => void;
	let stdinQueue: Promise<void> = Promise.resolve();

	const completion = new Promise<ManagedProcessResult>((resolve) => {
		resolveCompletion = resolve;
	});

	const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
		if (settled) return;
		settled = true;
		closed = true;
		// A detached leader can exit on SIGTERM while a descendant ignores it.
		// Kill the process group before clearing the escalation timer so a
		// successful leader shutdown cannot leak the rest of the tree.
		if (terminationReason) terminateProcessTree(proc?.pid, "SIGKILL");
		if (forceKillTimer) clearTimeout(forceKillTimer);
		if (settlementTimer) clearTimeout(settlementTimer);
		if (runTimer) clearTimeout(runTimer);
		options.signal?.removeEventListener("abort", onAbort);
		if (!terminationReason && stdoutBuffer.trim() && Buffer.byteLength(stdoutBuffer, "utf8") <= options.maxEventBytes) {
			const line = stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
			options.onStdoutLine?.(line);
		}
		resolveCompletion({
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
		stdoutBuffer = "";
		terminateProcessTree(proc?.pid, "SIGTERM");
		forceKillTimer = setTimeout(() => {
			if (closed) return;
			terminateProcessTree(proc?.pid, "SIGKILL");
			// A descendant can inherit stdout/stderr after the process-group leader
			// exits, preventing Node's `close` event forever. Bound that wait so an
			// aborted tool cannot keep the Pi session alive indefinitely.
			settlementTimer = setTimeout(() => {
				if (closed) return;
				proc?.stdout?.destroy();
				proc?.stderr?.destroy();
				finish(1, "SIGKILL");
			}, options.termGraceMs);
			settlementTimer.unref?.();
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
			stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
		});
	} catch (error: unknown) {
		terminationReason = "spawn_error";
		errorMessage = error instanceof Error ? error.message : String(error);
		finish(1, null);
	}

	if (proc) {
		options.onSpawn?.(proc.pid);
		proc.stdin?.on("error", (error) => {
			stdinError = error;
			if (!closed && !settled) requestTermination("spawn_error", `Subagent process stdin failed: ${error.message}`);
		});
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => {
			if (closed || terminationReason) return;
			options.onStdoutChunk?.(chunk);
			if (!options.onStdoutLine && options.limitStdoutEvents === false) return;
			stdoutBuffer += chunk;
			if (
				options.limitStdoutEvents !== false &&
				Buffer.byteLength(stdoutBuffer, "utf8") > options.maxEventBytes &&
				!stdoutBuffer.includes("\n")
			) {
				requestTermination(
					"output_limit",
					`Subagent emitted an unterminated JSON event larger than ${options.maxEventBytes} bytes.`,
				);
				stdoutBuffer = "";
				return;
			}
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const rawLine of lines) {
				if (terminationReason) break;
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
				if (options.limitStdoutEvents !== false && Buffer.byteLength(line, "utf8") > options.maxEventBytes) {
					requestTermination("output_limit", `Subagent JSON event exceeded ${options.maxEventBytes} bytes.`);
					break;
				}
				options.onStdoutLine?.(line);
			}
		});
		proc.stderr!.on("data", (chunk) => stderr.append(chunk));
		proc.on("error", (error) => {
			if (!proc?.pid) {
				terminationReason = "spawn_error";
				errorMessage = error.message;
				finish(1, null);
				return;
			}
			requestTermination("spawn_error", error.message);
		});
		proc.on("close", (code, signal) => finish(code, signal));
	}

	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (!settled) {
		runTimer = setTimeout(() => {
			requestTermination("timeout", `Subagent exceeded the ${options.runTimeoutMs}ms execution timeout.`);
		}, options.runTimeoutMs);
		runTimer.unref?.();
	}

	const queueStdin = (operation: () => Promise<void>): Promise<void> => {
		const pending = stdinQueue.then(operation);
		stdinQueue = pending.catch(() => undefined);
		return pending;
	};

	const writeStdin = (data: string): Promise<void> =>
		queueStdin(
			() =>
				new Promise<void>((resolve, reject) => {
					const stdin = proc?.stdin;
					if (stdinError) {
						reject(stdinError);
						return;
					}
					if (closed || settled || stdinEnded || !stdin || stdin.destroyed || !stdin.writable) {
						reject(new Error("Subagent process stdin is not writable."));
						return;
					}
					stdin.write(data, (error) => (error ? reject(error) : resolve()));
				}),
		);

	return {
		pid: proc?.pid,
		completion,
		writeStdin,
		writeJsonLine: (value) => writeStdin(`${JSON.stringify(value)}\n`),
		endStdin: () =>
			queueStdin(
				() =>
					new Promise<void>((resolve, reject) => {
						if (stdinEnded) {
							resolve();
							return;
						}
						stdinEnded = true;
						const stdin = proc?.stdin;
						if (stdinError) {
							reject(stdinError);
							return;
						}
						if (closed || settled || !stdin || stdin.destroyed || !stdin.writable) {
							resolve();
							return;
						}
						stdin.end((error?: Error | null) => (error ? reject(error) : resolve()));
					}),
			),
		terminate: requestTermination,
	};
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
	if (options.signal?.aborted) throw abortError();
	return startManagedProcess(options).completion;
}
