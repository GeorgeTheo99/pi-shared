import { StringEnum, Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	applyProjectProposal,
	detectProjectForDream,
	dismissMetaProposal,
	dismissProjectProposal,
	formatDreamRunSummary,
	formatMetaProposal,
	formatProjectProposal,
	makeDreamProposalId,
	makeDreamRunId,
	makeMetaDreamRunId,
	makeMetaProposalId,
	nowIso,
	readAllProjectMemories,
	readCurrentMemories,
	readMetaDreamStore,
	readProjectDreamStore,
	saveMetaDreamRun,
	saveDreamRun,
	type ProjectLocation,
} from "./store.js";
import { formatSessionsForPrompt, getAllProjectSessions, getProjectSessions } from "./session-reader.js";
import { parseDreamOutput, spawnDreamAgent } from "./subagent.js";
import type {
	MetaDreamProposal,
	MetaDreamRun,
	ProjectDreamProposal,
	ProjectDreamRun,
	RawMetaDreamOutput,
	RawProjectDreamOutput,
} from "./types.js";

// --- Orchestration ---

async function runProjectDream(
	location: ProjectLocation,
	sessionLimit: number,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<{ content: string; proposals: ProjectDreamProposal[] }> {
	onProgress(`Dream analysis starting for project "${location.project.name}"...`);

	const sessions = getProjectSessions(location.project.root, sessionLimit);
	if (sessions.length === 0) {
		return { content: "No sessions found for this project. Nothing to dream about.", proposals: [] };
	}

	const currentMemories = readCurrentMemories(location);
	const sessionsText = formatSessionsForPrompt(sessions);

	const task = `Analyze these session transcripts and current memory for project "${location.project.name}" (root: ${location.project.root}).

## Current Project Memory
${currentMemories}

## Session Transcripts (${sessions.length} sessions)
${sessionsText}`;

	onProgress(`Spawning dream agent... (${sessions.length} sessions, ${task.length} chars)`);

	const result = await spawnDreamAgent({
		agentName: "project-dreamer",
		task,
		cwd: location.project.root,
		model,
		signal,
		onProgress: (text) => onProgress(`Dream agent: ${text}`),
	});

	if (!result.success) {
		return { content: `Dream agent failed: ${result.error || "unknown error"}`, proposals: [] };
	}

	const parsed = parseDreamOutput<RawProjectDreamOutput>(result.output);
	if (!parsed || !Array.isArray(parsed.proposals)) {
		return { content: `Dream agent returned unparseable output. Raw output:\n${result.output.slice(0, 2000)}`, proposals: [] };
	}

	// Assign IDs and default status
	const proposals: ProjectDreamProposal[] = parsed.proposals.slice(0, 10).map((raw) => ({
		...raw,
		id: makeDreamProposalId(),
		status: "pending" as const,
	}));

	const run: ProjectDreamRun = {
		id: makeDreamRunId(),
		timestamp: nowIso(),
		projectId: location.project.id,
		projectName: location.project.name,
		sessionsAnalyzed: sessions.length,
		model: model || "default",
		proposals,
		summary: parsed.summary || "No summary provided",
	};

	await saveDreamRun(location, run);

	const proposalList = proposals.length
		? proposals.map(formatProjectProposal).join("\n\n")
		: "No proposals generated.";

	const content = `## Dream Analysis Complete

**Project:** ${location.project.name}
**Sessions analyzed:** ${sessions.length}
**Proposals:** ${proposals.length}
**Cost:** $${result.usage.cost.toFixed(4)} (${result.usage.turns} turns)

### Summary
${run.summary}

### Proposals
${proposalList}

Use \`/dream apply <id>\` to apply a proposal or \`/dream dismiss <id>\` to dismiss it.`;

	return { content, proposals };
}

async function runMetaDream(
	sessionLimit: number,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<{ content: string; proposals: MetaDreamProposal[] }> {
	onProgress("Meta-dream analysis starting across all projects...");

	const allSessions = getAllProjectSessions(sessionLimit);
	if (allSessions.size === 0) {
		return { content: "No sessions found across any projects. Nothing to dream about.", proposals: [] };
	}

	const allMemories = readAllProjectMemories();

	// Build task with cross-project context
	let totalSessions = 0;
	const projectSections: string[] = [];
	const projectNames: string[] = [];

	for (const [cwd, sessions] of allSessions) {
		totalSessions += sessions.length;
		const projectName = cwd.split("/").pop() || cwd;
		projectNames.push(projectName);

		const memoryEntry = allMemories.get(projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"));
		const memories = memoryEntry ? memoryEntry.memories : "No memories";

		projectSections.push(`## Project: ${projectName} (${cwd})

### Memories
${memories}

### Sessions (${sessions.length})
${formatSessionsForPrompt(sessions)}`);
	}

	const task = `Analyze session transcripts across ${projectNames.length} projects to identify systemic Pi tooling friction and improvement opportunities.

${projectSections.join("\n\n---\n\n")}`;

	onProgress(`Spawning meta-dream agent... (${projectNames.length} projects, ${totalSessions} sessions)`);

	const result = await spawnDreamAgent({
		agentName: "meta-dreamer",
		task,
		cwd: process.cwd(),
		model,
		signal,
		onProgress: (text) => onProgress(`Meta-dream agent: ${text}`),
	});

	if (!result.success) {
		return { content: `Meta-dream agent failed: ${result.error || "unknown error"}`, proposals: [] };
	}

	const parsed = parseDreamOutput<RawMetaDreamOutput>(result.output);
	if (!parsed || !Array.isArray(parsed.proposals)) {
		return { content: `Meta-dream agent returned unparseable output. Raw output:\n${result.output.slice(0, 2000)}`, proposals: [] };
	}

	const proposals: MetaDreamProposal[] = parsed.proposals.slice(0, 8).map((raw) => ({
		...raw,
		id: makeMetaProposalId(),
		status: "pending" as const,
	}));

	const run: MetaDreamRun = {
		id: makeMetaDreamRunId(),
		timestamp: nowIso(),
		sessionsAnalyzed: totalSessions,
		projectsAnalyzed: projectNames,
		model: model || "default",
		proposals,
		summary: parsed.summary || "No summary provided",
	};

	await saveMetaDreamRun(run);

	const proposalList = proposals.length
		? proposals.map(formatMetaProposal).join("\n\n")
		: "No proposals generated.";

	const content = `## Meta-Dream Analysis Complete

**Projects analyzed:** ${projectNames.join(", ")}
**Sessions analyzed:** ${totalSessions}
**Proposals:** ${proposals.length}
**Cost:** $${result.usage.cost.toFixed(4)} (${result.usage.turns} turns)

### Summary
${run.summary}

### Proposals
${proposalList}

Use \`/dream dismiss <id>\` to dismiss a meta-proposal. Meta-proposals for pi-shared changes should be reviewed and applied manually.`;

	return { content, proposals };
}

function reviewProjectDream(location: ProjectLocation): string {
	const store = readProjectDreamStore(location.dreamStorePath, location.project);
	if (store.runs.length === 0) return "No dream runs found for this project. Run `/dream` first.";

	const latestRun = store.runs[store.runs.length - 1];
	const pending = latestRun.proposals.filter((p) => p.status === "pending");

	if (pending.length === 0) {
		return `Latest dream run (${latestRun.timestamp}): all ${latestRun.proposals.length} proposals have been resolved.\n\nSummary: ${latestRun.summary}`;
	}

	const list = pending.map((p, i) => formatProjectProposal(p, i)).join("\n\n");
	return `## Pending Dream Proposals (run: ${latestRun.timestamp})

Summary: ${latestRun.summary}
Pending: ${pending.length} of ${latestRun.proposals.length}

${list}

Use \`/dream apply <id>\` to apply or \`/dream dismiss <id>\` to dismiss.`;
}

function reviewMetaDream(): string {
	const store = readMetaDreamStore();
	if (store.runs.length === 0) return "No meta-dream runs found. Run `/dream meta` first.";

	const latestRun = store.runs[store.runs.length - 1];
	const pending = latestRun.proposals.filter((p) => p.status === "pending");

	if (pending.length === 0) {
		return `Latest meta-dream run (${latestRun.timestamp}): all ${latestRun.proposals.length} proposals have been resolved.\n\nSummary: ${latestRun.summary}`;
	}

	const list = pending.map((p, i) => formatMetaProposal(p, i)).join("\n\n");
	return `## Pending Meta-Dream Proposals (run: ${latestRun.timestamp})

Summary: ${latestRun.summary}
Pending: ${pending.length} of ${latestRun.proposals.length}
Projects: ${latestRun.projectsAnalyzed.join(", ")}

${list}

Meta-proposals suggest pi-shared changes. Review and apply manually, or \`/dream dismiss <id>\` to dismiss.`;
}

function dreamHistory(location: ProjectLocation, scope: "project" | "meta"): string {
	if (scope === "meta") {
		const store = readMetaDreamStore();
		if (store.runs.length === 0) return "No meta-dream runs found.";
		return `## Meta-Dream History\n\n${store.runs.map(formatDreamRunSummary).join("\n\n")}`;
	}

	const store = readProjectDreamStore(location.dreamStorePath, location.project);
	if (store.runs.length === 0) return `No dream runs found for project "${location.project.name}".`;
	return `## Dream History — ${location.project.name}\n\n${store.runs.map(formatDreamRunSummary).join("\n\n")}`;
}

const HELP_TEXT = `## Dream — Session Analysis & Memory Improvement

**Usage:**
  /dream [project]       Run project dream (analyze recent sessions, propose memory changes)
  /dream meta            Run meta dream (cross-project analysis, propose pi-shared changes)
  /dream review          Show pending proposals from latest project dream run
  /dream review meta     Show pending proposals from latest meta dream run
  /dream apply <id>      Apply a project dream proposal to memory
  /dream dismiss <id>    Dismiss a proposal (project or meta)
  /dream history         Show past project dream runs
  /dream history meta    Show past meta dream runs
  /dream help            Show this help

**How it works:**
  Dreams spawn an isolated subagent that analyzes your recent session transcripts alongside
  current project memory. The agent identifies patterns, stale information, missing knowledge,
  and redundancies, then proposes structured improvements.

  Project dreams propose memory changes (add/update/archive/merge).
  Meta dreams propose pi-shared improvements (code/docs/skill/prompt/config changes).

**Storage:**
  Project dreams: ~/.pi/memory/dreams/projects/
  Meta dreams:    ~/.pi/memory/dreams/meta/

**Safety:**
  - Input memory is never modified directly — only proposals are generated
  - Proposals must be explicitly applied or dismissed
  - Meta-dream proposals for pi-shared changes require manual review`;

// --- Tool definition ---

const dreamTool = defineTool({
	name: "dream",
	label: "Dream",
	description: "Run offline dream analysis on past sessions to propose memory improvements (project scope) or pi-shared improvements (meta scope). Can also review, apply, or dismiss proposals.",
	promptSnippet: "dream to analyze past sessions and propose structured improvements to project memory or pi-shared tooling",
	promptGuidelines: [
		"Use dream with action 'run' and scope 'project' when the user wants to review and improve their project's memory based on past session patterns.",
		"Use dream with action 'run' and scope 'meta' when the user wants to identify cross-project friction and propose pi-shared improvements.",
		"Use dream with action 'review' to show pending proposals from the latest dream run.",
		"Use dream with action 'apply' with a proposal_id to apply a specific project dream proposal to memory.",
		"Use dream with action 'dismiss' with a proposal_id to dismiss a specific proposal.",
	],
	parameters: Type.Object({
		action: StringEnum(["run", "review", "apply", "dismiss", "history"] as const, {
			description: "run: execute dream analysis; review: list pending proposals; apply: apply a proposal; dismiss: dismiss a proposal; history: show past runs",
		}),
		scope: Type.Optional(StringEnum(["project", "meta"] as const, {
			description: "project: analyze current project sessions + memory; meta: analyze cross-project sessions for pi-shared improvements. Default: project",
		})),
		sessions: Type.Optional(Type.Number({
			description: "Number of recent sessions to analyze. Default: 15 for project, 5-per-project for meta",
		})),
		proposal_id: Type.Optional(Type.String({
			description: "Proposal ID for apply/dismiss actions (e.g., dp_xxx or dm_xxx)",
		})),
	}),
	async execute(_id, params, signal, onUpdate, ctx) {
		const scope = params.scope ?? "project";
		const location = detectProjectForDream(ctx.cwd);
		const progress = (text: string) => {
			onUpdate?.({ content: [{ type: "text" as const, text }] });
		};

		switch (params.action) {
			case "run": {
				if (scope === "meta") {
					const result = await runMetaDream(params.sessions ?? 5, ctx.model?.id, signal, progress);
					return { content: [{ type: "text" as const, text: result.content }] };
				}
				const result = await runProjectDream(location, params.sessions ?? 15, ctx.model?.id, signal, progress);
				return { content: [{ type: "text" as const, text: result.content }] };
			}
			case "review": {
				const text = scope === "meta" ? reviewMetaDream() : reviewProjectDream(location);
				return { content: [{ type: "text" as const, text }] };
			}
			case "apply": {
				if (!params.proposal_id) throw new Error("apply requires a proposal_id");
				const result = await applyProjectProposal(params.proposal_id, location);
				return { content: [{ type: "text" as const, text: result }] };
			}
			case "dismiss": {
				if (!params.proposal_id) throw new Error("dismiss requires a proposal_id");
				const isMeta = params.proposal_id.startsWith("dm_");
				const result = isMeta
					? await dismissMetaProposal(params.proposal_id)
					: await dismissProjectProposal(params.proposal_id, location);
				return { content: [{ type: "text" as const, text: result }] };
			}
			case "history": {
				return { content: [{ type: "text" as const, text: dreamHistory(location, scope) }] };
			}
			default:
				throw new Error(`Unknown dream action: ${params.action}`);
		}
	},
});

// --- Extension entry point ---

export default function dreamExtension(pi: ExtensionAPI) {
	pi.registerTool(dreamTool);

	pi.registerCommand("dream", {
		description: "Dream analysis: review past sessions, propose improvements. Args: [project|meta|review|apply <id>|dismiss <id>|history|help]",
		handler: async (args, ctx) => {
			const send = (content: string) => {
				pi.sendMessage({ customType: "dream", content, display: true });
			};

			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = tokens[0]?.toLowerCase() || "project";

			if (subcommand === "help") {
				send(HELP_TEXT);
				return;
			}

			const location = detectProjectForDream(ctx.cwd);

			if (subcommand === "review") {
				const scope = tokens[1]?.toLowerCase() === "meta" ? "meta" : "project";
				send(scope === "meta" ? reviewMetaDream() : reviewProjectDream(location));
				return;
			}

			if (subcommand === "history") {
				const scope = tokens[1]?.toLowerCase() === "meta" ? "meta" : "project";
				send(dreamHistory(location, scope));
				return;
			}

			if (subcommand === "apply") {
				const proposalId = tokens[1];
				if (!proposalId) {
					send("Usage: /dream apply <proposal-id>");
					return;
				}
				const result = await applyProjectProposal(proposalId, location);
				send(result);
				return;
			}

			if (subcommand === "dismiss") {
				const proposalId = tokens[1];
				if (!proposalId) {
					send("Usage: /dream dismiss <proposal-id>");
					return;
				}
				const isMeta = proposalId.startsWith("dm_");
				const result = isMeta
					? await dismissMetaProposal(proposalId)
					: await dismissProjectProposal(proposalId, location);
				send(result);
				return;
			}

			if (subcommand === "meta") {
				const sessionLimit = tokens[1] ? parseInt(tokens[1], 10) || 5 : 5;
				send("Starting meta-dream analysis...");
				const result = await runMetaDream(sessionLimit, ctx.model?.id, undefined, (text) => send(text));
				send(result.content);
				return;
			}

			// Default: run project dream
			const sessionLimit = subcommand === "project"
				? (tokens[1] ? parseInt(tokens[1], 10) || 15 : 15)
				: (parseInt(subcommand, 10) || 15);
			send("Starting project dream analysis...");
			const result = await runProjectDream(location, sessionLimit, ctx.model?.id, undefined, (text) => send(text));
			send(result.content);
		},
	});
}
