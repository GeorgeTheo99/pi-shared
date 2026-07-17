/**
 * workflow — trusted JS workflow runner on top of Pi subagents.
 *
 * Pi already has `spawn_subagent` for one-off single / parallel / chain
 * delegation. `workflow` is for the next level up: repeatable, scriptable,
 * multi-phase orchestration expressed as a small JavaScript program whose
 * primitives are Pi subagent calls.
 *
 * A workflow is just an async function body with these globals in scope:
 *
 *   - `agent(prompt, opts?)` → Promise<string>  : runs one Pi subagent, returns final text
 *   - `parallel(thunks)`     → Promise<any[]>   : runs thunks concurrently (capped)
 *   - `phase(title)`         : marks a status grouping boundary
 *   - `log(message)`         : emits a progress note
 *   - `cache(key, fn)`       → Promise<T>       : resume-by-replay; replays a persisted
 *                                                 result when args._journal is set
 *   - `args`                 : the `args` object passed to the tool (or {})
 *   - `cwd`                  : the session working directory
 *
 * Sources (exactly one):
 *   - `script`      : inline JS string (function body); always requires approval
 *   - `name`        : saved workflow name, resolved from shared then project dirs
 *   - `scriptPath`  : explicit path to a .js workflow file
 *
 * v1 constraints (intentionally boring):
 *   - Pi-backed subagents only (spawns `pi --mode json -p --no-session`).
 *   - No external Codex/Claude backends.
 *   - Resume-by-replay via opt-in cache(key, fn) + args._journal (off by default).
 *   - No structured output schema validation.
 *   - Subagents inherit the parent's Pi profile (PI_CODING_AGENT_DIR); no
 *     per-call agentDir override, so no separate trust-boundary surface.
 *
 * See README.md for the full guide and examples.
 */

import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents, formatAgentList, type AgentConfig } from "../spawn-subagent/agents.js";
import {
	canSpawnSubagent,
	formatSubagentLimits,
	loadSubagentConfig,
	subagentConfigError,
	type SubagentConfig,
} from "../_shared/subagent-config.ts";
import {
	createSubagentExecutionGroup,
	type SubagentExecutionGroup,
} from "../_shared/subagent-scheduler.ts";
import { getFinalAssistantOutput, runPiAgent } from "../_shared/pi-agent-runner.ts";
import { PromiseTracker } from "./promise-tracker.ts";
import {
	exactJournalValue,
	openWorkflowJournal,
	persistWorkflowJournalEntry,
	type WorkflowJournal,
} from "./journal.ts";
import {
	approveWorkflowSource,
	configuredWorkflowScriptDirs,
	resolveWorkflowSource,
	type ReadyWorkflowSource,
} from "./source.ts";

const MAX_RETURN_CHARS = 24000;
const PROGRESS_THROTTLE_MS = 250;

type AgentStatus = "queued" | "running" | "completed" | "failed";

interface AgentRun {
  agent: string;
  task: string;
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  lastText?: string;
  exitCode?: number;
  // Observability: count of streamed assistant updates and when the last one
  // arrived, so a run's live activity is captured (not just final output).
  updateCount?: number;
  lastUpdateAt?: string;
}

interface WorkflowDetails {
  source: "inline" | "saved" | "path";
  name?: string;
  scriptPath?: string;
  phases: string[];
  logs: string[];
  agents: AgentRun[];
  returnValue?: unknown;
  status: "running" | "completed" | "failed";
  error?: string;
  // Resume-by-replay journaling: the journal id (run identity) and which
  // cache() keys were replayed from disk vs freshly computed this run.
  journalId?: string;
  replayedKeys?: string[];
  computedKeys?: string[];
}

type OnUpdateCallback = (partial: { content: { type: "text"; text: string }[]; details: WorkflowDetails }) => void;

function extensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function sharedWorkflowsDir(): string {
  // extensions/workflow -> ../../workflows = pi-shared/workflows
  return path.resolve(extensionDir(), "..", "..", "workflows");
}

function limitText(text: string, maxChars = MAX_RETURN_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[workflow output truncated at ${maxChars} chars]`;
}

function compactLine(text: string, maxChars = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

interface AgentExecResult {
  output: string;
  exitCode: number;
  stderr: string;
  model?: string;
  errorMessage?: string;
}

async function runAgent(options: {
  config: SubagentConfig;
  group: SubagentExecutionGroup;
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  model?: string;
  parentModel?: string;
  signal?: AbortSignal;
  onStatus: (patch: Partial<AgentRun>) => void;
  onStream?: (text: string) => void;
}): Promise<AgentExecResult> {
  let updateCount = 0;
  let previousText = "";
  const result = await runPiAgent({
    config: options.config,
    group: options.group,
    defaultCwd: options.defaultCwd,
    agents: options.agents,
    agentName: options.agentName,
    task: options.task,
    cwd: options.cwd,
    model: options.model,
    parentModel: options.parentModel,
    signal: options.signal,
    onUpdate: (partial) => {
      const text = partial.lastText ?? "";
      if (text && text !== previousText) {
        previousText = text;
        updateCount++;
        options.onStream?.(text);
      }
      options.onStatus({
        status:
          partial.status === "completed"
            ? "completed"
            : partial.status === "failed" || partial.status === "canceled"
              ? "failed"
              : partial.status === "queued"
                ? "queued"
                : "running",
        startedAt: partial.startedAt,
        lastText: text || undefined,
        updateCount,
        lastUpdateAt: partial.updatedAt,
      });
    },
  });
  return {
    output: result.status === "canceled" ? "" : getFinalAssistantOutput(result.messages),
    exitCode: result.exitCode,
    stderr: result.stderr,
    model: result.model,
    errorMessage: result.errorMessage,
  };
}

function findNearestProjectWorkflowsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "workflows");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not present
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface RuntimeOptions {
  config: SubagentConfig;
  group: SubagentExecutionGroup;
  args: Record<string, unknown>;
  cwd: string;
  agents: AgentConfig[];
  parentModel?: string;
  signal?: AbortSignal;
  details: WorkflowDetails;
  onUpdate?: OnUpdateCallback;
  journal?: WorkflowJournal;
}

function buildRuntime(opts: RuntimeOptions) {
  const { config, group, args, cwd, agents, parentModel, signal, details, onUpdate, journal } = opts;
  let lastEmitMs = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitMs < PROGRESS_THROTTLE_MS) return;
    lastEmitMs = now;
    onUpdate?.({
      content: [{ type: "text", text: formatProgress(details) }],
      details: cloneDetails(details),
    });
  };

  const recordAgent = (run: AgentRun) => {
    if (details.agents.length >= config.maxFanout) {
      throw new Error(`Workflow exceeds the maximum of ${config.maxFanout} agent calls.`);
    }
    details.agents.push(run);
    emit(true);
  };

  const pendingAgents = new PromiseTracker<string>();
  let acceptingAgents = true;

  const runAgentCall = async (
    prompt: string,
    agentOpts?: { agent?: string; model?: string; cwd?: string; onProgress?: (text: string) => void },
  ): Promise<string> => {
    if (typeof prompt !== "string") throw new Error("agent(prompt, opts?): prompt must be a string");
    const agentName = agentOpts?.agent ?? "worker";
    const run: AgentRun = { agent: agentName, task: prompt, status: "queued" };
    recordAgent(run);
    const result = await runAgent({
      config,
      group,
      defaultCwd: cwd,
      agents,
      agentName,
      task: prompt,
      cwd: agentOpts?.cwd,
      model: agentOpts?.model,
      parentModel,
      signal,
      onStatus: (patch) => {
        Object.assign(run, patch);
        emit();
      },
      // Forward each streamed assistant update to the workflow's optional
      // onProgress sink so the orchestrator can act on in-progress findings.
      onStream:
        typeof agentOpts?.onProgress === "function"
          ? (text) => {
              try {
                agentOpts.onProgress!(text);
              } catch {
                // A faulty onProgress callback must never crash the subagent run.
              }
            }
          : undefined,
    });
    run.exitCode = result.exitCode;
    run.output = result.output;
    run.completedAt = new Date().toISOString();
    if (result.errorMessage || result.exitCode !== 0) {
      run.status = "failed";
      run.error = result.errorMessage || result.stderr.trim() || `agent exited with code ${result.exitCode}`;
    } else {
      run.status = "completed";
    }
    emit(true);
    if (run.status === "failed") {
      throw new Error(`Agent ${agentName} failed: ${run.error}`);
    }
    return result.output;
  };

  const agent = (
    prompt: string,
    agentOpts?: { agent?: string; model?: string; cwd?: string; onProgress?: (text: string) => void },
  ): Promise<string> => {
    if (!acceptingAgents) return Promise.reject(new Error("Workflow is no longer accepting agent calls."));
    return pendingAgents.track(runAgentCall(prompt, agentOpts));
  };

  const sealAgents = () => {
    acceptingAgents = false;
  };

  const drainAgents = () => pendingAgents.drain();

  const parallel = async <T,>(thunks: Array<() => Promise<T>>): Promise<T[]> => {
    if (!Array.isArray(thunks)) throw new Error("parallel(thunks): thunks must be an array of functions");
    if (thunks.length > config.maxFanout) {
      throw new Error(`parallel(): ${thunks.length} thunks exceeds max of ${config.maxFanout}`);
    }
    return Promise.all(thunks.map((thunk) => thunk()));
  };

  const phase = (title: string) => {
    if (details.phases.length >= 100) throw new Error("Workflow exceeds the maximum of 100 phase markers.");
    details.phases.push(limitText(String(title), 500));
    emit(true);
  };

  const log = (message: string) => {
    details.logs.push(limitText(String(message), 4000));
    if (details.logs.length > 200) details.logs.splice(0, details.logs.length - 200);
    emit(true);
  };

  // cache(key, producer): resume-by-replay primitive. If journaling is enabled
  // and `key` already has a persisted successful result, the producer is NOT
  // run and the stored value is returned (replay). Otherwise the producer runs
  // and, on success, its result is journaled so a later restart skips it.
  // Without a journal it degrades to a plain `await producer()` (no caching).
  const cache = async <T,>(key: string, producer: () => Promise<T>): Promise<T> => {
    const cacheKey = String(key);
    if (!cacheKey.trim()) throw new Error("Workflow cache key must be non-empty.");
    if (Buffer.byteLength(cacheKey, "utf8") > 512) {
      throw new Error("Workflow cache key exceeds 512 UTF-8 bytes.");
    }
    if (journal) {
      const existing = journal.entries.get(cacheKey);
      if (existing) {
        details.replayedKeys = details.replayedKeys ?? [];
        if (!details.replayedKeys.includes(cacheKey)) details.replayedKeys.push(cacheKey);
        log(`replay: "${cacheKey}" (from journal ${journal.id})`);
        emit(true);
        return existing.value as T;
      }
    }
    const value = await producer();
    if (journal) {
      const entry = {
        key: cacheKey,
        value: exactJournalValue(value, config.maxCaptureBytes),
        completedAt: new Date().toISOString(),
      };
      await persistWorkflowJournalEntry(journal, entry);
      details.computedKeys = details.computedKeys ?? [];
      if (!details.computedKeys.includes(cacheKey)) details.computedKeys.push(cacheKey);
    }
    return value;
  };

  return { agent, parallel, phase, log, cache, sealAgents, drainAgents, args, cwd };
}

function cloneDetails(details: WorkflowDetails): WorkflowDetails {
  return JSON.parse(JSON.stringify(details)) as WorkflowDetails;
}

function formatProgress(details: WorkflowDetails): string {
  const lines: string[] = [];
  if (details.name) lines.push(`workflow: ${details.name} (${details.source})`);
  else lines.push(`workflow (${details.source})`);
  if (details.phases.length) {
    lines.push(`phases: ${details.phases.map((p) => compactLine(p, 60)).join(" › ")}`);
  }
  if (details.agents.length) {
    const done = details.agents.filter((a) => a.status === "completed" || a.status === "failed").length;
    lines.push(`agents: ${done}/${details.agents.length} done`);
    for (const a of details.agents) {
      const icon = a.status === "completed" ? "✔" : a.status === "failed" ? "✖" : a.status === "running" ? "◼" : "◻";
      const tail = a.status === "completed" ? ` — ${compactLine(a.output ?? "", 120)}` : a.lastText ? ` — ${compactLine(a.lastText, 120)}` : ` — ${compactLine(a.task, 120)}`;
      // Live-activity counter (streamed assistant updates) for running agents,
      // so a long-running subagent visibly shows progress rather than a frozen line.
      const activity = a.status === "running" && a.updateCount ? ` [${a.updateCount}↑]` : "";
      lines.push(`  ${icon} ${a.agent}${activity}${tail}`);
    }
  }
  if (details.logs.length) {
    lines.push("logs:");
    for (const l of details.logs.slice(-5)) lines.push(`  · ${compactLine(l, 140)}`);
  }
  return limitText(lines.join("\n"), 4000);
}

function truncateUtf8Value(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  const marker = Buffer.from(`\n[workflow value truncated at ${maxBytes} bytes]`, "utf8");
  const keep = Math.max(0, maxBytes - marker.length);
  let text = source.subarray(0, keep).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > keep) text = text.slice(0, -1);
  return `${text}${marker.toString("utf8")}`;
}

function safeDetailValue(value: unknown, maxBytes: number): unknown {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncateUtf8Value(value, maxBytes);
  try {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > maxBytes) return `[workflow value omitted: ${bytes} bytes exceeds ${maxBytes}-byte capture limit]`;
    return JSON.parse(serialized);
  } catch {
    return `[workflow value is not JSON-serializable: ${String(value).slice(0, 500)}]`;
  }
}

function serializeReturnValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatResult(details: WorkflowDetails, returnValueText: string): string {
  const parts: string[] = [];
  const header = details.status === "failed" ? `Workflow failed: ${details.error ?? "(no error message)"}` : "Workflow completed.";
  parts.push(header);
  if (details.name) parts.push(`name: ${details.name}`);
  if (details.scriptPath) parts.push(`source: ${details.source} (${details.scriptPath})`);
  else parts.push(`source: ${details.source}`);
  if (details.phases.length) parts.push(`phases: ${details.phases.join(" › ")}`);
  if (details.journalId) {
    const replayed = details.replayedKeys?.length ?? 0;
    const computed = details.computedKeys?.length ?? 0;
    parts.push(`journal: ${details.journalId} (replayed ${replayed}, computed ${computed})`);
  }
  if (details.agents.length) {
    const succeeded = details.agents.filter((a) => a.status === "completed").length;
    parts.push(`agents: ${succeeded}/${details.agents.length} succeeded`);
    for (const a of details.agents) {
      const icon = a.status === "completed" ? "✔" : a.status === "failed" ? "✖" : "◻";
      const body = a.status === "failed" ? a.error ?? "(no output)" : a.output ?? "(no output)";
      parts.push(`\n## ${icon} ${a.agent} — ${a.status}\n\n${limitText(body, 4000)}`);
    }
  }
  if (details.logs.length) {
    parts.push("\nlogs:");
    for (const l of details.logs) parts.push(`  · ${l}`);
  }
  if (returnValueText) parts.push(`\n## return value\n\n${limitText(returnValueText, 6000)}`);
  return limitText(parts.join("\n"));
}

const WorkflowParams = Type.Object({
  script: Type.Optional(Type.String({ description: "Inline trusted JS workflow body. Treated as an async function body with `agent`, `parallel`, `phase`, `log`, `cache`, `args`, `cwd` in scope. Mutually exclusive with `name` and `scriptPath`." })),
  name: Type.Optional(Type.String({ description: "Name of a saved workflow. Resolved from the shared workflows dir (pi-shared/workflows/<name>.js) first, then the nearest .pi/workflows/<name>.js. Mutually exclusive with `script` and `scriptPath`." })),
  scriptPath: Type.Optional(Type.String({ description: "Explicit path to a .js workflow file (absolute or relative to cwd). Mutually exclusive with `script` and `name`." })),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional object passed to the workflow as the `args` global." })),
});

const WORKFLOW_ROUTING = `Workflow vs spawn_subagent routing:
- Use \`workflow\` for repeatable, scriptable, multi-phase orchestration: when the fan-out pattern is non-trivial (interleaved phases, conditional lanes, gathered results fed into later steps) or worth saving/reusing as a named workflow.
- Use \`spawn_subagent\` for ordinary one-off single / parallel / chain delegation where a declarative task list is enough.
- Inside a workflow, \`agent(prompt, {agent, onProgress})\` runs one Pi subagent (shared agents: scout, planner, reviewer, worker, panelist; default worker) and returns its final text; pass \`onProgress(text)\` to observe its streamed output mid-run. \`parallel(thunks)\` runs lanes concurrently. \`phase(title)\` and \`log(msg)\` annotate progress. \`cache(key, fn)\` enables resume-by-replay when \`args._journal\` is set.
- Keep workflows small and focused. Prefer saving repeatable workflows under pi-shared/workflows/<name>.js (shared) or .pi/workflows/<name>.js (project) and invoking them by \`name\`.`;

function makeWorkflowTool(config: SubagentConfig, lifecycleAbort: AbortController) {
return defineTool({
  name: "workflow",
  label: "Workflow",
  description: [
    "Run a trusted JavaScript workflow whose primitives are Pi subagent calls. The workflow body is an async function with globals `agent(prompt, opts?)`, `parallel(thunks)`, `phase(title)`, `log(message)`, `cache(key, producer)`, `args`, and `cwd` in scope.",
    "Pass args._journal=<run id> to enable resume-by-replay: cache(key, fn) results are persisted, and re-invoking with the same _journal id replays completed steps and resumes a failed run from the first incomplete step.",
    "Provide exactly one source: `script` (inline JS), `name` (saved workflow), or `scriptPath` (workflow file). Optional `args` object is passed through to the workflow.",
    "Use for repeatable, multi-phase, scriptable orchestration on top of existing Pi subagents. For ordinary one-off single/parallel/chain delegation, prefer spawn_subagent.",
    `Effective limits: ${formatSubagentLimits(config)}.`,
  ].join(" "),
  promptSnippet: "Run a trusted JS workflow of Pi subagent calls (agent/parallel/phase/log) for repeatable multi-phase orchestration.",
  promptGuidelines: [
    "Use `workflow` for repeatable, scriptable, multi-phase orchestration (interleaved phases, conditional lanes, gathered results fed into later steps) or patterns worth saving/reusing as a named workflow.",
    "Use `spawn_subagent` for ordinary one-off single/parallel/chain delegation where a declarative task list is enough; do not reach for `workflow` for a simple fan-out.",
    `Inside a workflow: \`agent(prompt, {agent})\` runs one Pi subagent (shared agents: scout, planner, reviewer, worker, panelist; default worker) and returns its final text. \`parallel(thunks)\` runs lanes concurrently (max ${config.maxFanout}; host concurrency ${config.maxConcurrency}). \`phase(title)\` and \`log(msg)\` annotate progress.`,
    "Save repeatable workflows under `pi-shared/workflows/<name>.js` (shared, committed) or `.pi/workflows/<name>.js` (project) and invoke them by `name`.",
    "Workflow scripts run in-process with the same trust level as bash. Prefer committed shared workflows; inline scripts always require explicit interactive approval.",
  ],
  parameters: WorkflowParams,

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const configurationError = subagentConfigError(config);
    if (configurationError) {
      const details = emptyDetails("inline");
      details.status = "failed";
      details.error = configurationError;
      return { content: [{ type: "text", text: configurationError }], details, isError: true };
    }
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const agents = discoverAgents(ctx.cwd, "shared").agents;
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<string, unknown>;

    let resolved = resolveWorkflowSource({
      params,
      cwd: ctx.cwd,
      sharedDir: sharedWorkflowsDir(),
      projectDir: findNearestProjectWorkflowsDir(ctx.cwd),
      projectTrusted: ctx.isProjectTrusted(),
      allowedScriptDirs: configuredWorkflowScriptDirs(),
    });

    if (resolved.kind === "approval") {
      if (!ctx.hasUI) {
        const details = emptyDetails(resolved.source);
        details.status = "failed";
        const sourceLabel =
          resolved.reason === "inline"
            ? "Inline workflow"
            : `${resolved.reason === "project" ? "Project" : "External"} workflow ${resolved.scriptPath ?? ""}`.trim();
        details.error = `${sourceLabel} requires explicit interactive approval.`;
        return { content: [{ type: "text", text: `Error: ${details.error}` }], details, isError: true };
      }
      const inline = resolved.reason === "inline";
      const sourceDescription = inline
        ? `SHA-256: ${crypto.createHash("sha256").update(resolved.code ?? "").digest("hex")}\nPreview:\n${(resolved.code ?? "").slice(0, 800)}`
        : `Workflow: ${path.basename(resolved.scriptPath!)}\nSource: ${path.dirname(resolved.scriptPath!)}`;
      const ok = await ctx.ui.confirm(
        inline
          ? "Run inline workflow code?"
          : resolved.reason === "project"
            ? "Run project-local workflow?"
            : "Run external workflow file?",
        `${sourceDescription}\n\nWorkflow code executes in the parent Pi process with bash-level trust. Continue only if you trust this exact source.`,
      );
      if (!ok) {
        return { content: [{ type: "text", text: "Canceled: workflow source was not approved." }], details: emptyDetails(resolved.source) };
      }
      resolved = approveWorkflowSource(resolved);
    }

    if (resolved.kind === "error") {
      const details = emptyDetails("inline");
      details.status = "failed";
      details.error = resolved.error;
      return { content: [{ type: "text", text: `Error: ${resolved.error}` }], details, isError: true };
    }

    const source: ReadyWorkflowSource = resolved;
    const details: WorkflowDetails = {
      source: source.source,
      name: source.name,
      scriptPath: source.scriptPath,
      phases: [],
      logs: [],
      agents: [],
      status: "running",
    };

    const onUpdateCb: OnUpdateCallback | undefined = onUpdate
      ? (partial) => onUpdate({ content: partial.content, details: partial.details })
      : undefined;

    // Compile the workflow body as an async function. AsyncFunction constructor
    // treats the string as a function body, so top-level `await` and `return`
    // both work. Scripts are trusted (committed or agent-authored), equivalent
    // trust to bash — no vm sandbox needed for v1.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
    let workflowFn: (...args: unknown[]) => Promise<unknown>;
    try {
      workflowFn = new AsyncFunction("agent", "parallel", "phase", "log", "cache", "args", "cwd", source.code);
    } catch (err: unknown) {
      details.status = "failed";
      details.error = `Failed to compile workflow: ${err instanceof Error ? err.message : String(err)}`;
      return { content: [{ type: "text", text: `Error: ${details.error}` }], details, isError: true };
    }

    // Resume-by-replay is bound to the complete execution contract. Reusing an
    // id after workflow inputs or agent/model configuration changes fails
    // closed instead of replaying stale values.
    const journalId = typeof args._journal === "string" && args._journal.trim() ? args._journal.trim() : undefined;
    let journal: WorkflowJournal | undefined;
    if (journalId) {
      const journalArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "_journal"));
      const hashText = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
      try {
        journal = openWorkflowJournal({
          id: journalId,
          context: {
            workflow: {
              source: source.source,
              name: source.name,
              scriptPath: source.scriptPath,
              codeSha256: hashText(source.code),
            },
            args: journalArgs,
            cwd: path.resolve(ctx.cwd),
            parentModel,
            agents: agents.map((agent) => ({
              name: agent.name,
              source: agent.source,
              filePath: agent.filePath,
              model: agent.model,
              tools: agent.tools,
              promptSha256: hashText(agent.systemPrompt),
            })),
          },
        });
      } catch (error: unknown) {
        details.status = "failed";
        details.error = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${details.error}` }], details, isError: true };
      }
    }
    if (journal) {
      details.journalId = journal.id;
      details.replayedKeys = [];
      details.computedKeys = [];
    }

    const group = createSubagentExecutionGroup(
      config,
      `workflow ${source.name ?? source.source}`,
      [signal, lifecycleAbort.signal],
    );
    const runtime = buildRuntime({
      config,
      group,
      args,
      cwd: ctx.cwd,
      agents,
      parentModel,
      signal,
      details,
      onUpdate: onUpdateCb,
      journal,
    });

    let returnValue: unknown;
    try {
      returnValue = await workflowFn(
        runtime.agent,
        runtime.parallel,
        runtime.phase,
        runtime.log,
        runtime.cache,
        runtime.args,
        runtime.cwd,
      );
      details.returnValue = safeDetailValue(returnValue, config.maxCaptureBytes);
      details.status = "completed";
    } catch (err: unknown) {
      details.status = "failed";
      details.error = err instanceof Error ? err.message : String(err);
    } finally {
      runtime.sealAgents();
      if (details.status === "failed") group.cancel(details.error);
      const pending = await runtime.drainAgents();
      await group.drain();
      if (details.status === "completed" && pending.failed) {
        details.status = "failed";
        details.error = pending.error instanceof Error ? pending.error.message : String(pending.error);
      }
    }

    const returnText = serializeReturnValue(details.returnValue);
    const body = formatResult(details, details.status === "completed" ? returnText : "");
    const result: any = {
      content: [{ type: "text", text: body }],
      details: cloneDetails(details),
    };
    if (details.status === "failed") result.isError = true;
    return result;
  },

  renderCall(args, theme) {
    const bits = [theme.fg("toolTitle", theme.bold("workflow "))];
    if (args.name) bits.push(theme.fg("accent", args.name));
    else if (args.scriptPath) bits.push(theme.fg("accent", compactLine(String(args.scriptPath), 60)));
    else bits.push(theme.fg("muted", "inline"));
    if (args.args && typeof args.args === "object" && Object.keys(args.args).length) {
      bits.push(theme.fg("dim", ` args={${Object.keys(args.args).length}}`));
    }
    return new Text(bits.join(""), 0, 0);
  },

  renderResult(result, _options, theme) {
    const details = result.details as WorkflowDetails | undefined;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    if (!details) return new Text(text, 0, 0);
    if (details.status === "failed") return new Text(theme.fg("error", text), 0, 0);
    return new Text(theme.fg("success", `✓ `) + text, 0, 0);
  },
});
}

function emptyDetails(source: WorkflowDetails["source"]): WorkflowDetails {
  return { source, phases: [], logs: [], agents: [], status: "running" };
}

function listWorkflows(ctx: ExtensionContext): string {
  const sharedDir = sharedWorkflowsDir();
  const projectDir = findNearestProjectWorkflowsDir(ctx.cwd);
  const lines: string[] = [];
  lines.push(`Shared workflows: ${sharedDir}`);
  lines.push(...listDir(sharedDir).map((f) => `  ${f}`));
  if (projectDir && ctx.isProjectTrusted()) {
    lines.push("");
    lines.push(`Project workflows: ${projectDir}`);
    lines.push(...listDir(projectDir).map((f) => `  ${f}`));
  } else if (projectDir) {
    lines.push("");
    lines.push(`Project workflows: ${projectDir} (hidden until project trust is granted)`);
  } else {
    lines.push("");
    lines.push("Project workflows: (none — add .pi/workflows/<name>.js)");
  }
  return lines.join("\n");
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".js"))
      .map((e) => e.name.replace(/\.js$/, ""))
      .sort();
  } catch {
    return ["(none)"];
  }
}

export default function workflowExtension(pi: ExtensionAPI) {
  const config = loadSubagentConfig();
  if (config.errors.length === 0 && !canSpawnSubagent(config)) return;

  const lifecycleAbort = new AbortController();
  pi.on("session_shutdown", async () => {
    lifecycleAbort.abort(new Error("Pi session is shutting down."));
  });

  pi.on("before_agent_start", async (event) => {
    const selectedTools = event.systemPromptOptions?.selectedTools ?? [];
    if (!selectedTools.includes("workflow")) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WORKFLOW_ROUTING}` };
  });

  pi.registerCommand("workflows", {
    description: "List saved workflows (shared + project). Usage: /workflows",
    handler: async (_args, ctx) => {
      pi.sendMessage({ customType: "workflow", content: listWorkflows(ctx), display: true });
    },
  });

  pi.registerTool(makeWorkflowTool(config, lifecycleAbort));
}
