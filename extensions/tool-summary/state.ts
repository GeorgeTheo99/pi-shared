import {
	DEFAULT_HIGH_FIDELITY_THRESHOLD,
	DEFAULT_IMAGE_RETENTION,
	DEFAULT_STANDARD_THRESHOLD,
	isValidImageRetention,
	POLICY_VERSION,
	SUMMARY_HARD_MAX_CHARS,
	replacementIsWorthwhile,
} from "./policy.ts";

export const TOOL_SUMMARY_CONFIG_TYPE = "pi-tool-summary-config";
export const TOOL_SUMMARY_EXPOSURE_TYPE = "pi-tool-summary-exposure";
export const TOOL_SUMMARY_COMPLETE_TYPE = "pi-tool-summary-complete";
export const TOOL_SUMMARY_RETRY_TYPE = "pi-tool-summary-retry";
export const TOOL_SUMMARY_SKIP_TYPE = "pi-tool-summary-skip";

const LEGACY_DEFAULT_STANDARD_THRESHOLD = 8_000;
const LEGACY_DEFAULT_HIGH_FIDELITY_THRESHOLD = 16_000;

export type ToolSummaryMode = "on" | "pause" | "off";

export type ToolSummaryConfig = {
	version: 1;
	mode: ToolSummaryMode;
	standardThreshold: number;
	highFidelityThreshold: number;
	/** Newest tool-result images kept in provider context; -1 disables aging. */
	imageRetention: number;
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
	source: "model" | "deterministic";
	model?: { provider: string; id: string };
	createdAt: number;
};

export type SummaryRetryRecord = {
	version: 1;
	epoch: string;
	key: string;
	toolCallId: string;
	toolName: string;
	rawHash: string;
	policyVersion: typeof POLICY_VERSION;
	attempt: number;
	failedAt: number;
	retryAfter: number;
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
	reason: "not-worthwhile" | "required-evidence-overflow";
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
	retries: Map<string, SummaryRetryRecord>;
	skips: Map<string, SkippedSummaryRecord>;
};

export function defaultToolSummaryConfig(timestamp = Date.now()): ToolSummaryConfig {
	return {
		version: 1,
		mode: "on",
		standardThreshold: DEFAULT_STANDARD_THRESHOLD,
		highFidelityThreshold: DEFAULT_HIGH_FIDELITY_THRESHOLD,
		imageRetention: DEFAULT_IMAGE_RETENTION,
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
		(config.imageRetention === undefined || isValidImageRetention(config.imageRetention)) &&
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
		(record.source === "model" || record.source === "deterministic") &&
		typeof record.createdAt === "number" &&
		Number.isFinite(record.createdAt) &&
		(record.model === undefined ||
			(typeof record.model.provider === "string" && typeof record.model.id === "string"))
	);
}

export function isSummaryRetryRecord(value: unknown): value is SummaryRetryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SummaryRetryRecord>;
	return (
		record.version === 1 &&
		typeof record.epoch === "string" &&
		typeof record.key === "string" &&
		typeof record.toolCallId === "string" &&
		typeof record.toolName === "string" &&
		/^[a-f0-9]{64}$/.test(record.rawHash ?? "") &&
		record.policyVersion === POLICY_VERSION &&
		isPositiveInteger(record.attempt) &&
		typeof record.failedAt === "number" &&
		Number.isFinite(record.failedAt) &&
		typeof record.retryAfter === "number" &&
		Number.isFinite(record.retryAfter) &&
		record.retryAfter >= record.failedAt
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
		(record.reason === "not-worthwhile" || record.reason === "required-evidence-overflow") &&
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
			config = {
				...entry.data,
				imageRetention: isValidImageRetention(entry.data.imageRetention)
					? entry.data.imageRetention
					: DEFAULT_IMAGE_RETENTION,
			};
		}
	}
	if (
		config.standardThreshold === LEGACY_DEFAULT_STANDARD_THRESHOLD &&
		config.highFidelityThreshold === LEGACY_DEFAULT_HIGH_FIDELITY_THRESHOLD
	) {
		config = {
			...config,
			standardThreshold: DEFAULT_STANDARD_THRESHOLD,
			highFidelityThreshold: DEFAULT_HIGH_FIDELITY_THRESHOLD,
		};
	}

	const exposures = new Map<string, ExposureRecord>();
	const summaries = new Map<string, CompletedSummaryRecord>();
	const retries = new Map<string, SummaryRetryRecord>();
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
			retries.delete(entry.data.key);
			continue;
		}
		if (
			entry.customType === TOOL_SUMMARY_RETRY_TYPE &&
			isSummaryRetryRecord(entry.data) &&
			entry.data.epoch === config.epoch &&
			!summaries.has(entry.data.key) &&
			!skips.has(entry.data.key)
		) {
			const previous = retries.get(entry.data.key);
			if (!previous || entry.data.failedAt >= previous.failedAt) {
				retries.set(entry.data.key, { ...entry.data });
			}
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
			retries.delete(entry.data.key);
		}
	}
	return { config, exposures, summaries, retries, skips };
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

export function makeSummaryRetryRecord(
	config: ToolSummaryConfig,
	input: Pick<SummaryRetryRecord, "key" | "toolCallId" | "toolName" | "rawHash" | "attempt" | "retryAfter">,
	timestamp = Date.now(),
): SummaryRetryRecord {
	return {
		version: 1,
		epoch: config.epoch,
		key: input.key,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		rawHash: input.rawHash,
		policyVersion: POLICY_VERSION,
		attempt: input.attempt,
		failedAt: timestamp,
		retryAfter: input.retryAfter,
	};
}

export function makeSkippedSummaryRecord(
	config: ToolSummaryConfig,
	input: Pick<
		SkippedSummaryRecord,
		"key" | "toolCallId" | "toolName" | "rawHash" | "rawChars"
	> & { reason?: SkippedSummaryRecord["reason"] },
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
		reason: input.reason ?? "not-worthwhile",
		createdAt: timestamp,
	};
}

export function updatedConfig(
	config: ToolSummaryConfig,
	patch: Partial<Pick<ToolSummaryConfig, "mode" | "standardThreshold" | "highFidelityThreshold" | "imageRetention" | "epoch">>,
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
