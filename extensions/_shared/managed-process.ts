import { spawn, spawnSync } from "node:child_process";
import type { OwnedProcessGroups } from "./process-group-ledger.ts";

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
	onStderrChunk?: (chunk: Buffer) => void;
	onStdoutLine?: (line: string) => void;
	limitStdoutEvents?: boolean;
	stdin?: "ignore" | "pipe";
	/** Ordinary commands must reap their original group even when the leader exits naturally. */
	cleanupOnExit?: boolean;
	/** Additional POSIX process groups owned by this run; re-read on every cleanup pass. */
	ownedProcessGroups?: () => OwnedProcessGroups;
	/** Called once when teardown begins, before any signal is sent. */
	onTeardown?: () => void;
}

export interface ManagedProcessResult {
	exitCode: number;
	exitSignal: NodeJS.Signals | null;
	/** Null when no real process close/exit code was observed (including forced settlement). */
	observedExitCode: number | null;
	/** Evidence for the original POSIX process group and any owned groups, never other escaped descendants. */
	cleanup: "confirmed" | "unconfirmed";
	cleanupDetail?: string;
	/** The owner ended the process after semantic completion via complete(). */
	semanticCompletion?: boolean;
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

export function abortError(message = "Subagent execution aborted"): Error {
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
	/** Semantic completion: stop the process tree without recording a failure reason. */
	complete(): void;
}

function groupAlive(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error: any) {
		return error?.code !== "ESRCH";
	}
}

export function startManagedProcess(options: ManagedProcessOptions): ManagedProcessHandle {
	const posix = process.platform !== "win32";
	const stderr = new BoundedTailBuffer(options.maxStderrBytes);
	let stdoutBuffer = "";
	let closed = false;
	let settled = false;
	let stdinEnded = false;
	let stdinError: Error | undefined;
	let terminationReason: ManagedTerminationReason | undefined;
	let errorMessage: string | undefined;
	let semanticCompletion = false;
	let runTimer: NodeJS.Timeout | undefined;
	let teardownTimer: NodeJS.Timeout | undefined;
	let teardown: { startedAt: number; escalated: boolean } | undefined;
	let pipesClosed = false;
	let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let proc: ReturnType<typeof spawn> | undefined;
	let resolveCompletion!: (result: ManagedProcessResult) => void;
	let stdinQueue: Promise<void> = Promise.resolve();

	const completion = new Promise<ManagedProcessResult>((resolve) => {
		resolveCompletion = resolve;
	});

	const ownedGroups = (): OwnedProcessGroups => (posix && options.ownedProcessGroups?.()) || { groups: [] };

	const signalAll = (signal: NodeJS.Signals) => {
		// Windows reuses PIDs and has no group identity: never taskkill a leader that already exited.
		if (posix || !leaderExit) terminateProcessTree(proc?.pid, signal);
		for (const group of ownedGroups().groups) {
			try {
				process.kill(-group, signal);
			} catch {
				// Exited, or not signalable; never fall back to a bare PID that may be reused.
			}
		}
	};

	/** Groups that still hold processes; Windows can only observe the leader. */
	const liveGroups = (): number[] => {
		if (!proc?.pid) return [];
		if (!posix) return leaderExit ? [] : [proc.pid];
		const live = groupAlive(proc.pid) ? [proc.pid] : [];
		return [...live, ...ownedGroups().groups];
	};

	const cleanupVerdict = (pipesHeld: boolean): Pick<ManagedProcessResult, "cleanup" | "cleanupDetail"> => {
		if (!proc?.pid) return { cleanup: "confirmed" };
		if (!posix) return { cleanup: "unconfirmed", cleanupDetail: "Process-tree cleanup cannot be verified on Windows." };
		const live = groupAlive(proc.pid) ? [proc.pid] : [];
		const owned = ownedGroups();
		live.push(...owned.groups);
		const details = [
			live.length ? `process groups still alive: ${live.slice(0, 10).join(", ")}${live.length > 10 ? ", ..." : ""}` : "",
			// Pipes still open after every known group is gone mean an escaped descendant holds them.
			pipesHeld ? "output pipes were held open by an untracked descendant" : "",
			owned.error ?? "",
		].filter(Boolean);
		return details.length ? { cleanup: "unconfirmed", cleanupDetail: details.join("; ") } : { cleanup: "confirmed" };
	};

	const finish = (forced: boolean, fallback?: { code: number | null; signal: NodeJS.Signals | null }) => {
		if (settled) return;
		settled = true;
		closed = true;
		const pipesHeld = forced && !pipesClosed;
		if (teardownTimer) clearTimeout(teardownTimer);
		if (runTimer) clearTimeout(runTimer);
		options.signal?.removeEventListener("abort", onAbort);
		// A detached leader can exit on SIGTERM while a descendant ignores it.
		if (forced || terminationReason) signalAll("SIGKILL");
		if (!terminationReason && stdoutBuffer.trim() && Buffer.byteLength(stdoutBuffer, "utf8") <= options.maxEventBytes) {
			const line = stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
			options.onStdoutLine?.(line);
		}
		const exit = leaderExit ?? fallback ?? { code: null, signal: forced ? "SIGKILL" as const : null };
		// SIGKILLed groups disappear asynchronously; verify within a short bound instead of guessing.
		const verifyUntil = Date.now() + (forced || terminationReason ? Math.min(1000, Math.max(100, options.termGraceMs)) : 0);
		const resolveVerified = () => {
			if (liveGroups().length && Date.now() < verifyUntil) {
				setTimeout(resolveVerified, 20);
				return;
			}
			resolveCompletion({
				exitCode: exit.code ?? 1,
				exitSignal: exit.signal,
				observedExitCode: leaderExit ? leaderExit.code : forced || !proc?.pid ? null : exit.code,
				...cleanupVerdict(pipesHeld),
				stderr: stderr.toString(),
				stderrTruncated: stderr.truncated,
				terminationReason,
				errorMessage,
				...(semanticCompletion ? { semanticCompletion } : {}),
			});
		};
		resolveVerified();
	};

	/** One bounded TERM -> KILL -> verify path for natural exit, termination, and semantic completion. */
	const startTeardown = () => {
		if (teardown || settled) return;
		teardown = { startedAt: Date.now(), escalated: false };
		if (runTimer) clearTimeout(runTimer);
		try {
			options.onTeardown?.();
		} catch {
			// Teardown must proceed even if the owner's bookkeeping fails.
		}
		signalAll("SIGTERM");
		const check = () => {
			if (settled || !teardown) return;
			if (pipesClosed && liveGroups().length === 0) {
				finish(false);
				return;
			}
			const elapsed = Date.now() - teardown.startedAt;
			if (elapsed >= options.termGraceMs && !teardown.escalated) {
				teardown.escalated = true;
				signalAll("SIGKILL");
			}
			if (elapsed >= options.termGraceMs * 2) {
				// A descendant can inherit stdout/stderr after the leader exits, preventing `close` forever.
				proc?.stdout?.destroy();
				proc?.stderr?.destroy();
				finish(true);
				return;
			}
			teardownTimer = setTimeout(check, 20);
		};
		check();
	};

	const requestTermination = (reason: ManagedTerminationReason, message?: string) => {
		if (closed || terminationReason || teardown) return;
		terminationReason = reason;
		errorMessage = message;
		stdoutBuffer = "";
		startTeardown();
	};

	function onAbort() {
		requestTermination("aborted", "Subagent execution was aborted.");
	}

	try {
		proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			detached: posix,
			shell: false,
			stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
		});
	} catch (error: unknown) {
		terminationReason = "spawn_error";
		errorMessage = error instanceof Error ? error.message : String(error);
		finish(false, { code: 1, signal: null });
	}

	if (proc) {
		options.onSpawn?.(proc.pid);
		proc.stdin?.on("error", (error) => {
			stdinError = error;
			if (!closed && !settled) requestTermination("spawn_error", `Subagent process stdin failed: ${error.message}`);
		});
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => {
			if (closed) return;
			options.onStdoutChunk?.(chunk);
			if (terminationReason) return; // Capture teardown output, never parse new agent frames.
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
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr.append(chunk);
			options.onStderrChunk?.(chunk);
		});
		proc.on("error", (error) => {
			if (!proc?.pid) {
				terminationReason = "spawn_error";
				errorMessage = error.message;
				finish(false, { code: 1, signal: null });
				return;
			}
			requestTermination("spawn_error", error.message);
		});
		proc.on("exit", (code, signal) => {
			leaderExit = { code, signal };
			if (options.cleanupOnExit) startTeardown();
		});
		proc.on("close", (code, signal) => {
			pipesClosed = true;
			leaderExit ??= { code, signal };
			if (teardown) return; // The teardown check settles once the groups are gone.
			if (options.cleanupOnExit && proc?.pid) startTeardown();
			else finish(false);
		});
	}

	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (!settled && !teardown) {
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
		complete: () => {
			if (closed || teardown) return;
			semanticCompletion = true;
			startTeardown();
		},
	};
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
	if (options.signal?.aborted) throw abortError();
	return startManagedProcess(options).completion;
}
