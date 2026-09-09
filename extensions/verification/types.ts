import type { CommandRecord } from "../_shared/command-job-store.ts";

export interface InputScope {
	/** Literal project-relative files/directories, not globs. */
	paths: string[];
	exclude: string[];
	/** Include all scoped filesystem inputs, even ignored/untracked files. */
	untracked: "include";
}
export interface Check {
	id: string;
	command: string;
	args: string[];
	cwd: string;
	timeoutSeconds: number;
	inputs?: InputScope;
	report: { format: "exit" | "tap" | "junit"; path?: string };
	discovery?: { allowZero: boolean; minTests?: number };
}
export interface VerificationConfig { version: 1; checks: Check[] }
export interface Counts { total: number; passed: number; failed: number; skipped: number }
export interface ParsedReport {
	adapter: string;
	counts: Counts;
	failures: { name: string; file?: string; line?: number }[];
	failuresOmitted: number;
	limitations: string[];
}
export interface Fingerprint {
	status: "known" | "unknown";
	sha256?: string;
	files: number;
	bytes: number;
	reason?: string;
}
export type Verdict = "passed" | "failed" | "error" | "incomplete" | "stale" | "canceled";
export interface VerificationResult {
	version: 1;
	id: string;
	project: string;
	check: Check;
	configSha256: string;
	command: string;
	args: string[];
	cwd: string;
	startedAt: number;
	finishedAt: number;
	verdict: Verdict;
	reasons: string[];
	process?: CommandRecord;
	report?: ParsedReport;
	artifacts: { stdout?: string; stderr?: string; report?: string; reportSha256?: string };
	source: { status: "unchanged" | "stale" | "unknown"; before: Fingerprint; after: Fingerprint; current?: Fingerprint };
	toolchain: { verifierNode: string; platform: string; executableVersion: "unknown" };
	limitations: string[];
}
export const LIMITS = { configBytes: 65536, reportBytes: 2 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, sourceBytes: 64 * 1024 * 1024, entries: 20000, files: 10000, fingerprintMs: 5000, tests: 100000, failures: 20 };
export const digest = async (value: string | Buffer): Promise<string> => {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(value).digest("hex");
};
