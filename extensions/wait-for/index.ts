/**
 * Blocking condition, job-completion, and command-readiness waits for Pi.
 *
 * Pi's agent loop is strictly LLM -> tool -> LLM -> tool. There is no native
 * "block until an external event, then resume" step, so "waiting" usually means
 * "polling" — emitting a tool call to check state on every iteration, which
 * re-sends the whole context (cache reads) each turn and burns tokens while
 * nothing is actually happening.
 *
 * The wait tools fix this by turning the wait itself into a single blocking tool
 * call. While it runs, the agent loop is paused (no LLM call = zero tokens
 * burned) and resumes the instant the condition is met or the timeout fires.
 * Optional `progress` output streams to the TUI so the user can see what is
 * happening, and the call is fully abortable (Esc/Ctrl-C) via the agent signal.
 *
 * Typical use: gate a dependent step behind a detached long-running task
 * (download, build, deploy, training) after any parallel prep work is done.
 *
 *   wait_for_condition({
 *     // Watch the DONE marker the download script already writes:
 *     condition: "grep -q '^DONE ' ~/models/mlx/GLM-5.2-mxfp4.download.log 2>/dev/null",
 *     timeout: 3600,
 *     poll_interval: 15,
 *     progress: "du -sh ~/models/mlx/GLM-5.2-mxfp4.partial 2>/dev/null | cut -f1",
 *   })
 *
 * The condition is a shell command run with `sh -c` in the session cwd; exit
 * code 0 means "condition met"; configured failure_exit_codes stop with an
 * error (default 126/127: not executable/not found); other non-zero means "not yet".
 */

import { StringEnum, Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { runShellProcess } from "../_shared/shell-process.ts";
import { operationTool } from "../_shared/operation-tool.ts";
import {
	type JobSnapshot,
	TERMINAL_JOB_STATUS,
} from "../_shared/job-store.ts";
import { readUnifiedJobSnapshots, type UnifiedJobSnapshot } from "../_shared/job-snapshots.ts";

const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_INTERVAL = 1;
const MAX_POLL_INTERVAL = 3600;
const MAX_TIMEOUT = 86400; // 24h cap; longer waits should use launchd + handoff
const MAX_CONDITION_TIMEOUT = 30; // each condition/progress eval gets at most this many seconds

type JobWaitMode = "all" | "any" | "any_success" | "any_failure";

/** Evaluate the job-wait mode against current snapshots. Returns done=true when the resume condition is met. */
export function evaluateJobMode(
	ids: string[],
	snapshots: Map<string, JobSnapshot>,
	mode: JobWaitMode,
): { done: boolean; reason: string; error?: string } {
	const missing = ids.filter(id => !snapshots.has(id));
	if (missing.length) return { done: true, reason: "Unknown job IDs", error: `Unknown job IDs: ${missing.join(", ")}` };
	const awaiting = ids.filter((id) => snapshots.get(id)?.status === "awaiting_answer");
	if (awaiting.length > 0) {
		return { done: true, reason: `job ${awaiting[0]} is awaiting_answer and needs a correlated parent answer` };
	}
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
	if (terminal.length === ids.length) return { done: true, reason: "Requested outcome is impossible", error: `All jobs terminal without matching ${mode}` };
	return { done: false, reason: "" };
}

function summarizeJobs(ids: string[], snapshots: Map<string, UnifiedJobSnapshot>): string {
	return ids
		.map((id) => {
			const s = snapshots.get(id);
			const status = s?.status ?? "unknown";
			const label = s?.label ? ` — ${truncate(s.label, 60)}` : "";
			return `${id}: ${status}${label}${s?.command ? ` [command=${s.command.status}, exit=${s.command.exitCode ?? "unknown"}, readiness=${s.command.readiness}, cleanup=${s.command.cleanup ?? "pending"}]` : ""}`;
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
	failedJobs?: number;
	awaitingJobs?: number;
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

function errorResult(text: string, _details: WaitForDetails): never {
	// Pi marks resolved tool executions successful; throwing is required for a
	// finalized isError tool-result message (a returned isError field is ignored).
	throw new Error(text);
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

/** Unregistered engine retained for internal callers and regression coverage. */
export const waitForEngine = defineTool({
	name: "wait_for",
	label: "Wait For",
	executionMode: "sequential",
	description: "Internal blocking wait engine. Public callers use the operation-specific wait tools.",
	parameters: Type.Object({
		condition: Type.Optional(
			Type.String({
				description:
					"Read-only predicate run with `sh -c` in the session cwd. Exit 0 = actual condition met; failure_exit_codes = fatal; other non-zero = not yet. A successful status query alone does not prove deployment/job success. e.g. `grep -q '^DONE ' file.download.log 2>/dev/null`, `! pgrep -f aria2c >/dev/null 2>&1`, `test -f /path/done.flag`. Mutually exclusive with `jobs`.",
			}),
		),
		jobs: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 64,
				description:
					"Background subagent job ids to wait for instead of a shell condition. Mutually exclusive with `condition`. Resumes immediately for `awaiting_answer`, or when `job_mode` is satisfied by terminal statuses (`completed`, `failed`, `canceled`).",
			}),
		),
		readiness: Type.Optional(Type.Boolean({ description: "With command jobs and job_mode=all only: wait for every configured readiness probe. Service readiness is separate from successful completion." })),
		job_mode: Type.Optional(
			StringEnum(["all", "any", "any_success", "any_failure"] as const, {
				description:
					"With jobs: all (default, all terminal, NOT necessarily successful), any (first terminal), any_success (first completed), any_failure (first failed/canceled). Omit for condition waits; redundant all is accepted and ignored.",
			}),
		),
		failure_exit_codes: Type.Optional(
			Type.Array(Type.Integer({ minimum: 1, maximum: 255 }), {
				maxItems: 255,
				description: "Condition waits only: exit codes that stop immediately with an error. Default [126,127] (not executable/not found). Overrides the default; [] retries all nonzero exits. Configure a distinct code for terminal deployment/auth failures; exit 1 normally means pending.",
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
		if (!Number.isFinite(params.timeout) || params.timeout <= 0 || (params.poll_interval !== undefined && !Number.isFinite(params.poll_interval))) throw new Error("timeout/poll_interval must be finite and timeout positive");
		if (params.job_mode !== undefined && !isJobWaitMode(params.job_mode)) throw new Error("Invalid job_mode");
		if (params.jobs && (params.jobs.length === 0 || params.jobs.length > 64 || params.jobs.some(id => !id.trim()))) throw new Error("Provide 1–64 nonempty job IDs, or omit jobs for a condition wait.");
		if (params.failure_exit_codes && (params.failure_exit_codes.length > 255 || params.failure_exit_codes.some(code => !Number.isInteger(code) || code < 1 || code > 255))) throw new Error("failure_exit_codes must contain integer exit codes from 1 to 255.");
		const condition = params.condition?.trim();
		const jobIds = (params.jobs ?? []).map((s) => s.trim()).filter(Boolean);
		const jobMode: JobWaitMode = isJobWaitMode(params.job_mode) ? params.job_mode : "all";
		const useJobs = jobIds.length > 0;
		if (useJobs && params.failure_exit_codes !== undefined) throw new Error("failure_exit_codes is only valid with condition. Omit it when using jobs.");
		const failureExitCodes = new Set(params.failure_exit_codes ?? [126, 127]);
		if (params.readiness && (!useJobs || jobMode !== "all" || jobIds.some(id => !id.startsWith("cmd_")))) throw new Error("readiness requires command job IDs and job_mode=all");
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
		if (!useJobs && params.job_mode !== undefined && params.job_mode !== "all") {
			return errorResult("Error: omit `job_mode` for a `condition` wait (redundant `all` is accepted). Use `jobs` for other job modes.", {
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
		let failedJobs = 0;
		let awaitingJobs = 0;
		const diagnostics = () => [
			lastStdout ? `last nonempty stdout: ${truncate(lastStdout, 1000)}` : "",
			lastStderr ? `last nonempty stderr: ${truncate(lastStderr, 1000)}` : "",
		].filter(Boolean).join("\n");
		const timeoutResult = () => errorResult(
			`Timed out after ${formatDuration(Date.now() - startedAt)} (${checks} check${checks === 1 ? "" : "s"}). ${useJobs ? "Job wait condition not met." : "Condition not met."}\n` +
			`${useJobs ? `jobs (${jobMode}): ${jobIds.join(", ")}` : `condition: ${condition}`}\n` +
			(lastProgress ? `last progress: ${truncate(lastProgress, 200)}\n` : "") + diagnostics(),
			{ ...baseDetails, timedOut: true, checks, elapsedMs: Date.now() - startedAt, lastStdout, lastStderr, lastProgress },
		);

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
				// Never start another evaluation after sleeping to the deadline.
				if (Date.now() >= deadline) return timeoutResult();

				let done = false;
				let reason = "";

				if (useJobs) {
					const snapshots = readUnifiedJobSnapshots(jobIds, cwd);
					let evalResult = evaluateJobMode(jobIds, snapshots, jobMode);
					if (params.readiness && !evalResult.error) {
						const records = jobIds.map(id => snapshots.get(id)!.command!);
						const invalid = records.find(r => r.readiness === "not_requested" || r.readiness === "failed" || !["starting", "running"].includes(r.status));
						evalResult = invalid ? { done: true, reason: "Readiness unavailable", error: `Job ${invalid.id} cannot become ready: ${invalid.status}/${invalid.readiness}` }
							: { done: records.every(r => r.readiness === "ready"), reason: "All command readiness probes passed (processes still running)" };
					}
					if (evalResult.error) throw new Error(evalResult.error);
					done = evalResult.done;
					reason = evalResult.reason;
					const termCount = jobIds.filter(
						(id) => snapshots.has(id) && TERMINAL_JOB_STATUS.has(snapshots.get(id)!.status),
					).length;
					awaitingJobs = jobIds.filter((id) => snapshots.get(id)?.status === "awaiting_answer").length;
					failedJobs = jobIds.filter((id) => TERMINAL_JOB_STATUS.has(snapshots.get(id)!.status) && snapshots.get(id)!.status !== "completed").length;
					lastProgress = `${termCount}/${jobIds.length} terminal • ${failedJobs} unsuccessful${awaitingJobs ? ` • ${awaitingJobs} awaiting answer` : ""}`;
					lastStdout = summarizeJobs(jobIds, snapshots);
					lastStderr = "";
				} else {
					const cond = await runShellProcess(condition!, cwd, Math.max(1, Math.min(MAX_CONDITION_TIMEOUT * 1000, deadline - Date.now())), signal);
					if (cond.aborted || signal?.aborted) throw new AbortError();
					if (cond.stdout.trim()) lastStdout = cond.stdout;
					if (cond.stderr.trim()) lastStderr = cond.stderr;
					if (cond.terminationReason === "spawn_error" || cond.terminationReason === "output_limit" || (!cond.terminationReason && failureExitCodes.has(cond.code))) {
						throw new Error(`Condition evaluation failed (${cond.terminationReason ?? `exit ${cond.code}`}).\n${diagnostics()}`);
					}
					done = !cond.terminationReason && cond.code === 0 && Date.now() <= deadline;
				}
				checks += 1;

				if (done) {
					const elapsedMs = Date.now() - startedAt;
					const head = useJobs
						? `Job wait condition reached after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}); ${failedJobs} unsuccessful, ${awaitingJobs} awaiting answer. ${params.readiness ? "Readiness is not completion." : "Terminal does not imply successful."}`
						: `Condition met after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}). Resuming.`;
					const tail = useJobs
						? `\n${reason}\n${lastStdout}\n\nInspect cmd_ IDs with command_status({id:"<id>"}); inspect subagents with subagent_status({jobId:"<id>"}). Answer awaiting_answer with subagent_answer({jobId,questionId,answer}) using the current correlated questionId, then use wait_for_jobs for further completion waits.`
						: "";
					return textResult(head + tail, {
						...baseDetails,
						met: true,
						failedJobs,
						awaitingJobs,
						checks,
						elapsedMs,
						lastStdout,
						lastStderr,
						lastProgress,
					});
				}

				// Not yet: gather optional progress (condition mode only), then stream an update.
				if (!useJobs && progress && Date.now() < deadline) {
					const prog = await runShellProcess(progress, cwd, Math.max(1, Math.min(MAX_CONDITION_TIMEOUT * 1000, deadline - Date.now())), signal);
					if (prog.aborted || signal?.aborted) throw new AbortError();
					if (prog.stdout.trim()) lastProgress = prog.stdout;
				}
				emitProgress();

				// Respect the deadline.
				const now = Date.now();
				const remainingMs = deadline - now;
				if (remainingMs <= 0) return timeoutResult();

				// Sleep for the poll interval (or until the deadline, whichever is sooner), abortable.
				const sleepMs = Math.min(pollInterval * 1000, remainingMs);
				await abortableSleep(sleepMs, signal);
			}
		} catch (err) {
			const aborted = err instanceof AbortError || signal?.aborted;
			const elapsedMs = Date.now() - startedAt;
			if (aborted) {
				return textResult(
					`Wait aborted after ${formatDuration(elapsedMs)} (${checks} check${checks === 1 ? "" : "s"}).${useJobs ? " Background jobs continue; cancel explicitly with command_cancel({id}) or subagent_cancel({jobId})." : " Termination was requested for the active condition/progress process group; escaped descendants are not covered."}`,
					{ ...baseDetails, aborted: true, checks, elapsedMs, lastStdout, lastStderr, lastProgress },
				);
			}
			return errorResult(
				`Wait failed: ${err instanceof Error ? err.message : String(err)}`,
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
		const name = args.readiness ? "wait_for_ready" : args.jobs !== undefined ? "wait_for_jobs" : "wait_for_condition";
		const lines = [
			theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", `up to ${to}s, every ${pi}s`),
		];
		if (args.jobs !== undefined) {
			const mode = args.job_mode ?? "all";
			lines.push(theme.fg("dim", `  jobs (${args.readiness ? "all ready" : mode}): ${jobs.join(", ")}`));
		} else {
			const cond = truncate(String(args.condition ?? ""), 80);
			lines.push(theme.fg("dim", `  until: ${cond}`));
			if (args.job_mode !== undefined) lines.push(theme.fg("dim", `  job_mode: ${args.job_mode}${args.job_mode === "all" ? " (ignored for condition)" : " (omit for condition)"}`));
			if (args.failure_exit_codes !== undefined) lines.push(theme.fg("dim", `  fatal exit codes: ${args.failure_exit_codes.join(", ") || "none"}`));
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
		if (details.met && (details.failedJobs || details.awaitingJobs)) return new Text(theme.fg("warning", `! ${text}`), 0, 0);
		if (details.met) return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
		return new Text(text, 0, 0);
	},
});

const timingParameters = {
	timeout: Type.Number({
		exclusiveMinimum: 0,
		description: "Maximum seconds to wait; capped at 86400 (24h). Timeout is an error; interruption returns an aborted result.",
	}),
	poll_interval: Type.Optional(Type.Number({
		description: `Seconds between checks. Default ${DEFAULT_POLL_INTERVAL}, clamped to [${MIN_POLL_INTERVAL}, ${MAX_POLL_INTERVAL}].`,
	})),
};

export const waitForConditionTool = operationTool(defineTool({
	name: "wait_for_condition",
	label: "Wait For Condition",
	executionMode: "sequential",
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	description: "Block without token usage until a read-only shell predicate exits 0. Configured fatal exit codes fail promptly; other nonzero exits retry. Supports live progress, timeout, and abort. Each shell evaluation is capped at 30 seconds and the remaining deadline, plus bounded cleanup grace.",
	promptSnippet: "Block until a shell condition is met instead of polling with repeated tool calls",
	promptGuidelines: [
		"Use wait_for_condition after independent prep work, as a single blocking gate for a detached task. The predicate must test the actual outcome, not just successful execution of a status query. Watch a DONE marker or use `! pgrep -f process >/dev/null 2>&1` for completion; plain pgrep is true while running.",
		"For wait_for_condition, exit 0 means met; failure_exit_codes means fatal (default [126,127]); other nonzero exits mean pending. Map terminal deployment/auth failures to an explicit fatal code. Provide progress for live TUI updates. Never launch background work from a predicate: its process group is cleaned up.",
	],
	parameters: Type.Object({
		condition: Type.String({ minLength: 1, pattern: "\\S", description: "Read-only predicate run with sh -c in the session cwd. Exit 0 = met; fatal exit codes = error; other nonzero = pending." }),
		...timingParameters,
		progress: Type.Optional(Type.String({ description: "Read-only shell command whose stdout is shown as live progress on each pending check." })),
		failure_exit_codes: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 255 }), {
			maxItems: 255,
			description: "Fatal condition exit codes. Replaces default [126,127]; [] retries all nonzero exits.",
		})),
	}, { additionalProperties: false }),
	async execute(id, params, signal, onUpdate, ctx) {
		return waitForEngine.execute(id, {
			condition: params.condition,
			timeout: params.timeout,
			poll_interval: params.poll_interval,
			progress: params.progress,
			failure_exit_codes: params.failure_exit_codes,
		}, signal, onUpdate, ctx);
	},
	renderCall(args, theme, context) {
		return waitForEngine.renderCall!({
			condition: args.condition,
			timeout: args.timeout,
			poll_interval: args.poll_interval,
			progress: args.progress,
			failure_exit_codes: args.failure_exit_codes,
		}, theme, context);
	},
	renderResult: waitForEngine.renderResult,
}));

export const waitForJobsTool = operationTool(defineTool({
	name: "wait_for_jobs",
	label: "Wait For Jobs",
	executionMode: "sequential",
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	description: "Block without token usage for command or background subagent jobs. Default all waits for all terminal, not all successful. Any awaiting_answer job wakes immediately regardless of mode. Unknown IDs and impossible outcomes fail promptly. Abort leaves jobs running.",
	promptSnippet: "Block for background job completion or an interactive subagent question",
	promptGuidelines: [
		"Use wait_for_jobs once independent work is complete for background jobs from subagent_run, subagent_parallel, or subagent_chain, and managed command jobs. Inspect results with subagent_status({jobId}) or command_status({id}); terminal does not imply successful.",
		"wait_for_jobs wakes immediately for awaiting_answer in every mode. Fetch the current question with subagent_status({jobId}), answer using subagent_answer({jobId,questionId,answer}), then wait_for_jobs again. Cancel jobs explicitly with subagent_cancel({jobId}) or command_cancel({id}); aborting the wait does not cancel them.",
	],
	parameters: Type.Object({
		jobs: Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), { minItems: 1, maxItems: 64, description: "Command cmd_ IDs and/or background subagent job IDs." }),
		...timingParameters,
		job_mode: Type.Optional(StringEnum(["all", "any", "any_success", "any_failure"] as const, {
			description: "all (default): all terminal; any: first terminal; any_success: first completed; any_failure: first failed/canceled. awaiting_answer always wakes immediately.",
		})),
	}, { additionalProperties: false }),
	async execute(id, params, signal, onUpdate, ctx) {
		return waitForEngine.execute(id, {
			jobs: params.jobs,
			timeout: params.timeout,
			poll_interval: params.poll_interval,
			job_mode: params.job_mode,
		}, signal, onUpdate, ctx);
	},
	renderCall(args, theme, context) {
		return waitForEngine.renderCall!({ jobs: args.jobs ?? [], timeout: args.timeout, poll_interval: args.poll_interval, job_mode: args.job_mode }, theme, context);
	},
	renderResult: waitForEngine.renderResult,
}));

export const waitForReadyTool = operationTool(defineTool({
	name: "wait_for_ready",
	label: "Wait For Ready",
	executionMode: "sequential",
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	description: "Block without token usage until all listed command jobs pass configured readiness probes while still running. Accepts only cmd_ IDs. Readiness is not completion. Missing/failed probes or stopped commands fail promptly. Abort leaves commands running.",
	promptSnippet: "Block until all managed command readiness probes pass",
	promptGuidelines: [
		"Use wait_for_ready for command service readiness, not completion; use wait_for_jobs for terminal outcomes. Inspect with command_status({id}) and cancel with command_cancel({id}).",
	],
	parameters: Type.Object({
		jobs: Type.Array(Type.String({ pattern: "^cmd_\\S+$" }), { minItems: 1, maxItems: 64, description: "Command cmd_ IDs with configured readiness probes; all must become ready while running." }),
		...timingParameters,
	}, { additionalProperties: false }),
	async execute(id, params, signal, onUpdate, ctx) {
		return waitForEngine.execute(id, {
			jobs: params.jobs,
			timeout: params.timeout,
			poll_interval: params.poll_interval,
			readiness: true,
			job_mode: "all",
		}, signal, onUpdate, ctx);
	},
	renderCall(args, theme, context) {
		return waitForEngine.renderCall!({ jobs: args.jobs ?? [], timeout: args.timeout, poll_interval: args.poll_interval, readiness: true, job_mode: "all" }, theme, context);
	},
	renderResult: waitForEngine.renderResult,
}));

export default function waitFor(pi: ExtensionAPI) {
	pi.registerTool(waitForConditionTool);
	pi.registerTool(waitForJobsTool);
	pi.registerTool(waitForReadyTool);
}
