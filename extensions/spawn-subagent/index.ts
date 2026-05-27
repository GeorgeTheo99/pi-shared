import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, type Message } from "@mariozechner/pi-ai";
import { type AgentToolResult, type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_RETURN_CHARS = 24000;
const MAX_NOTIFICATION_CHARS = 1200;
const MAX_PERSISTED_JOBS = 100;
const MAX_PERSISTED_JOB_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_TEXT_CHARS = 12000;
const JOB_STORE_VERSION = 1;
const JOB_STORE_DIR = process.env.PI_SPAWN_SUBAGENT_DIR || path.join(os.homedir(), ".pi", "agent", "spawn-subagent");
const JOB_STORE_PATH = path.join(JOB_STORE_DIR, "jobs.json");

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SpawnSubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  agents: Array<{ name: string; source: string; description: string; filePath: string }>;
  sharedAgentsDir: string;
  userAgentsDir: string;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

type SpawnSubagentResult = AgentToolResult<SpawnSubagentDetails>;
type OnUpdateCallback = (partial: SpawnSubagentResult) => void;
type BackgroundJobStatus = "running" | "completed" | "failed" | "canceled";

interface BackgroundSubagentJob {
  id: string;
  status: BackgroundJobStatus;
  mode: SpawnSubagentDetails["mode"];
  label: string;
  startedAt: string;
  updatedAt: string;
  cwd?: string;
  notifiedAt?: string;
  abortController: AbortController;
  result?: SpawnSubagentResult;
  error?: string;
}

interface PersistedSingleResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  exitCode: number;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  output: string;
}

interface PersistedSpawnSubagentResult {
  contentText: string;
  details: Omit<SpawnSubagentDetails, "results"> & { results: PersistedSingleResult[] };
}

interface PersistedBackgroundSubagentJob {
  id: string;
  status: BackgroundJobStatus;
  mode: SpawnSubagentDetails["mode"];
  label: string;
  startedAt: string;
  updatedAt: string;
  cwd?: string;
  notifiedAt?: string;
  result?: PersistedSpawnSubagentResult;
  error?: string;
}

interface BackgroundJobStore {
  version: number;
  jobs: PersistedBackgroundSubagentJob[];
}

const backgroundJobs = new Map<string, BackgroundSubagentJob>();
let persistedJobsRestored = false;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`cacheR:${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`cacheW:${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function limitText(text: string, maxChars = MAX_RETURN_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[spawn_subagent output truncated at ${maxChars} chars]`;
}

function sanitizePersistedText(text: string, maxChars = MAX_PERSISTED_TEXT_CHARS): string {
  const redacted = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted aws access key]")
    .replace(/(["']?)([a-z0-9_.-]*(?:api[_-]?key|token|secret(?:[_-]?access[_-]?key)?|password|credential)[a-z0-9_.-]*)\1\s*[:=]\s*["']?[^"',}\]\s]+["']?/gi, "$1$2$1: [redacted]")
    .replace(/\b(?:sk|pk|ghp|gho|ghu|github_pat|xox[baprs])[-_][-_a-z0-9]{12,}\b/gi, "[redacted token]");
  return limitText(redacted, maxChars);
}

function makeJobId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatJobLine(job: BackgroundSubagentJob): string {
  const resultCount = job.result?.details?.results.length ?? 0;
  const resultSuffix = resultCount ? `, results=${resultCount}` : "";
  return `${job.id} — ${job.status} — ${job.mode} — ${sanitizePersistedText(job.label, 500)} — started ${job.startedAt}${resultSuffix}`;
}

function formatJobList(): string {
  if (backgroundJobs.size === 0) return "No background subagent jobs.";
  return Array.from(backgroundJobs.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(formatJobLine)
    .join("\n");
}

function summarizeJobLabel(params: any, mode: SpawnSubagentDetails["mode"]): string {
  if (mode === "parallel") return `${params.tasks?.length ?? 0} parallel task(s)`;
  if (mode === "chain") return `${params.chain?.length ?? 0} chain step(s)`;
  return `${params.agent}: ${String(params.task ?? "").slice(0, 80)}`;
}

function extractResultText(result?: SpawnSubagentResult): string {
  return result?.content
    ?.map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n") ?? "";
}

function persistUsage(usage?: Partial<UsageStats> | null): UsageStats {
  return {
    input: Number.isFinite(usage?.input) ? usage.input! : 0,
    output: Number.isFinite(usage?.output) ? usage.output! : 0,
    cacheRead: Number.isFinite(usage?.cacheRead) ? usage.cacheRead! : 0,
    cacheWrite: Number.isFinite(usage?.cacheWrite) ? usage.cacheWrite! : 0,
    cost: Number.isFinite(usage?.cost) ? usage.cost! : 0,
    contextTokens: Number.isFinite(usage?.contextTokens) ? usage.contextTokens! : 0,
    turns: Number.isFinite(usage?.turns) ? usage.turns! : 0,
  };
}

function persistResult(result?: SpawnSubagentResult): PersistedSpawnSubagentResult | undefined {
  if (!result) return undefined;
  return {
    contentText: sanitizePersistedText(extractResultText(result)),
    details: {
      mode: result.details.mode,
      agentScope: result.details.agentScope,
      agents: result.details.agents,
      sharedAgentsDir: result.details.sharedAgentsDir,
      userAgentsDir: result.details.userAgentsDir,
      projectAgentsDir: result.details.projectAgentsDir,
      results: result.details.results.map((item) => ({
        agent: item.agent,
        agentSource: item.agentSource,
        task: sanitizePersistedText(item.task, 2000),
        exitCode: item.exitCode,
        stderr: sanitizePersistedText(item.stderr),
        usage: persistUsage(item.usage),
        model: item.model,
        stopReason: item.stopReason,
        errorMessage: item.errorMessage ? sanitizePersistedText(item.errorMessage, 2000) : undefined,
        step: item.step,
        output: sanitizePersistedText(getFinalOutput(item.messages)),
      })),
    },
  };
}

function isMode(value: unknown): value is SpawnSubagentDetails["mode"] {
  return value === "single" || value === "parallel" || value === "chain";
}

function isJobStatus(value: unknown): value is BackgroundJobStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "canceled";
}

function isAgentScope(value: unknown): value is AgentScope {
  return value === "shared" || value === "user" || value === "project" || value === "all";
}

function hydrateResult(result?: PersistedSpawnSubagentResult): SpawnSubagentResult | undefined {
  try {
    if (!result?.details) return undefined;
    const details = result.details as Partial<PersistedSpawnSubagentResult["details"]>;
    return {
      content: [{ type: "text", text: typeof result.contentText === "string" ? result.contentText : "" }],
      details: {
        mode: isMode(details.mode) ? details.mode : "single",
        agentScope: isAgentScope(details.agentScope) ? details.agentScope : "shared",
        agents: Array.isArray(details.agents) ? details.agents : [],
        sharedAgentsDir: typeof details.sharedAgentsDir === "string" ? details.sharedAgentsDir : "",
        userAgentsDir: typeof details.userAgentsDir === "string" ? details.userAgentsDir : "",
        projectAgentsDir: typeof details.projectAgentsDir === "string" ? details.projectAgentsDir : null,
        results: (Array.isArray(details.results) ? details.results : []).map((item) => ({
          agent: typeof item.agent === "string" ? item.agent : "unknown",
          agentSource: item.agentSource,
          task: typeof item.task === "string" ? item.task : "",
          exitCode: Number.isFinite(item.exitCode) ? item.exitCode : 1,
          messages: item.output ? [{ role: "assistant", content: [{ type: "text", text: item.output }] } as Message] : [],
          stderr: typeof item.stderr === "string" ? item.stderr : "",
          usage: persistUsage(item.usage),
          model: item.model,
          stopReason: item.stopReason,
          errorMessage: item.errorMessage,
          step: item.step,
        })),
      },
    };
  } catch {
    return undefined;
  }
}

function persistJob(job: BackgroundSubagentJob): PersistedBackgroundSubagentJob {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    label: sanitizePersistedText(job.label, 500),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    cwd: job.cwd,
    notifiedAt: job.notifiedAt,
    result: persistResult(job.result),
    error: job.error ? sanitizePersistedText(job.error, 2000) : undefined,
  };
}

function readBackgroundJobStore(): BackgroundJobStore {
  try {
    if (!fs.existsSync(JOB_STORE_PATH)) return { version: JOB_STORE_VERSION, jobs: [] };
    const parsed = JSON.parse(fs.readFileSync(JOB_STORE_PATH, "utf8")) as Partial<BackgroundJobStore>;
    return { version: JOB_STORE_VERSION, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { version: JOB_STORE_VERSION, jobs: [] };
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

function shouldKeepPersistedJob(job: BackgroundSubagentJob, nowMs: number): boolean {
  if (job.status === "running") return true;
  const updatedMs = Date.parse(job.updatedAt);
  if (!Number.isFinite(updatedMs)) return true;
  return nowMs - updatedMs <= MAX_PERSISTED_JOB_AGE_MS;
}

async function saveBackgroundJobStore(): Promise<void> {
  await withFileMutationQueue(JOB_STORE_PATH, async () => {
    const nowMs = Date.now();
    const jobs = Array.from(backgroundJobs.values())
      .filter((job) => shouldKeepPersistedJob(job, nowMs))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(-MAX_PERSISTED_JOBS)
      .map(persistJob);
    await atomicWriteJson(JOB_STORE_PATH, { version: JOB_STORE_VERSION, jobs });
  });
}

function queueSaveBackgroundJobStore(): void {
  void saveBackgroundJobStore().catch(() => undefined);
}

function restorePersistedBackgroundJobs(): void {
  if (persistedJobsRestored) return;
  persistedJobsRestored = true;

  const store = readBackgroundJobStore();
  let changed = false;
  const now = new Date().toISOString();
  for (const persisted of store.jobs) {
    if (!persisted || typeof persisted.id !== "string" || backgroundJobs.has(persisted.id)) continue;
    const job: BackgroundSubagentJob = {
      id: persisted.id,
      status: isJobStatus(persisted.status) ? persisted.status : "failed",
      mode: isMode(persisted.mode) ? persisted.mode : "single",
      label: typeof persisted.label === "string" ? persisted.label : "unknown background job",
      startedAt: typeof persisted.startedAt === "string" ? persisted.startedAt : now,
      updatedAt: typeof persisted.updatedAt === "string" ? persisted.updatedAt : now,
      cwd: typeof persisted.cwd === "string" ? persisted.cwd : undefined,
      notifiedAt: typeof persisted.notifiedAt === "string" ? persisted.notifiedAt : undefined,
      abortController: new AbortController(),
      result: hydrateResult(persisted.result),
      error: typeof persisted.error === "string" ? persisted.error : undefined,
    };
    if (job.status === "running") {
      job.status = "failed";
      job.updatedAt = now;
      job.error = "Background job was still running when Pi reloaded or restarted; child process state cannot be restored.";
      changed = true;
    }
    backgroundJobs.set(job.id, job);
  }
  if (changed) queueSaveBackgroundJobStore();
}

function jobSuccessSummary(job: BackgroundSubagentJob): string {
  const results = job.result?.details.results ?? [];
  if (results.length === 0) return "results unavailable";
  const successCount = results.filter((result) => !isFailure(result)).length;
  return `${successCount}/${results.length} succeeded`;
}

function formatJobNotification(job: BackgroundSubagentJob): string {
  const output = job.error || extractResultText(job.result) || "(no output)";
  return [
    `Background subagent job ${job.id} ${job.status}.`,
    `${job.mode}: ${sanitizePersistedText(job.label, 500)}`,
    `Results: ${jobSuccessSummary(job)}`,
    "",
    "Preview:",
    sanitizePersistedText(output, MAX_NOTIFICATION_CHARS),
    "",
    `Status: {"jobAction":"status","jobId":"${job.id}"}`,
  ].join("\n");
}

function notifyJobFinished(pi: ExtensionAPI, job: BackgroundSubagentJob): void {
  if (job.status === "running" || job.notifiedAt) return;
  job.notifiedAt = new Date().toISOString();
  pi.sendMessage(
    { customType: "spawn-subagent", content: formatJobNotification(job), display: true, details: persistJob(job) },
    { deliverAs: "followUp" },
  );
  queueSaveBackgroundJobStore();
}

function sanitizedDetails(result: SpawnSubagentResult | undefined, fallback: SpawnSubagentDetails): SpawnSubagentDetails {
  return hydrateResult(persistResult(result))?.details ?? fallback;
}

async function trySaveBackgroundJobStore(): Promise<string | undefined> {
  try {
    await saveBackgroundJobStore();
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
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

function resolveCwd(defaultCwd: string, cwd?: string): string {
  if (!cwd) return defaultCwd;
  const expanded = cwd === "~" ? os.homedir() : cwd.startsWith("~/") ? path.join(os.homedir(), cwd.slice(2)) : cwd;
  return path.isAbsolute(expanded) ? expanded : path.resolve(defaultCwd, expanded);
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-spawn-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  });
  return { dir, filePath };
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function isFailure(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function summarizeFailure(result: SingleResult): string {
  return result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages) || "(no output)";
}

function makeDetailsFactory(
  mode: SpawnSubagentDetails["mode"],
  agentScope: AgentScope,
  discovery: ReturnType<typeof discoverAgents>,
) {
  return (results: SingleResult[]): SpawnSubagentDetails => ({
    mode,
    agentScope,
    agents: discovery.agents.map((agent) => ({
      name: agent.name,
      source: agent.source,
      description: agent.description,
      filePath: agent.filePath,
    })),
    sharedAgentsDir: discovery.sharedAgentsDir,
    userAgentsDir: discovery.userAgentsDir,
    projectAgentsDir: discovery.projectAgentsDir,
    results,
  });
}

async function runSingleAgent(options: {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  model?: string;
  parentModel?: string;
  step?: number;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => SpawnSubagentDetails;
}): Promise<SingleResult> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) {
    const available = options.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: options.agentName,
      agentSource: "unknown",
      task: options.task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${options.agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step: options.step,
    };
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  // Model precedence: explicit call param > agent frontmatter > parent session model.
  // Inheriting the parent model avoids spawning children that fall back to a
  // default provider with no usable credentials (e.g. Databricks-routed parents
  // where OPENAI_API_KEY is a sentinel value).
  const model = options.model ?? agent.model ?? options.parentModel;
  if (model) args.push("--model", model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task: options.task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
    step: options.step,
  };

  const emitUpdate = () => {
    options.onUpdate?.({
      content: [{ type: "text", text: limitText(getFinalOutput(currentResult.messages) || "(running...)" )}],
      details: options.makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${options.task}`);
    const cwd = resolveCwd(options.defaultCwd, options.cwd);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          currentResult.messages.push(message);
          if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

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

    currentResult.exitCode = exitCode;
    if (wasAborted) currentResult.stopReason = "aborted";
    return currentResult;
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

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to that agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this subagent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for the prior step output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this subagent process" })),
});

const AgentScopeSchema = StringEnum(["shared", "user", "project", "all"] as const, {
  description:
    'Agent source. Default "shared" uses pi-shared bundled agents. "project" reads .pi/agents and requires confirmation in UI. "all" merges shared, user, then project agents.',
  default: "shared",
});

// Task routing table injected into the system prompt by before_agent_start.
// Add a line when you introduce a new CATEGORY of work (not when you add a new agent
// that fits an existing category). See README.md "Orchestration > Maintenance guide".
const ROUTING_TABLE = `Task routing (pick the most specific match):
- Quick fact, current info, or single-page lookup       → web_search → web_fetch
- Deep multi-source research with cited synthesis        → deep_research
- Explore/map/understand unfamiliar code before editing  → spawn_subagent scout
- Find code, APIs, patterns in unfamiliar codebase       → spawn_subagent scout
- Unfamiliar multi-file implementation                  → spawn_subagent scout, then main agent or planner
- Plan implementation from requirements/recon            → spawn_subagent planner
- Review non-trivial diffs/regressions/security/style    → spawn_subagent reviewer
- Implement in isolated context                          → spawn_subagent worker
- 2+ independent investigation questions                 → spawn_subagent parallel
- Long-running delegations while main chat continues      → spawn_subagent background=true, then jobAction=status
- Multi-step pipeline (scout→planner→worker)             → spawn_subagent chain
- Multi-step durable work with autopilot                 → start_goal + work_plan
- Structured data queries (SQL, CRM, analytics)          → spawn_subagent specialist data agent if available (parallel for multi-entity)
- Multi-entity data gathering (accounts, metrics, etc.)   → spawn_subagent parallel with specialist data agents

Delegation gates (prefer spawn_subagent when one applies):
- Recon gate: unfamiliar area + likely 5+ sequential read/grep/find calls; delegate read-only reconnaissance to scout before editing
- Parallel gate: 2+ independent investigation paths can run concurrently; use parallel mode with focused scout/reviewer tasks
- Specialist gate: planning or review would materially improve correctness after non-trivial diffs, risky changes, or broad refactors

Do not use spawn_subagent for single-file reads, quick greps, obvious edits, or normal linear test/fix loops. Keep execution ownership in the main agent unless isolation or parallelism adds value. Ask subagents for structured output: files inspected, key findings, recommended edit points, verification commands, and risks.`;

const JobActionSchema = StringEnum(["list", "status", "cancel"] as const, {
  description: "Background job action. Use list, status with jobId, or cancel with jobId.",
});

const SpawnSubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of {agent, task, cwd?}" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode: sequential steps; use {previous} in later tasks" })),
  background: Type.Optional(Type.Boolean({ description: "Start the subagent job in the background and return a job id immediately. Poll later with jobAction=status.", default: false })),
  jobAction: Type.Optional(JobActionSchema),
  jobId: Type.Optional(Type.String({ description: "Background subagent job id for status or cancel." })),
  agentScope: Type.Optional(AgentScopeSchema),
  model: Type.Optional(Type.String({ description: "Optional pi model pattern/id override for this invocation" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process (single mode)" })),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local .pi/agents. Default: true.", default: true }),
  ),
});

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "spawn-subagent", content, display: true });
}

export default function spawnSubagentExtension(pi: ExtensionAPI) {
  restorePersistedBackgroundJobs();

  pi.on("before_agent_start", async (event) => {
    const selectedTools = event.systemPromptOptions?.selectedTools ?? [];
    if (!selectedTools.includes("spawn_subagent")) return;

    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    const discovery = discoverAgents(cwd, "all");
    if (discovery.agents.length === 0) return;

    const roster = discovery.agents
      .map((a) => `- ${a.name}: ${a.description}`)
      .join("\n");

    return {
      systemPrompt: event.systemPrompt + `\n\nSubagents available:\n${roster}\n\n${ROUTING_TABLE}`,
    };
  });

  pi.registerCommand("subagents", {
    description: "List available spawn_subagent agents.",
    handler: async (rawArgs, ctx) => {
      const scope = rawArgs.trim() || "shared";
      if (!["shared", "user", "project", "all"].includes(scope)) {
        send(pi, "Usage: /subagents [shared|user|project|all]");
        return;
      }
      const discovery = discoverAgents(ctx.cwd, scope as AgentScope);
      send(
        pi,
        [
          `Agents (${scope}):`,
          formatAgentList(discovery.agents),
          "",
          `shared: ${discovery.sharedAgentsDir}`,
          `user: ${discovery.userAgentsDir}`,
          `project: ${discovery.projectAgentsDir ?? "none"}`,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: [
      "Spawn one or more isolated Pi subagents and return their final outputs.",
      "Supports single agent, parallel tasks, sequential chains with {previous} placeholder handoff, and background jobs.",
      "Default agentScope is shared, using bundled pi-shared agents. Use project/all only for trusted repos.",
    ].join(" "),
    promptSnippet: "Spawn isolated Pi subagents for parallel investigation, review, planning, or implementation.",
    promptGuidelines: [
      "Use spawn_subagent for read-only reconnaissance when the user asks to explore, map, understand, trace, or investigate an unfamiliar code area before editing.",
      "Prefer spawn_subagent when one of three gates applies: likely 5+ sequential read/grep/find calls, 2+ independent investigation paths, or a specialist review/planning pass would materially improve correctness.",
      "Do NOT use spawn_subagent for single-file reads, quick greps, obvious edits, or normal linear test/fix loops the main agent can execute directly.",
      "Use parallel mode for independent questions, chain mode for sequential pipelines (scout→planner→worker), and single mode for one specialist pass.",
      "Use background=true for long-running agent jobs when the main chat can continue orchestrating other work; poll with jobAction=status and cancel with jobAction=cancel.",
      "Ask subagents for structured output: files inspected, key findings, recommended edit points, verification commands, and risks/blockers.",
      "When using spawn_subagent with project-local agents, set agentScope to project or all only for trusted repositories.",
    ],
    parameters: SpawnSubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "shared";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const mode: SpawnSubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const makeDetails = makeDetailsFactory(mode, agentScope, discovery);

      if (params.jobAction) {
        if (params.jobAction === "list") {
          return { content: [{ type: "text", text: formatJobList() }], details: makeDetails([]) };
        }

        const job = params.jobId ? backgroundJobs.get(params.jobId) : undefined;
        if (!job) {
          return { content: [{ type: "text", text: `Background subagent job not found: ${params.jobId ?? "(missing jobId)"}` }], details: makeDetails([]) };
        }

        if (params.jobAction === "cancel") {
          if (job.status === "running") {
            job.status = "canceled";
            job.error = job.error ?? "Canceled by request.";
            job.updatedAt = new Date().toISOString();
            job.abortController.abort();
            notifyJobFinished(pi, job);
          } else {
            await saveBackgroundJobStore();
          }
          return { content: [{ type: "text", text: `Background subagent job ${job.id} is ${job.status}.` }], details: sanitizedDetails(job.result, makeDetails([])) };
        }

        const output = sanitizePersistedText(extractResultText(job.result));
        const error = job.error ? `Error: ${sanitizePersistedText(job.error, 2000)}` : "";
        const body = [`${formatJobLine(job)}`, error, output ? `\n${output}` : ""].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: limitText(body) }], details: sanitizedDetails(job.result, makeDetails([])) };
      }

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode: {agent, task}, tasks, or chain.\n\nAvailable agents:\n${formatAgentList(agents)}`,
            },
          ],
          details: makeDetails([]),
        };
      }

      if ((agentScope === "project" || agentScope === "all") && confirmProjectAgents && ctx.hasUI) {
        const requested = new Set<string>();
        if (params.agent) requested.add(params.agent);
        for (const task of params.tasks ?? []) requested.add(task.agent);
        for (const step of params.chain ?? []) requested.add(step.agent);

        const projectAgents = Array.from(requested)
          .map((name) => agents.find((agent) => agent.name === name))
          .filter((agent): agent is AgentConfig => agent?.source === "project");

        if (projectAgents.length > 0) {
          const ok = await ctx.ui.confirm(
            "Run project-local subagents?",
            `Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "unknown"}\n\nProject agents are repo-controlled prompts. Continue only for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local subagents were not approved." }],
              details: makeDetails([]),
            };
          }
        }
      }

      const runRequest = async (runSignal: AbortSignal, runOnUpdate?: OnUpdateCallback): Promise<SpawnSubagentResult> => {
        if (params.chain && params.chain.length > 0) {
          const results: SingleResult[] = [];
          let previousOutput = "";

          for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const task = step.task.replace(/\{previous\}/g, previousOutput);
            const result = await runSingleAgent({
              defaultCwd: ctx.cwd,
              agents,
              agentName: step.agent,
              task,
              cwd: step.cwd,
              model: params.model,
              parentModel,
              step: i + 1,
              signal: runSignal,
              onUpdate: runOnUpdate
                ? (partial) => {
                    const current = partial.details?.results[0];
                    if (current) {
                      runOnUpdate({ content: partial.content, details: makeDetails([...results, current]) });
                    }
                  }
                : undefined,
              makeDetails,
            });
            results.push(result);

            if (isFailure(result)) {
              return {
                content: [{ type: "text", text: limitText(`Chain stopped at step ${i + 1} (${step.agent}): ${summarizeFailure(result)}`) }],
                details: makeDetails(results),
              };
            }
            previousOutput = getFinalOutput(result.messages);
          }

          return {
            content: [{ type: "text", text: limitText(getFinalOutput(results[results.length - 1].messages) || "(no output)") }],
            details: makeDetails(results),
          };
        }

        if (params.tasks && params.tasks.length > 0) {
          if (params.tasks.length > MAX_PARALLEL_TASKS) {
            return {
              content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
              details: makeDetails([]),
            };
          }

          const liveResults: SingleResult[] = params.tasks.map((task) => ({
            agent: task.agent,
            agentSource: "unknown",
            task: task.task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: emptyUsage(),
          }));

          const emitParallelUpdate = () => {
            const done = liveResults.filter((result) => result.exitCode !== -1).length;
            const running = liveResults.length - done;
            runOnUpdate?.({
              content: [{ type: "text", text: `Parallel subagents: ${done}/${liveResults.length} done, ${running} running.` }],
              details: makeDetails([...liveResults]),
            });
          };

          const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
            const result = await runSingleAgent({
              defaultCwd: ctx.cwd,
              agents,
              agentName: task.agent,
              task: task.task,
              cwd: task.cwd,
              model: params.model,
              parentModel,
              signal: runSignal,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  liveResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails,
            });
            liveResults[index] = result;
            emitParallelUpdate();
            return result;
          });

          const successCount = results.filter((result) => !isFailure(result)).length;
          const summaries = results.map((result) => {
            const status = isFailure(result) ? "failed" : "completed";
            const output = isFailure(result) ? summarizeFailure(result) : getFinalOutput(result.messages);
            const usage = formatUsage(result.usage, result.model);
            return `## ${result.agent} — ${status}${usage ? `\n${usage}` : ""}\n\n${limitText(output || "(no output)", 4000)}`;
          });

          return {
            content: [
              {
                type: "text",
                text: limitText(`Parallel subagents: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`),
              },
            ],
            details: makeDetails(results),
          };
        }

        if (params.agent && params.task) {
          const result = await runSingleAgent({
            defaultCwd: ctx.cwd,
            agents,
            agentName: params.agent,
            task: params.task,
            cwd: params.cwd,
            model: params.model,
            parentModel,
            signal: runSignal,
            onUpdate: runOnUpdate,
            makeDetails,
          });

          if (isFailure(result)) {
            return {
              content: [{ type: "text", text: limitText(`Subagent ${result.agent} failed: ${summarizeFailure(result)}`) }],
              details: makeDetails([result]),
            };
          }

          return {
            content: [{ type: "text", text: limitText(getFinalOutput(result.messages) || "(no output)") }],
            details: makeDetails([result]),
          };
        }

        return {
          content: [{ type: "text", text: `Invalid parameters.\n\nAvailable agents:\n${formatAgentList(agents)}` }],
          details: makeDetails([]),
        };
      };

      if (params.background) {
        const now = new Date().toISOString();
        const job: BackgroundSubagentJob = {
          id: makeJobId(),
          status: "running",
          mode,
          label: summarizeJobLabel(params, mode),
          startedAt: now,
          updatedAt: now,
          cwd: ctx.cwd,
          abortController: new AbortController(),
        };
        backgroundJobs.set(job.id, job);
        const persistenceWarning = await trySaveBackgroundJobStore();

        void runRequest(job.abortController.signal)
          .then((result) => {
            job.result = result;
            if (job.status !== "canceled") {
              job.status = result.details.results.some(isFailure) ? "failed" : "completed";
            }
            job.updatedAt = new Date().toISOString();
            notifyJobFinished(pi, job);
            queueSaveBackgroundJobStore();
          })
          .catch((error: unknown) => {
            job.error = error instanceof Error ? error.message : String(error);
            if (job.status !== "canceled") job.status = "failed";
            job.updatedAt = new Date().toISOString();
            notifyJobFinished(pi, job);
            queueSaveBackgroundJobStore();
          });

        return {
          content: [
            {
              type: "text",
              text: `Started background subagent job ${job.id} (${job.mode}: ${sanitizePersistedText(job.label, 500)}). Poll with {"jobAction":"status","jobId":"${job.id}"}; list jobs with {"jobAction":"list"}; cancel with {"jobAction":"cancel","jobId":"${job.id}"}.${persistenceWarning ? ` Warning: initial job persistence failed: ${sanitizePersistedText(persistenceWarning, 500)}` : ""}`,
            },
          ],
          details: makeDetails([]),
        };
      }

      return runRequest(signal, onUpdate);
    },
  });
}
