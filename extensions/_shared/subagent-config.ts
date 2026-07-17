import os from "node:os";
import path from "node:path";

export const DEFAULT_SUBAGENT_MAX_FANOUT = 16;
export const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 8;
export const DEFAULT_SUBAGENT_MAX_BACKGROUND_JOBS = 8;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
export const DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_RUN_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_SUBAGENT_TERM_GRACE_MS = 5 * 1000;
export const DEFAULT_SUBAGENT_MAX_CAPTURE_BYTES = 1024 * 1024;
export const DEFAULT_SUBAGENT_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_SUBAGENT_MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SUBAGENT_MAX_TASK_BYTES = 256 * 1024;
export const DEFAULT_SUBAGENT_HEARTBEAT_MS = 5 * 1000;
export const DEFAULT_SUBAGENT_LEASE_MS = 60 * 1000;
export const DEFAULT_SUBAGENT_BACKGROUND_AGING_MS = 60 * 1000;

export interface SubagentConfig {
	maxFanout: number;
	maxConcurrency: number;
	maxBackgroundJobs: number;
	maxDepth: number;
	depth: number;
	queueTimeoutMs: number;
	runTimeoutMs: number;
	termGraceMs: number;
	maxCaptureBytes: number;
	maxStderrBytes: number;
	maxEventBytes: number;
	maxTaskBytes: number;
	heartbeatMs: number;
	leaseMs: number;
	backgroundAgingMs: number;
	resourceLimits: Record<string, number>;
	stateDir: string;
	errors: string[];
}

type Env = Record<string, string | undefined>;

function parseInteger(
	env: Env,
	name: string,
	fallback: number,
	min: number,
	max: number,
	errors: string[],
): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) {
		errors.push(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}.`);
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		errors.push(`${name} must be between ${min} and ${max}; received ${JSON.stringify(raw)}.`);
		return fallback;
	}
	return value;
}

function expandTilde(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function parseResourceLimits(env: Env, errors: string[]): Record<string, number> {
	const raw = env.PI_SUBAGENT_RESOURCE_LIMITS?.trim();
	if (!raw) return {};
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		errors.push("PI_SUBAGENT_RESOURCE_LIMITS must be a JSON object such as {\"openai-codex\":4}.");
		return {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push("PI_SUBAGENT_RESOURCE_LIMITS must be a JSON object.");
		return {};
	}
	const limits: Record<string, number> = {};
	for (const [key, limit] of Object.entries(value)) {
		if (!/^[A-Za-z0-9._:-]{1,100}$/.test(key)) {
			errors.push(`PI_SUBAGENT_RESOURCE_LIMITS has an invalid resource key: ${JSON.stringify(key)}.`);
			continue;
		}
		if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 32) {
			errors.push(`PI_SUBAGENT_RESOURCE_LIMITS.${key} must be an integer between 1 and 32.`);
			continue;
		}
		limits[key] = Number(limit);
	}
	return limits;
}

export function loadSubagentConfig(env: Env = process.env): SubagentConfig {
	const errors: string[] = [];
	const maxFanout = parseInteger(env, "PI_SUBAGENT_MAX_FANOUT", DEFAULT_SUBAGENT_MAX_FANOUT, 1, 64, errors);
	const maxConcurrency = parseInteger(
		env,
		"PI_SUBAGENT_MAX_CONCURRENCY",
		DEFAULT_SUBAGENT_MAX_CONCURRENCY,
		1,
		32,
		errors,
	);
	const maxBackgroundJobs = parseInteger(
		env,
		"PI_SUBAGENT_MAX_BACKGROUND_JOBS",
		DEFAULT_SUBAGENT_MAX_BACKGROUND_JOBS,
		1,
		64,
		errors,
	);
	const maxDepth = parseInteger(env, "PI_SUBAGENT_MAX_DEPTH", DEFAULT_SUBAGENT_MAX_DEPTH, 0, 8, errors);
	const depth = parseInteger(env, "PI_SUBAGENT_DEPTH", 0, 0, 32, errors);
	const queueTimeoutMs = parseInteger(
		env,
		"PI_SUBAGENT_QUEUE_TIMEOUT_MS",
		DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS,
		1000,
		24 * 60 * 60 * 1000,
		errors,
	);
	const runTimeoutMs = parseInteger(
		env,
		"PI_SUBAGENT_RUN_TIMEOUT_MS",
		DEFAULT_SUBAGENT_RUN_TIMEOUT_MS,
		1000,
		24 * 60 * 60 * 1000,
		errors,
	);
	const termGraceMs = parseInteger(
		env,
		"PI_SUBAGENT_TERM_GRACE_MS",
		DEFAULT_SUBAGENT_TERM_GRACE_MS,
		100,
		60 * 1000,
		errors,
	);
	const maxCaptureBytes = parseInteger(
		env,
		"PI_SUBAGENT_MAX_CAPTURE_BYTES",
		DEFAULT_SUBAGENT_MAX_CAPTURE_BYTES,
		64 * 1024,
		16 * 1024 * 1024,
		errors,
	);
	const maxStderrBytes = parseInteger(
		env,
		"PI_SUBAGENT_MAX_STDERR_BYTES",
		DEFAULT_SUBAGENT_MAX_STDERR_BYTES,
		4 * 1024,
		4 * 1024 * 1024,
		errors,
	);
	const maxEventBytes = parseInteger(
		env,
		"PI_SUBAGENT_MAX_EVENT_BYTES",
		DEFAULT_SUBAGENT_MAX_EVENT_BYTES,
		64 * 1024,
		32 * 1024 * 1024,
		errors,
	);
	const maxTaskBytes = parseInteger(
		env,
		"PI_SUBAGENT_MAX_TASK_BYTES",
		DEFAULT_SUBAGENT_MAX_TASK_BYTES,
		4 * 1024,
		4 * 1024 * 1024,
		errors,
	);
	const heartbeatMs = parseInteger(
		env,
		"PI_SUBAGENT_HEARTBEAT_MS",
		DEFAULT_SUBAGENT_HEARTBEAT_MS,
		1000,
		60 * 1000,
		errors,
	);
	const leaseMs = parseInteger(
		env,
		"PI_SUBAGENT_LEASE_MS",
		DEFAULT_SUBAGENT_LEASE_MS,
		10 * 1000,
		10 * 60 * 1000,
		errors,
	);
	const backgroundAgingMs = parseInteger(
		env,
		"PI_SUBAGENT_BACKGROUND_AGING_MS",
		DEFAULT_SUBAGENT_BACKGROUND_AGING_MS,
		100,
		60 * 60 * 1000,
		errors,
	);
	const resourceLimits = parseResourceLimits(env, errors);
	if (leaseMs < heartbeatMs * 3) {
		errors.push("PI_SUBAGENT_LEASE_MS must be at least three times PI_SUBAGENT_HEARTBEAT_MS.");
	}

	const configuredStateDir = env.PI_SUBAGENT_STATE_DIR || env.PI_SPAWN_SUBAGENT_DIR;
	const stateDir = path.resolve(
		expandTilde(configuredStateDir?.trim() || path.join(os.homedir(), ".pi", "agent", "spawn-subagent")),
	);

	return {
		maxFanout,
		maxConcurrency,
		maxBackgroundJobs,
		maxDepth,
		depth,
		queueTimeoutMs,
		runTimeoutMs,
		termGraceMs,
		maxCaptureBytes,
		maxStderrBytes,
		maxEventBytes,
		maxTaskBytes,
		heartbeatMs,
		leaseMs,
		backgroundAgingMs,
		resourceLimits,
		stateDir,
		errors,
	};
}

export function canSpawnSubagent(config: SubagentConfig): boolean {
	return config.errors.length === 0 && config.depth < config.maxDepth;
}

export function subagentConfigError(config: SubagentConfig): string | undefined {
	if (config.errors.length === 0) return undefined;
	return `Invalid subagent configuration:\n- ${config.errors.join("\n- ")}`;
}

export function formatSubagentLimits(config: SubagentConfig): string {
	const resources = Object.entries(config.resourceLimits)
		.map(([key, limit]) => `${key}:${limit}`)
		.join(", ");
	return `fan-out ${config.maxFanout}, host concurrency ${config.maxConcurrency}${resources ? `, resource pools ${resources}` : ""}, background jobs ${config.maxBackgroundJobs}, depth ${config.depth}/${config.maxDepth}`;
}
