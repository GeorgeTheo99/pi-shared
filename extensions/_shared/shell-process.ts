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
			code: result.exitCode,
			stdout: output(),
			stderr: result.stderr,
			aborted: result.terminationReason === "aborted",
		};
	} catch (error) {
		return {
			code: -1,
			stdout: output(),
			stderr: error instanceof Error ? error.message : String(error),
			aborted: signal?.aborted ?? false,
		};
	}
}
