import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getCommandRunner, type CommandJobRunner } from "../_shared/command-job-runner.ts";
import { loadConfig } from "./config.ts";
import { boundedRead, decode, fingerprint, projectPath } from "./files.ts";
import { parseTap } from "./parsers/tap.ts";
import { digest, LIMITS, type VerificationResult } from "./types.ts";

const message = (e: unknown) => e instanceof Error ? e.message.slice(0, 300) : "Evidence unavailable";
function boundResult(result: VerificationResult): VerificationResult {
	while (Buffer.byteLength(JSON.stringify(result)) > 40 * 1024) {
		if (!result.report?.failures.length) throw new Error("Verification result exceeds 40 KiB output limit");
		result.report.failures.pop(); result.report.failuresOmitted++;
	}
	return result;
}
const limitations = [
	"Scoped filesystem snapshot, not a Git clean-commit or hermetic proof. All scoped untracked/ignored inputs are included; exclusions are explicit.",
	"Before/after snapshots cannot detect change-and-revert, concurrent filesystem races, or inputs outside the scope. Symlinks and special files are unsupported.",
	"Environment, dependencies outside scope and executable version are not fingerprinted. verifierNode is the verifier runtime, not necessarily the check runtime.",
	"Reports are untrusted command output, not independently authenticated. Same-user processes can tamper with local evidence. Command logs may contain secrets.",
	"Result lookup is runtime-local (latest 100); session tool results remain historical evidence. Command artifacts follow command-job retention; project report files remain project-owned.",
];

export class VerificationEngine {
	private results = new Map<string, VerificationResult>();
	private active = new Map<string, string>();
	private pending = new Set<Promise<VerificationResult>>();
	private closing = false;
	private shutdownSignal = new AbortController();
	readonly runner: CommandJobRunner;
	constructor(runner: CommandJobRunner = getCommandRunner()) { this.runner = runner; }
	async list(cwd: string) {
		const loaded = await loadConfig(cwd);
		return { version: 1, project: loaded.project, configSha256: loaded.sha256, checks: loaded.config.checks.map(c => ({ id: c.id, format: c.report.format, timeoutSeconds: c.timeoutSeconds, inputScopeDeclared: !!c.inputs })) };
	}
	async run(cwd: string, checkId: string, trustedSha256: string | undefined, signal?: AbortSignal, onStart?: (id: string) => void): Promise<VerificationResult> {
		if (this.closing || this.pending.size >= 8) throw new Error("Verification unavailable: closing or concurrency limit reached");
		const combinedSignal = signal ? AbortSignal.any([signal, this.shutdownSignal.signal]) : this.shutdownSignal.signal;
		const task = this.runImpl(cwd, checkId, trustedSha256, combinedSignal, onStart);
		this.pending.add(task);
		try { return await task; } finally { this.pending.delete(task); }
	}
	private async runImpl(cwd: string, checkId: string, trustedSha256: string | undefined, signal?: AbortSignal, onStart?: (id: string) => void): Promise<VerificationResult> {
		const loaded = await loadConfig(cwd);
		if (!trustedSha256 || trustedSha256 !== loaded.sha256) throw new Error("Verification config is not trusted at this exact digest. Review it and use /verification-trust or the explicit --verification-trust SHA256 startup flag. Tool arguments cannot grant trust.");
		const check = loaded.config.checks.find(c => c.id === checkId);
		if (!check) throw new Error("Unknown declared verification check");
		const commandCwd = projectPath(loaded.project, check.cwd);
		if (!fs.statSync(commandCwd).isDirectory()) throw new Error("Check cwd is not a directory");
		const token = randomUUID();
		let reportFile: string | undefined, previousReport: string | undefined;
		if (check.report.format !== "exit" && check.report.path !== "stdout") {
			reportFile = projectPath(loaded.project, check.report.path!.replaceAll("{runId}", token), true);
			try { previousReport = await digest(boundedRead(reportFile, LIMITS.reportBytes)); }
			catch (e: any) { if (e.code !== "ENOENT") throw e; }
		}
		const args = check.args.map(arg => arg.replaceAll("{report}", reportFile || "").replaceAll("{runId}", token));
		if (Buffer.byteLength(JSON.stringify(args)) > 8192) throw new Error("Expanded verification argv exceeds 8 KiB");
		const before = await fingerprint(loaded.project, check.inputs);
		// Trust is bound to the exact file read, including edits during fingerprinting.
		if ((await loadConfig(loaded.project)).sha256 !== loaded.sha256) throw new Error("Verification config changed before execution; trust again");
		if (signal?.aborted || this.closing) throw new Error("Verification canceled before execution");
		const job = await this.runner.start({ command: check.command, args, cwd: commandCwd, project: loaded.project, timeoutSeconds: check.timeoutSeconds, label: `verify:${check.id}` }, signal);
		this.active.set(job.id, loaded.project);
		let cancelFailed = false;
		const cancel = () => { void this.runner.store.cancel(job.id, loaded.project).catch(() => { cancelFailed = true; }); };
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted || this.closing) cancel();
		try {
			try { onStart?.(job.id); } catch { /* UI failure cannot orphan the command. */ }
			const processOutcome = await this.runner.completion(job.id);
			const after = await fingerprint(loaded.project, check.inputs);
			const sourceStatus = before.status !== "known" || after.status !== "known" ? "unknown" : before.sha256 === after.sha256 ? "unchanged" : "stale";
			const result: VerificationResult = {
				version: 1, id: job.id, project: loaded.project, check, configSha256: loaded.sha256,
				command: check.command, args, cwd: commandCwd, startedAt: job.createdAt, finishedAt: Date.now(),
				verdict: "passed", reasons: [], process: processOutcome,
				artifacts: { stdout: path.join(this.runner.store.jobDir(job.id), "stdout.log"), stderr: path.join(this.runner.store.jobDir(job.id), "stderr.log") },
				source: { status: sourceStatus, before, after },
				toolchain: { verifierNode: process.version, platform: `${process.platform}/${process.arch}`, executableVersion: "unknown" }, limitations: [...limitations],
			};
			if (check.report.format !== "exit") {
				try {
					if (check.report.path === "stdout") {
						reportFile = result.artifacts.stdout;
						if (!processOutcome || processOutcome.stdoutOmitted !== 0) throw new Error("Report stdout was truncated or unavailable");
					} else reportFile = projectPath(loaded.project, path.relative(loaded.project, reportFile!));
					result.artifacts.report = reportFile;
					const bytes = boundedRead(reportFile!, LIMITS.reportBytes);
					if (check.report.path === "stdout" && bytes.length !== processOutcome?.stdoutBytes) throw new Error("Report stdout size differs from command evidence");
					result.artifacts.reportSha256 = await digest(bytes);
					if (previousReport === result.artifacts.reportSha256) throw new Error("Unchanged pre-existing report: cannot attribute evidence to this run");
					result.report = check.report.format === "tap" ? parseTap(decode(bytes)) : (await import("./parsers/junit.ts")).parseJunit(decode(bytes));
					if (result.report.counts.failed) { result.verdict = "failed"; result.reasons.push("Report contains failed tests"); }
					if ((!result.report.counts.total && !check.discovery!.allowZero) || result.report.counts.total < (check.discovery!.minTests ?? 0)) {
						if (result.verdict === "passed") result.verdict = "incomplete";
						result.reasons.push("Test discovery policy not met");
					}
				} catch (e) { result.verdict = "error"; result.reasons.push(message(e)); }
			} else result.limitations.push("Exit-code check only: no test discovery or assertion counts are inferred.");
			if (sourceStatus !== "unchanged") {
				result.reasons.push(sourceStatus === "stale" ? "Declared inputs changed during execution" : "Source identity unknown");
				if (result.verdict === "passed") result.verdict = sourceStatus === "stale" ? "stale" : "incomplete";
			}
			try { if ((await loadConfig(loaded.project)).sha256 !== loaded.sha256) throw new Error("Config changed during execution"); }
			catch { result.reasons.push("Config changed or unavailable after execution"); if (result.verdict === "passed") result.verdict = "stale"; }
			if (!processOutcome || processOutcome.status !== "succeeded" || processOutcome.exitCode !== 0) {
				result.verdict = processOutcome?.status === "canceled" ? "canceled" : processOutcome?.status === "failed" ? "failed" : "incomplete";
				result.reasons.push(`Command outcome: ${processOutcome?.status ?? "missing"}; exit ${processOutcome?.exitCode ?? "unknown"}`);
			}
			if (processOutcome?.cleanup !== "confirmed") { result.reasons.push("Process cleanup unconfirmed"); if (result.verdict === "passed") result.verdict = "incomplete"; }
			if (signal?.aborted || cancelFailed) { result.reasons.push(cancelFailed ? "Cancellation request could not be recorded" : "Verification was interrupted"); if (result.verdict === "passed") result.verdict = "canceled"; }
			boundResult(result);
			this.results.set(job.id, structuredClone(result));
			while (this.results.size > 100) this.results.delete(this.results.keys().next().value!);
			return result;
		} finally { signal?.removeEventListener("abort", cancel); this.active.delete(job.id); }
	}
	async result(cwd: string, id: string): Promise<VerificationResult> {
		const saved = this.results.get(id);
		if (!saved || saved.project !== fs.realpathSync(cwd)) throw new Error("Unknown verification result in this runtime/project");
		const result = structuredClone(saved);
		const stale = (why: string) => { result.reasons.push(why); if (result.verdict === "passed") result.verdict = "stale"; };
		result.source.current = await fingerprint(result.project, result.check.inputs);
		if (result.source.current.status !== "known") {
			result.source.status = "unknown"; result.reasons.push("Current source identity unknown");
			if (result.verdict === "passed") result.verdict = "incomplete";
		} else if (result.source.current.sha256 !== result.source.after.sha256) { result.source.status = "stale"; stale("Declared inputs changed since verification"); }
		try { if ((await loadConfig(result.project)).sha256 !== result.configSha256) stale("Config changed since verification"); }
		catch { stale("Config unavailable since verification"); }
		try {
			const current = this.runner.store.read(id);
			if (!current || JSON.stringify(current) !== JSON.stringify(result.process)) stale("Command evidence changed or expired");
			if (result.artifacts.reportSha256) {
				const reportFile = result.check.report.path === "stdout" ? result.artifacts.report! : projectPath(result.project, path.relative(result.project, result.artifacts.report!));
				if (await digest(boundedRead(reportFile, LIMITS.reportBytes)) !== result.artifacts.reportSha256) stale("Report changed since verification");
			}
		} catch { stale("Command/report evidence unavailable since verification"); }
		return boundResult(result);
	}
	async close(): Promise<void> {
		this.closing = true;
		this.shutdownSignal.abort();
		await Promise.allSettled([...this.active].map(([id, project]) => this.runner.store.cancel(id, project)));
		await Promise.allSettled([...this.pending]);
	}
}
