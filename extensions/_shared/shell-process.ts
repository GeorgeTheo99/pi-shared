import { runManagedProcess, type ManagedTerminationReason } from "./managed-process.ts";

export interface ShellProcessResult {
	code: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
	terminationReason?: ManagedTerminationReason;
}

/** Run a shell command as an abortable process group; never throws. */
export async function runShellProcess(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ShellProcessResult> {
	let stdout = "";
	let retained = 0;
	let omitted = 0;
	const captureLimit = 1024 * 1024;
	const output = () => stdout + (omitted ? `\n[stdout truncated: ${omitted} bytes omitted]` : "");
	try {
		const result = await runManagedProcess({
			command: "sh",
			args: ["-c", command],
			cwd,
			env: process.env,
			signal,
			runTimeoutMs: timeoutMs,
			termGraceMs: 250,
			cleanupOnExit: true,
			maxStderrBytes: 64 * 1024,
			maxEventBytes: 64 * 1024,
			limitStdoutEvents: false,
			onStdoutChunk: (chunk) => {
				const buffer = Buffer.from(chunk);
				const keep = Math.min(buffer.length, captureLimit - retained);
				stdout += buffer.subarray(0, keep).toString("utf8");
				retained += keep;
				omitted += buffer.length - keep;
			},
		});
		return {
			// A terminated shell may trap TERM and exit 0; that is never success.
			code: result.terminationReason ? -1 : result.exitCode,
			stdout: output(),
			stderr: [result.stderr, result.terminationReason === "timeout"
				? `Shell evaluation timed out after ${timeoutMs}ms.` : result.errorMessage].filter(Boolean).join("\n"),
			aborted: result.terminationReason === "aborted",
			terminationReason: result.terminationReason,
		};
	} catch (error) {
		return {
			code: -1,
			stdout: output(),
			stderr: error instanceof Error ? error.message : String(error),
			aborted: signal?.aborted ?? false,
			terminationReason: signal?.aborted ? "aborted" : "spawn_error",
		};
	}
}
