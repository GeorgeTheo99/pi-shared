import { runManagedProcess } from "./managed-process.ts";

export interface ShellProcessResult {
	code: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
}

/** Run a shell command as an abortable process group; never throws. */
export async function runShellProcess(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ShellProcessResult> {
	let stdout = "";
	try {
		const result = await runManagedProcess({
			command: "sh",
			args: ["-c", command],
			cwd,
			env: process.env,
			signal,
			runTimeoutMs: timeoutMs,
			termGraceMs: 250,
			maxStderrBytes: 64 * 1024,
			maxEventBytes: 64 * 1024,
			limitStdoutEvents: false,
			onStdoutChunk: (chunk) => {
				stdout += chunk;
			},
		});
		return {
			code: result.exitCode,
			stdout,
			stderr: result.stderr,
			aborted: result.terminationReason === "aborted",
		};
	} catch (error) {
		return {
			code: -1,
			stdout,
			stderr: error instanceof Error ? error.message : String(error),
			aborted: signal?.aborted ?? false,
		};
	}
}
