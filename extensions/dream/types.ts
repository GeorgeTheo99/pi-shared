// Duplicated from memory extension (not exported there)
export type ProjectInfo = {
	id: string;
	name: string;
	root: string;
	remote?: string;
	firstSeenAt: string;
	lastSeenAt: string;
};

export type Confidence = "low" | "medium" | "high";

// --- Session reading types ---

export type SessionEvent = {
	type: "session" | "message" | "model_change" | "thinking_level_change" | "compaction" | string;
	id?: string;
	parentId?: string | null;
	timestamp: string;
	// session header fields
	version?: number;
	cwd?: string;
	// message fields
	message?: SessionMessage;
	// model_change fields
	provider?: string;
	modelId?: string;
	// thinking_level_change fields
	thinkingLevel?: string;
};

export type SessionMessage = {
	role: "user" | "assistant" | "toolResult" | string;
	content: SessionContentBlock[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
	model?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
};

export type SessionContentBlock = {
	type: "text" | "thinking" | "toolCall" | string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	name?: string;
	id?: string;
	arguments?: unknown;
};

export type CondensedSession = {
	id: string;
	timestamp: string;
	cwd: string;
	model?: string;
	totalCost: number;
	messageCount: number;
	condensed: string;
};

// --- Dream subagent result ---

export type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

export type DreamAgentResult = {
	success: boolean;
	output: string;
	usage: UsageStats;
	error?: string;
};

// --- Project dream types ---

export type ProposalStatus = "pending" | "applied" | "dismissed";

export type ProjectDreamProposal = {
	id: string;
	action: "add" | "update" | "archive" | "merge";
	targetMemoryId?: string;
	mergeSourceIds?: string[];
	proposedText?: string;
	proposedTags?: string[];
	reason: string;
	evidence: string[];
	confidence: Confidence;
	status: ProposalStatus;
};

export type ProjectDreamRun = {
	id: string;
	timestamp: string;
	projectId: string;
	projectName: string;
	sessionsAnalyzed: number;
	model: string;
	proposals: ProjectDreamProposal[];
	summary: string;
};

export type ProjectDreamStore = {
	version: 1;
	project: ProjectInfo;
	runs: ProjectDreamRun[];
};

// --- Meta dream types ---

export type MetaDreamProposal = {
	id: string;
	problem: string;
	evidence: Array<{ project: string; sessionRef: string; quote: string }>;
	affectedResource: string;
	proposedFix: string;
	riskLevel: Confidence;
	changeType: "code" | "docs" | "skill" | "prompt" | "config";
	status: ProposalStatus;
};

export type MetaDreamRun = {
	id: string;
	timestamp: string;
	sessionsAnalyzed: number;
	projectsAnalyzed: string[];
	model: string;
	proposals: MetaDreamProposal[];
	summary: string;
};

export type MetaDreamStore = {
	version: 1;
	runs: MetaDreamRun[];
};

// --- Raw dream agent output shapes (before ID assignment) ---

export type RawProjectProposal = {
	action: "add" | "update" | "archive" | "merge";
	targetMemoryId?: string;
	mergeSourceIds?: string[];
	proposedText?: string;
	proposedTags?: string[];
	reason: string;
	evidence: string[];
	confidence: Confidence;
};

export type RawProjectDreamOutput = {
	summary: string;
	proposals: RawProjectProposal[];
};

export type RawMetaProposal = {
	problem: string;
	evidence: Array<{ project: string; sessionRef: string; quote: string }>;
	affectedResource: string;
	proposedFix: string;
	riskLevel: Confidence;
	changeType: "code" | "docs" | "skill" | "prompt" | "config";
};

export type RawMetaDreamOutput = {
	summary: string;
	proposals: RawMetaProposal[];
};
