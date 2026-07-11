/**
 * wait_for — a "pause and wait" tool for Pi.
 *
 * Pi's agent loop is strictly LLM -> tool -> LLM -> tool. There is no native
 * "block until an external event, then resume" step, so "waiting" usually means
 * "polling" — emitting a tool call to check state on every iteration, which
 * re-sends the whole context (cache reads) each turn and burns tokens while
 * nothing is actually happening.
 *
 * `wait_for` fixes this by turning the wait itself into a single blocking tool
 * call. While it runs, the agent loop is paused (no LLM call = zero tokens
 * burned) and resumes the instant the condition is met or the timeout fires.
 * Optional `progress` output streams to the TUI so the user can see what is
 * happening, and the call is fully abortable (Esc/Ctrl-C) via the agent signal.
 *
 * Typical use: gate a dependent step behind a detached long-running task
 * (download, build, deploy, training) after any parallel prep work is done.
 *
 *   wait_for({
 *     condition: "pgrep -f 'aria2c.*GLM-5.2-mxfp4' >/dev/null 2>&1 || ! pgrep -f aria2c >/dev/null 2>&1",
 *     // simpler: watch the DONE marker the download script already writes:
 *     condition: "grep -q '^DONE ' ~/models/mlx/GLM-5.2-mxfp4.download.log 2>/dev/null",
 *     timeout: 3600,
 *     poll_interval: 15,
 *     progress: "du -sh ~/models/mlx/GLM-5.2-mxfp4.partial 2>/dev/null | cut -f1",
 *   })
 *
 * The condition is a shell command run with `sh -c` in the session cwd; exit
 * code 0 means "condition met" (stop waiting), any non-zero means "not yet".
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import {
	type JobSnapshot,
	TERMINAL_JOB_STATUS,
	readJobSnapshots,
} from "../_shared/job-store.ts";

const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_INTERVAL = 1;
const MAX_POLL_INTERVAL = 3600;
const MAX_TIMEOUT = 86400; // 24h cap; longer waits should use launchd + handoff
const MAX_CONDITION_TIMEOUT = 30; // each condition/progress eval gets at most this many seconds

type JobWaitMode = "all" | "any" | "any_success" | "any_failure";

/** Evaluate the job-wait mode against current snapshots. Returns done=true when the resume condition is met. */
function evaluateJobMode(
	ids: string[],
	snapshots: Map<string, JobSnapshot>,
	mode: JobWaitMode,
): { done: boolean; reason: string } {
	const terminal = ids.filter((id) => snapshots.has(id) && TERMINAL_JOB_STATUS.has(snapshots.get(id)!.status));
	const succeeded = terminal.filter((id) => snapshots.get(id)!.status === "completed");
	const failed = terminal.filter((id) => snapshots.get(id)!.status !== "completed");

	switch (mode) {
		case "any":
			if (terminal.length > 0) return { done: true, reason: `job ${terminal[0]} reached terminal status` };
			break;
		case "any_success":
			if (succeeded.length > 0) return { done: true, reason: `job ${succeeded[0]} completed` };
			break;
		case "any_failure":
			if (failed.length > 0) return { done: true, reason: `job ${failed[0]} ${snapshots.get(failed[0])!.status}` };
			break;
		case "all":
		default:
			if (terminal.length === ids.length) return { done: true, reason: `all ${ids.length} job(s) terminal` };
			break;
	}
	return { done: false, reason: "" };
}

function summarizeJobs(ids: string[], snapshots: Map<string, JobSnapshot>): string {
	return ids
		.map((id) => {
			const s = snapshots.get(id);
			const status = s?.status ?? "unknown";
			const label = s?.label ? ` — ${truncate(s.label, 60)}` : "";
			return `${id}: ${status}${label}`;
		})
		.join("\n");
}

function isJobWaitMode(value: unknown): value is JobWaitMode {
	return value === "all" || value === "any" || value === "any_success" || value === "any_failure";
}

interface WaitForDetails {
	condition: string;
	jobs: string[];
	jobMode: JobWaitMode;
	timeout: number;
	pollInterval: number;
	progress?: string;
	met: boolean;
	timedOut: boolean;
	aborted: boolean;
	checks: number;
	elapsedMs: number;
	lastStdout: string;
	lastStderr: string;
	lastProgress: string;
	error?: string;
}

class AbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "AbortError";
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function textResult(text: string, details: WaitForDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errorResult(text: string, details: WaitForDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError: true,
	};
}

interface ShellResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a shell command with `sh -c` in cwd; never throws. Exit 0 = success. */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("sh", ["-c", command], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
		} catch (err) {
			resolve({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
			return;
		}

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data) => (stdout += data.toString()));
		proc.stderr?.on("data", (data) => (stderr += data.toString()));

		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, timeoutMs);

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message });
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

/** Sleep that resolves early if the abort signal fires. Rejects with AbortError. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new AbortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	if (m < 60) return `${m}m${rem.toString().padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return `${h}h${mm.toString().padStart(2, "0")}m`;
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…`;
}

const waitForTool = defineTool({
	name: "wait_for",
	label: "Wait For",
	description:
		"Block the agent loop until either a shell `condition` is true or a set of background subagent `jobs` reaches a terminal status, then resume — without burning tokens while waiting. `condition` is a shell command run with `sh -c` (exit code 0 = met, non-zero = not yet). `jobs` are background subagent job ids (from `spawn_subagent` with background:true); pass `job_mode` to control when to resume. While waiting, no LLM call happens, so the wait costs zero tokens; optional `progress` output streams to the TUI on each poll. Use this to pause for a long-running detached task (download, build, deploy, training) or for fanned-out subagent jobs to finish, instead of polling with repeated bash calls. `condition` and `jobs` are mutually exclusive. Always set a `timeout`. The call is abortable (Esc/Ctrl-C).",
	promptSnippet:
		"wait_for to block the agent loop (zero tokens) until a shell condition is true or background subagent jobs finish, instead of polling",
	promptGuidelines: [
		"Use wait_for to pause for a long-running detached task (download, build, deploy, training) to finish, or for fanned-out background subagent jobs to finish, instead of polling with repeated bash calls. While wait_for runs, the agent loop is paused and consumes zero tokens.",
		"`condition` is a shell command: exit code 0 means condition met (resume), any non-zero means not yet. Examples: `pgrep -f aria2c >/dev/null 2>&1` is wrong (true while running) — to wait for completion watch a DONE marker: `grep -q '^DONE ' file.download.log 2>/dev/null`, or invert: `! pgrep -f aria2c >/dev/null 2>&1`, or a file: `test -f /path/to/done.flag`.",
		"`jobs` waits for background subagent job ids returned by `spawn_subagent({..., background:true})`. `job_mode` defaults to `all` (resume when every job is terminal); use `any` (first terminal), `any_success` (first completed), or `any_failure` (first failed/canceled) to resume early. After it resumes, fetch each job's full output with `spawn_subagent({ jobAction: 'status', jobId: '<id>' })`. `condition` and `jobs` are mutually exclusive.",
		"Always provide a `timeout` (seconds, capped at 24h). For longer tasks, chain another wait_for or use the launchd + handoff resume pattern.",
		"Provide a `progress` command (e.g. `du -sh /path | cut -f1`) so the wait shows live progress in the TUI (ignored in `jobs` mode, which shows per-job status instead).",
		"Do parallel prep work BEFORE calling wait_for. Launch the long task detached (nohup/&), do all independent wiring, then call wait_for once as the gate before the dependent step. Never poll in a loop when wait_for can block for you.",
	],
	parameters: Type.Object({
		condition: Type.Optional(
			Type.String({
				description:
					"Shell command run with `sh -c` in the session cwd. Exit code 0 = condition met (stop waiting and resume); non-zero = not yet. e.g. `grep -q '^DONE ' file.download.log 2>/dev/null`, `! pgrep -f aria2c >/dev/null 2>&1`, `test -f /path/done.flag`. Mutually exclusive with `jobs`.",
			}),
		),
		jobs: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Background subagent job ids (from `spawn_subagent` with background:true) to wait for instead of a shell condition. Mutually exclusive with `condition`. Polls the spawn-subagent job store; resumes when `job_mode` is satisfied. Terminal statuses are `completed`, `failed`, `canceled`.",
			}),
		),
		job_mode: Type.Optional(
			Type.String({
				description:
					"When `jobs` is set: `all` (default, resume when all jobs are terminal), `any` (first terminal), `any_success` (first completed), `any_failure` (first failed/canceled). Only valid with `jobs`.",
			}),
		),
		timeout: Type.Number({
			description:
				"Maximum seconds to wait (hard cap 86400 = 24h). Required so the call cannot hang the session forever. For longer tasks, chain wait_for calls or use the launchd + handoff pattern.",
		}),
		poll_interval: Type.Optional(
			Type.Number({
				description: `Seconds between checks. Default ${DEFAULT_POLL_INTERVAL}, clamped to [${MIN_POLL_INTERVAL}, ${MAX_POLL_INTERVAL}].`,
			}),
		),
		progress: Type.Optional(
			Type.String({
				description:
					"Optional shell command whose stdout is shown as live progress on each poll (e.g. `du -sh /path | cut -f1`). Run with `sh -c` in the session cwd. Ignored in `jobs` mode, which shows per-job status instead.",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const condition = params.condition?.trim();
		const jobIds = (params.jobs ?? []).map((s) => s.trim()).filter(Boolean);
		const jobMode: JobWaitMode = isJobWaitMode(params.job_mode) ? params.job_mode : "all";
		const useJobs = jobIds.length > 0;
		const timeout = clamp(Math.floor(params.timeout), 1, MAX_TIMEOUT);
		const pollInterval = clamp(
			params.poll_interval ?? DEFAULT_POLL_INTERVAL,
			MIN_POLL_INTERVAL,
			MAX_POLL_INTERVAL,
		);
		const progress = useJobs ? undefined : params.progress?.trim() || undefined;

		const baseDetails: WaitForDetails = {
			condition: condition ?? "",
			jobs: jobIds,
			jobMode,
			timeout,
			pollInterval,
			progress,
			met: false,
			timedOut: false,
			aborted: false,
			checks: 0,
			elapsedMs: 0,
			lastStdout: "",
			lastStderr: "",
			lastProgress: "",
		};

		if (useJobs && condition) {
			return errorResult("Error: `jobs` and `condition` are mutually exclusive. Provide exactly one.", {
				...baseDetails,
				error: "mutually exclusive",
			});
		}
		if (!useJobs && !condition) {
			return errorResult("Error: provide either `condition` (shell command) or `jobs` (background subagent job ids).", {
				...baseDetails,
				error: "one required",
			});
		}
		if (!useJobs && params.job_mode !== undefined) {
			return errorResult("Error: `job_mode` is only valid with `jobs`.", {
				...baseDetails,
				error: "job_mode without jobs",
			});
		}

		const cwd = ctx.cwd;
		const startedAt = Date.now();
		const deadline = startedAt + timeout * 1000;
		let checks = 0;
		let lastStdout = "";
		let lastStderr = "";
		let lastProgress = "";

		const emitProgress = (note?: string) => {
			if (!onUpdate) return;
			const elapsed = Date.now() - startedAt;
			const lines = [
				useJobs
					? `waiting for jobs (${jobMode}): ${jobIds.join(", ")}`
					: `waiting for: ${truncate(condition ?? "", 80)}`,
				`elapsed ${formatDuration(elapsed)} / ${formatDuration(timeout * 1000)} • check #${checks}`,
			];
			if (lastProgress) lines.push(`progress: ${truncate(lastProgress, 100)}`);
			if (useJobs && lastStdout) lines.push(truncate(lastStdout, 400));
			if (lastStderr) lines.push(`stderr: ${truncate(lastStderr, 100)}`);
			if (note) lines.push(note);
			onUpdate({
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					...baseDetails,
					checks,
					elapsedMs: elapsed,
					lastStdout,
					lastStderr,
					lastProgress,
				},
			});
		};

		try {
			for (;;) {
				if (signal?.aborted) throw new AbortError();

				let done = false;
				let reason = "";

				if (useJobs) {
					const snapshots = readJobSnapshots();
					const missing = jobIds.filter((id) => !snapshots.has(id));
					const evalResult = evaluateJobMode(jobIds, snapshots, jobMode);
					done = evalResult.done;
					reason = evalResult.reason;
					const termCount = jobIds.filter(
						(id) => snapshots.has(id) && TERMINAL_JOB_STATUS.has(snapshots.get(id)!.status),
					).length;
					lastProgress = `${termCount}/${jobIds.length} terminal`;
					lastStdout =
						summarizeJobs(jobIds, snapshots) +
						(missing.length ? `\n(not yet in store: ${missing.join(", ")})` : "");
					lastStderr = "";
				} else {
					const cond = await runShell(condition!, cwd, MAX_CONDITION_TIMEOUT * 1000);
					lastStdout = cond.stdout;
					lastStderr = cond.stderr;
					done = cond.code === 0;
				}
				checks += 1;

				if (done) {
					const elapsedMs = Date.now() - startedAt;
					const head = useJobs
						? `Jobs ready after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}).`
						: `Condition met after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}). Resuming.`;
					const tail = useJobs
						? `\n${reason}\n${lastStdout}\n\nRetrieve full output: spawn_subagent({ jobAction: "status", jobId: "<id>" })`
						: "";
					return textResult(head + tail, {
						...baseDetails,
						met: true,
						checks,
						elapsedMs,
						lastStdout,
						lastStderr,
						lastProgress,
					});
				}

				// Not yet: gather optional progress (condition mode only), then stream an update.
				if (!useJobs && progress) {
					const prog = await runShell(progress, cwd, MAX_CONDITION_TIMEOUT * 1000);
					lastProgress = prog.stdout;
				}
				emitProgress();

				// Respect the deadline.
				const now = Date.now();
				const remainingMs = deadline - now;
				if (remainingMs <= 0) {
					const elapsedMs = Date.now() - startedAt;
					const subject = useJobs ? `jobs (${jobMode}): ${jobIds.join(", ")}` : `condition: ${condition}`;
					return errorResult(
						`Timed out after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}). ${
							useJobs ? "Jobs not ready." : "Condition not met."
						}\n` +
							`${subject}\n` +
							(lastProgress ? `last progress: ${truncate(lastProgress, 200)}\n` : "") +
							(lastStdout && useJobs ? `\n${truncate(lastStdout, 400)}\n` : "") +
							(lastStderr ? `last stderr: ${truncate(lastStderr, 200)}` : ""),
						{ ...baseDetails, timedOut: true, checks, elapsedMs, lastStdout, lastStderr, lastProgress },
					);
				}

				// Sleep for the poll interval (or until the deadline, whichever is sooner), abortable.
				const sleepMs = Math.min(pollInterval * 1000, remainingMs);
				await abortableSleep(sleepMs, signal);
			}
		} catch (err) {
			const aborted = err instanceof AbortError || signal?.aborted;
			const elapsedMs = Date.now() - startedAt;
			if (aborted) {
				return textResult(
					`Wait aborted after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}).`,
					{ ...baseDetails, aborted: true, checks, elapsedMs, lastStdout, lastStderr, lastProgress },
				);
			}
			return errorResult(
				`wait_for failed: ${err instanceof Error ? err.message : String(err)}`,
				{
					...baseDetails,
					checks,
					elapsedMs,
					lastStdout,
					lastStderr,
					lastProgress,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
	},

	renderCall(args, theme) {
		const to = args.timeout ?? "?";
		const pi = args.poll_interval ?? DEFAULT_POLL_INTERVAL;
		const jobs = Array.isArray(args.jobs) ? args.jobs.map((s) => String(s)) : [];
		const lines = [
			theme.fg("toolTitle", theme.bold("wait_for ")) + theme.fg("muted", `up to ${to}s, every ${pi}s`),
		];
		if (jobs.length > 0) {
			const mode = args.job_mode ?? "all";
			lines.push(theme.fg("dim", `  jobs (${mode}): ${jobs.join(", ")}`));
		} else {
			const cond = truncate(String(args.condition ?? ""), 80);
			lines.push(theme.fg("dim", `  until: ${cond}`));
		}
		if (args.progress) lines.push(theme.fg("dim", `  progress: ${truncate(String(args.progress), 80)}`));
		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(result, _options, theme) {
		const details = result.details as WaitForDetails | undefined;
		const first = result.content[0];
		const text = first?.type === "text" ? first.text : "";
		if (!details) return new Text(text, 0, 0);
		if (details.error && !details.timedOut) return new Text(theme.fg("error", text), 0, 0);
		if (details.timedOut) return new Text(theme.fg("warning", `⏱ ${text.split("\n")[0]}`), 0, 0);
		if (details.aborted) return new Text(theme.fg("warning", `■ ${text}`), 0, 0);
		if (details.met) return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
		return new Text(text, 0, 0);
	},
});

export default function waitFor(pi: ExtensionAPI) {
	pi.registerTool(waitForTool);
}
