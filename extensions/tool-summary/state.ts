import {
	DEFAULT_HIGH_FIDELITY_THRESHOLD,
	DEFAULT_STANDARD_THRESHOLD,
	POLICY_VERSION,
	SUMMARY_HARD_MAX_CHARS,
	replacementIsWorthwhile,
} from "./policy.ts";

export const TOOL_SUMMARY_CONFIG_TYPE = "pi-tool-summary-config";
export const TOOL_SUMMARY_EXPOSURE_TYPE = "pi-tool-summary-exposure";
export const TOOL_SUMMARY_COMPLETE_TYPE = "pi-tool-summary-complete";
export const TOOL_SUMMARY_SKIP_TYPE = "pi-tool-summary-skip";

export type ToolSummaryMode = "on" | "pause" | "off";

export type ToolSummaryConfig = {
	version: 1;
	mode: ToolSummaryMode;
	standardThreshold: number;
	highFidelityThreshold: number;
	epoch: string;
	updatedAt: number;
};

export type ExposureRecord = {
	version: 1;
	epoch: string;
	key: string;
	toolCallId: string;
	toolName: string;
	rawHash: string;
	policyVersion: typeof POLICY_VERSION;
	exposedAt: number;
};

export type CompletedSummaryRecord = {
	version: 1;
	epoch: string;
	key: string;
	toolCallId: string;
	toolName: string;
	rawHash: string;
	rawChars: number;
	rawLines: number;
	policyVersion: typeof POLICY_VERSION;
	replacement: string;
	source: "model" | "deterministic" | "deterministic-fallback";
	model?: { provider: string; id: string };
	createdAt: number;
};

export type SkippedSummaryRecord = {
	version: 1;
	epoch: string;
	key: string;
	toolCallId: string;
	toolName: string;
	rawHash: string;
	rawChars: number;
	policyVersion: typeof POLICY_VERSION;
	reason: "not-worthwhile";
	createdAt: number;
};

export type CustomEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

export type RestoredToolSummaryState = {
	config: ToolSummaryConfig;
	exposures: Map<string, ExposureRecord>;
	summaries: Map<string, CompletedSummaryRecord>;
	skips: Map<string, SkippedSummaryRecord>;
};

export function defaultToolSummaryConfig(timestamp = Date.now()): ToolSummaryConfig {
	return {
		version: 1,
		mode: "on",
		standardThreshold: DEFAULT_STANDARD_THRESHOLD,
		highFidelityThreshold: DEFAULT_HIGH_FIDELITY_THRESHOLD,
		epoch: "initial",
		updatedAt: timestamp,
	};
}

function isPositiveInteger(value: unknown) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isToolSummaryConfig(value: unknown): value is ToolSummaryConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as Partial<ToolSummaryConfig>;
	return (
		config.version === 1 &&
		(config.mode === "on" || config.mode === "pause" || config.mode === "off") &&
		isPositiveInteger(config.standardThreshold) &&
		isPositiveInteger(config.highFidelityThreshold) &&
		config.standardThreshold <= config.highFidelityThreshold &&
		typeof config.epoch === "string" &&
		config.epoch.length > 0 &&
		typeof config.updatedAt === "number" &&
		Number.isFinite(config.updatedAt)
	);
}

export function isExposureRecord(value: unknown): value is ExposureRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ExposureRecord>;
	return (
		record.version === 1 &&
		typeof record.epoch === "string" &&
		typeof record.key === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.toolName === "string" &&
		/^[a-f0-9]{64}$/.test(record.rawHash ?? "") &&
		record.policyVersion === POLICY_VERSION &&
		typeof record.exposedAt === "number" &&
		Number.isFinite(record.exposedAt)
	);
}

export function isCompletedSummaryRecord(value: unknown): value is CompletedSummaryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CompletedSummaryRecord>;
	return (
		record.version === 1 &&
		typeof record.epoch === "string" &&
		typeof record.key === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.toolName === "string" &&
		/^[a-f0-9]{64}$/.test(record.rawHash ?? "") &&
		isPositiveInteger(record.rawChars) &&
		isPositiveInteger(record.rawLines) &&
		record.policyVersion === POLICY_VERSION &&
		typeof record.replacement === "string" &&
		record.replacement.length > 0 &&
		record.replacement.length <= SUMMARY_HARD_MAX_CHARS &&
		replacementIsWorthwhile(record.rawChars, record.replacement) &&
		(record.source === "model" ||
			record.source === "deterministic" ||
			record.source === "deterministic-fallback") &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt) &&
		(record.model === undefined ||
			(typeof record.model.provider === "string" && typeof record.model.id === "string"))
	);
}

export function isSkippedSummaryRecord(value: unknown): value is SkippedSummaryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SkippedSummaryRecord>;
	return (
		record.version === 1 &&
		typeof record.epoch === "string" &&
		typeof record.key === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.toolName === "string" &&
		/^[a-f0-9]{64}$/.test(record.rawHash ?? "") &&
		isPositiveInteger(record.rawChars) &&
		record.policyVersion === POLICY_VERSION &&
		record.reason === "not-worthwhile" &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt)
	);
}

export function restoreToolSummaryState(entries: readonly CustomEntryLike[]): RestoredToolSummaryState {
	let config = defaultToolSummaryConfig(0);
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === TOOL_SUMMARY_CONFIG_TYPE &&
			isToolSummaryConfig(entry.data)
		) {
			config = { ...entry.data };
		}
	}

	const exposures = new Map<string, ExposureRecord>();
	const summaries = new Map<string, CompletedSummaryRecord>();
	const skips = new Map<string, SkippedSummaryRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (
			entry.customType === TOOL_SUMMARY_EXPOSURE_TYPE &&
			isExposureRecord(entry.data) &&
			entry.data.epoch === config.epoch &&
			!exposures.has(entry.data.key)
		) {
			exposures.set(entry.data.key, { ...entry.data });
			continue;
		}
		if (
			entry.customType === TOOL_SUMMARY_COMPLETE_TYPE &&
			isCompletedSummaryRecord(entry.data) &&
			entry.data.epoch === config.epoch &&
			!summaries.has(entry.data.key) &&
			!skips.has(entry.data.key)
		) {
			// First valid terminal outcome wins. Later entries cannot churn a frozen summary.
			summaries.set(entry.data.key, {
				...entry.data,
				model: entry.data.model ? { ...entry.data.model } : undefined,
			});
			continue;
		}
		if (
			entry.customType === TOOL_SUMMARY_SKIP_TYPE &&
			isSkippedSummaryRecord(entry.data) &&
			entry.data.epoch === config.epoch &&
			!summaries.has(entry.data.key) &&
			!skips.has(entry.data.key)
		) {
			skips.set(entry.data.key, { ...entry.data });
		}
	}
	return { config, exposures, summaries, skips };
}

export function makeExposureRecord(
	config: ToolSummaryConfig,
	input: Pick<ExposureRecord, "key" | "toolCallId" | "toolName" | "rawHash">,
	timestamp = Date.now(),
): ExposureRecord {
	return {
		version: 1,
		epoch: config.epoch,
		key: input.key,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		rawHash: input.rawHash,
		policyVersion: POLICY_VERSION,
		exposedAt: timestamp,
	};
}

export function makeCompletedSummaryRecord(
	config: ToolSummaryConfig,
	input: Omit<CompletedSummaryRecord, "version" | "epoch" | "policyVersion" | "createdAt">,
	timestamp = Date.now(),
): CompletedSummaryRecord {
	return {
		version: 1,
		epoch: config.epoch,
		key: input.key,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		rawHash: input.rawHash,
		rawChars: input.rawChars,
		rawLines: input.rawLines,
		replacement: input.replacement,
		source: input.source,
		model: input.model ? { ...input.model } : undefined,
		policyVersion: POLICY_VERSION,
		createdAt: timestamp,
	};
}

export function makeSkippedSummaryRecord(
	config: ToolSummaryConfig,
	input: Pick<
		SkippedSummaryRecord,
		"key" | "toolCallId" | "toolName" | "rawHash" | "rawChars"
	>,
	timestamp = Date.now(),
): SkippedSummaryRecord {
	return {
		version: 1,
		epoch: config.epoch,
		key: input.key,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		rawHash: input.rawHash,
		rawChars: input.rawChars,
		policyVersion: POLICY_VERSION,
		reason: "not-worthwhile",
		createdAt: timestamp,
	};
}

export function updatedConfig(
	config: ToolSummaryConfig,
	patch: Partial<Pick<ToolSummaryConfig, "mode" | "standardThreshold" | "highFidelityThreshold" | "epoch">>,
	timestamp = Date.now(),
): ToolSummaryConfig {
	return { ...config, ...patch, version: 1, updatedAt: timestamp };
}

export function estimatedContextSavings(summaries: Iterable<CompletedSummaryRecord>) {
	let rawChars = 0;
	let replacementChars = 0;
	let count = 0;
	for (const summary of summaries) {
		rawChars += summary.rawChars;
		replacementChars += summary.replacement.length;
		count += 1;
	}
	return { count, rawChars, replacementChars, savedChars: Math.max(0, rawChars - replacementChars) };
}
