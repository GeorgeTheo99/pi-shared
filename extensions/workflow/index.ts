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
 *   - `script`      : inline trusted JS string (function body)
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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Message } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents, formatAgentList, type AgentConfig } from "../spawn-subagent/agents.js";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;
const MAX_RETURN_CHARS = 24000;
const MAX_INLINE_SCRIPT_CHARS = 20000;
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

/** On-disk journal entry for one cache() key. Only successful results are
 * persisted, so a restart resumes from the first incomplete/failed step. */
interface JournalEntry {
  key: string;
  value: unknown;
  completedAt: string;
}

interface Journal {
  id: string;
  filePath: string;
  entries: Map<string, JournalEntry>;
}

function journalDir(): string {
  // Persist alongside other pi runtime state under the user home.
  return path.join(os.homedir(), ".pi", "workflow-journal");
}

/** Load (or start) a journal for the given run id. Corrupt journals are
 * treated as empty rather than fatal — a clean re-run is always safe. */
function loadJournal(id: string): Journal {
  const safeId = id.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(journalDir(), `${safeId}.json`);
  const entries = new Map<string, JournalEntry>();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
    for (const e of parsed.entries ?? []) {
      if (e && typeof e.key === "string") entries.set(e.key, e);
    }
  } catch {
    // No journal yet, or unreadable/corrupt — start fresh.
  }
  return { id, filePath, entries };
}

function persistJournal(journal: Journal): void {
  try {
    fs.mkdirSync(journalDir(), { recursive: true });
    const payload = { id: journal.id, entries: Array.from(journal.entries.values()) };
    fs.writeFileSync(journal.filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Journaling is best-effort; failure to persist must not fail the workflow.
  }
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

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function extractMessageText(message: Message | undefined): string {
  if (!message) return "";
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveCwd(defaultCwd: string, cwd?: string): string {
  if (!cwd) return defaultCwd;
  const expanded = expandTilde(cwd);
  return path.isAbsolute(expanded) ? expanded : path.resolve(defaultCwd, expanded);
}

/** Build the `pi` invocation the same way spawn_subagent does, so workflow
 * subagents behave identically to `spawn_subagent` single mode. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

interface AgentExecResult {
  output: string;
  exitCode: number;
  stderr: string;
  model?: string;
  errorMessage?: string;
}

/** Spawn one Pi subagent and return its final assistant text. Mirrors the
 * subprocess contract of spawn_subagent's runSingleAgent, trimmed to what
 * workflow needs (no per-tool progress, just status + final output). */
async function runAgent(options: {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  model?: string;
  parentModel?: string;
  signal?: AbortSignal;
  onStatus: (patch: Partial<AgentRun>) => void;
  // Optional live-stream sink: invoked with each streamed assistant text as it
  // arrives, so the orchestrator layer (workflow JS) can observe in-progress
  // findings, not just the final output.
  onStream?: (text: string) => void;
}): Promise<AgentExecResult> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) {
    const available = options.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return { output: "", exitCode: 1, stderr: `Unknown agent: "${options.agentName}". Available agents: ${available}.`, errorMessage: "unknown agent" };
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  // Model precedence: explicit call param > agent frontmatter > parent session model.
  const model = options.model ?? agent.model ?? options.parentModel;
  if (model) args.push("--model", model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  const messages: Message[] = [];
  let stderr = "";
  let wasAborted = false;
  let updateCount = 0;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }
    args.push(`Task: ${options.task}`);

    const cwd = resolveCwd(options.defaultCwd, options.cwd);
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      options.onStatus({ status: "running", startedAt: new Date().toISOString() });

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_update" && event.message) {
          const text = extractMessageText(event.message as Message);
          if (text) {
            updateCount++;
            options.onStatus({ lastText: text, updateCount, lastUpdateAt: new Date().toISOString() });
            options.onStream?.(text);
          }
        }
        if (event.type === "message_end" && event.message) {
          messages.push(event.message as Message);
          const text = extractMessageText(event.message as Message);
          if (text) {
            updateCount++;
            options.onStatus({ lastText: text, updateCount, lastUpdateAt: new Date().toISOString() });
            options.onStream?.(text);
          }
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", (error) => {
        stderr += error.message;
        resolve(1);
      });

      if (options.signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000).unref?.();
        };
        if (options.signal.aborted) killProc();
        else options.signal.addEventListener("abort", killProc, { once: true });
      }
    });

    const errorMessage = wasAborted ? "aborted" : undefined;
    return {
      output: wasAborted ? "" : getFinalOutput(messages),
      exitCode,
      stderr,
      errorMessage,
    };
  } finally {
    if (tmpPromptPath) await fs.promises.unlink(tmpPromptPath).catch(() => undefined);
    if (tmpPromptDir) await fs.promises.rmdir(tmpPromptDir).catch(() => undefined);
  }
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    new Array(workerCount).fill(null).map(async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
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

interface ResolvedSource {
  code: string;
  source: "inline" | "saved" | "path";
  name?: string;
  scriptPath?: string;
}

function readWorkflowFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

/** Resolve the workflow script from exactly one of script/name/scriptPath. */
function resolveSource(params: any, ctx: ExtensionContext): { ok: true; value: ResolvedSource } | { ok: false; error: string } {
  const hasScript = typeof params.script === "string" && params.script.trim().length > 0;
  const hasName = typeof params.name === "string" && params.name.trim().length > 0;
  const hasPath = typeof params.scriptPath === "string" && params.scriptPath.trim().length > 0;
  const count = Number(hasScript) + Number(hasName) + Number(hasPath);
  if (count !== 1) {
    return { ok: false, error: "Provide exactly one of `script` (inline JS), `name` (saved workflow), or `scriptPath` (workflow file path)." };
  }

  if (hasScript) {
    const code = params.script as string;
    if (code.length > MAX_INLINE_SCRIPT_CHARS) {
      return { ok: false, error: `Inline script is ${code.length} chars; max is ${MAX_INLINE_SCRIPT_CHARS}. Use scriptPath or a saved workflow.` };
    }
    return { ok: true, value: { code, source: "inline" } };
  }

  if (hasPath) {
    const filePath = resolveCwd(ctx.cwd, params.scriptPath as string);
    if (!fs.existsSync(filePath)) return { ok: false, error: `Workflow file not found: ${filePath}` };
    try {
      const code = readWorkflowFile(filePath);
      return { ok: true, value: { code, source: "path", scriptPath: filePath } };
    } catch (err: unknown) {
      return { ok: false, error: `Could not read workflow file ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // name resolution: shared dir first, then nearest project .pi/workflows
  const name = (params.name as string).trim();
  const safeName = name.replace(/[\\/]+/g, ""); // prevent path traversal
  const sharedDir = sharedWorkflowsDir();
  const sharedPath = path.join(sharedDir, `${safeName}.js`);
  if (fs.existsSync(sharedPath)) {
    try {
      const code = readWorkflowFile(sharedPath);
      return { ok: true, value: { code, source: "saved", name, scriptPath: sharedPath } };
    } catch (err: unknown) {
      return { ok: false, error: `Could not read shared workflow "${name}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const projectDir = findNearestProjectWorkflowsDir(ctx.cwd);
  if (projectDir) {
    const projectPath = path.join(projectDir, `${safeName}.js`);
    if (fs.existsSync(projectPath)) {
      // Project workflows are repo-controlled scripts. Only run them when the
      // project is trusted, or the user explicitly confirms in the UI.
      if (!ctx.isProjectTrusted() && ctx.hasUI) {
        // Defer confirmation to the caller (execute) so it can await ctx.ui.
        return { ok: false, error: `__confirm_project__:${projectPath}` };
      }
      if (!ctx.isProjectTrusted() && !ctx.hasUI) {
        return { ok: false, error: `Project workflow "${name}" requires project trust. Trust this project or run from an interactive session.` };
      }
      try {
        const code = readWorkflowFile(projectPath);
        return { ok: true, value: { code, source: "saved", name, scriptPath: projectPath } };
      } catch (err: unknown) {
        return { ok: false, error: `Could not read project workflow "${name}": ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const lookedIn = [sharedDir, projectDir].filter(Boolean).map((d) => `- ${d}`).join("\n");
  return { ok: false, error: `Saved workflow "${name}" not found. Looked in:\n${lookedIn || "(no workflow dirs found)"}` };
}

interface RuntimeOptions {
  args: Record<string, unknown>;
  cwd: string;
  agents: AgentConfig[];
  parentModel?: string;
  signal?: AbortSignal;
  details: WorkflowDetails;
  onUpdate?: OnUpdateCallback;
  journal?: Journal;
}

function buildRuntime(opts: RuntimeOptions) {
  const { args, cwd, agents, parentModel, signal, details, onUpdate, journal } = opts;
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
    details.agents.push(run);
    emit(true);
  };

  const agent = async (
    prompt: string,
    agentOpts?: { agent?: string; model?: string; cwd?: string; onProgress?: (text: string) => void },
  ): Promise<string> => {
    if (typeof prompt !== "string") throw new Error("agent(prompt, opts?): prompt must be a string");
    const agentName = agentOpts?.agent ?? "worker";
    const run: AgentRun = { agent: agentName, task: prompt, status: "queued" };
    recordAgent(run);
    const result = await runAgent({
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

  const parallel = async <T,>(thunks: Array<() => Promise<T>>): Promise<T[]> => {
    if (!Array.isArray(thunks)) throw new Error("parallel(thunks): thunks must be an array of functions");
    if (thunks.length > MAX_PARALLEL) throw new Error(`parallel(): ${thunks.length} thunks exceeds max of ${MAX_PARALLEL}`);
    return mapWithConcurrencyLimit(thunks, MAX_CONCURRENCY, (thunk) => thunk());
  };

  const phase = (title: string) => {
    details.phases.push(String(title));
    emit(true);
  };

  const log = (message: string) => {
    details.logs.push(String(message));
    emit(true);
  };

  // cache(key, producer): resume-by-replay primitive. If journaling is enabled
  // and `key` already has a persisted successful result, the producer is NOT
  // run and the stored value is returned (replay). Otherwise the producer runs
  // and, on success, its result is journaled so a later restart skips it.
  // Without a journal it degrades to a plain `await producer()` (no caching).
  const cache = async <T,>(key: string, producer: () => Promise<T>): Promise<T> => {
    const cacheKey = String(key);
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
      journal.entries.set(cacheKey, { key: cacheKey, value, completedAt: new Date().toISOString() });
      persistJournal(journal);
      details.computedKeys = details.computedKeys ?? [];
      if (!details.computedKeys.includes(cacheKey)) details.computedKeys.push(cacheKey);
    }
    return value;
  };

  return { agent, parallel, phase, log, cache, args, cwd };
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

const workflowTool = defineTool({
  name: "workflow",
  label: "Workflow",
  description: [
    "Run a trusted JavaScript workflow whose primitives are Pi subagent calls. The workflow body is an async function with globals `agent(prompt, opts?)`, `parallel(thunks)`, `phase(title)`, `log(message)`, `cache(key, producer)`, `args`, and `cwd` in scope.",
    "Pass args._journal=<run id> to enable resume-by-replay: cache(key, fn) results are persisted, and re-invoking with the same _journal id replays completed steps and resumes a failed run from the first incomplete step.",
    "Provide exactly one source: `script` (inline JS), `name` (saved workflow), or `scriptPath` (workflow file). Optional `args` object is passed through to the workflow.",
    "Use for repeatable, multi-phase, scriptable orchestration on top of existing Pi subagents. For ordinary one-off single/parallel/chain delegation, prefer spawn_subagent.",
  ].join(" "),
  promptSnippet: "Run a trusted JS workflow of Pi subagent calls (agent/parallel/phase/log) for repeatable multi-phase orchestration.",
  promptGuidelines: [
    "Use `workflow` for repeatable, scriptable, multi-phase orchestration (interleaved phases, conditional lanes, gathered results fed into later steps) or patterns worth saving/reusing as a named workflow.",
    "Use `spawn_subagent` for ordinary one-off single/parallel/chain delegation where a declarative task list is enough; do not reach for `workflow` for a simple fan-out.",
    "Inside a workflow: `agent(prompt, {agent})` runs one Pi subagent (shared agents: scout, planner, reviewer, worker, panelist; default worker) and returns its final text. `parallel(thunks)` runs lanes concurrently (max 8). `phase(title)` and `log(msg)` annotate progress.",
    "Save repeatable workflows under `pi-shared/workflows/<name>.js` (shared, committed) or `.pi/workflows/<name>.js` (project) and invoke them by `name`.",
    "Workflow scripts run in-process with the same trust level as bash; only run workflows you trust (committed shared workflows or agent-authored inline scripts).",
  ],
  parameters: WorkflowParams,

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const agents = discoverAgents(ctx.cwd, "shared").agents;
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<string, unknown>;

    let resolved = resolveSource(params, ctx);

    // Project workflow confirmation deferred from resolveSource (needs async UI).
    if (!resolved.ok && resolved.error.startsWith("__confirm_project__:")) {
      const projectPath = resolved.error.slice("__confirm_project__:".length);
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Run project-local workflow?",
          `Workflow: ${path.basename(projectPath)}\nSource: ${projectDirLabel(projectPath)}\n\nProject workflows are repo-controlled scripts that run in-process with bash-level trust. Continue only for trusted repositories.`,
        );
        if (!ok) {
          return { content: [{ type: "text", text: "Canceled: project-local workflow was not approved." }], details: emptyDetails("saved") };
        }
        try {
          const code = readWorkflowFile(projectPath);
          resolved = { ok: true, value: { code, source: "saved", name: (params.name as string)?.trim(), scriptPath: projectPath } };
        } catch (err: unknown) {
          resolved = { ok: false, error: `Could not read project workflow: ${err instanceof Error ? err.message : String(err)}` };
        }
      } else {
        resolved = { ok: false, error: `Project workflow requires project trust. Trust this project or run from an interactive session: ${projectPath}` };
      }
    }

    if (!resolved.ok) {
      const details = emptyDetails("inline");
      details.status = "failed";
      details.error = resolved.error;
      return { content: [{ type: "text", text: `Error: ${resolved.error}` }], details, isError: true };
    }

    const source = resolved.value;
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

    // Resume-by-replay: enabled when the caller passes args._journal (a stable
    // run id). Completed cache() keys from a prior run are replayed; a failed
    // run can be re-invoked with the same id to resume from the first
    // incomplete step instead of restarting from scratch.
    const journalId = typeof args._journal === "string" && args._journal.trim() ? args._journal.trim() : undefined;
    const journal = journalId ? loadJournal(journalId) : undefined;
    if (journal) {
      details.journalId = journal.id;
      details.replayedKeys = [];
      details.computedKeys = [];
    }

    const runtime = buildRuntime({
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
      details.returnValue = returnValue;
      details.status = "completed";
    } catch (err: unknown) {
      details.status = "failed";
      details.error = err instanceof Error ? err.message : String(err);
    }

    const returnText = serializeReturnValue(returnValue);
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

function emptyDetails(source: WorkflowDetails["source"]): WorkflowDetails {
  return { source, phases: [], logs: [], agents: [], status: "running" };
}

function projectDirLabel(projectPath: string): string {
  return path.dirname(projectPath);
}

function listWorkflows(ctx: ExtensionContext): string {
  const sharedDir = sharedWorkflowsDir();
  const projectDir = findNearestProjectWorkflowsDir(ctx.cwd);
  const lines: string[] = [];
  lines.push(`Shared workflows: ${sharedDir}`);
  lines.push(...listDir(sharedDir).map((f) => `  ${f}`));
  if (projectDir) {
    lines.push("");
    lines.push(`Project workflows: ${projectDir}`);
    lines.push(...listDir(projectDir).map((f) => `  ${f}`));
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

  pi.registerTool(workflowTool);
}
