import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

interface DelegateRun {
  id: string;
  startedAt: string;
  cwd: string;
  repoRoot: string;
  workflow: string;
  branch: string;
  from?: string;
  task: string;
  logPath: string;
  pid?: number;
  command: string[];
}

interface ParsedArgs {
  workflow: string;
  branch?: string;
  repo?: string;
  from?: string;
  foreground: boolean;
  dryRun: boolean;
  task: string;
}

const DEFAULT_WORKFLOW = "archon-assist";
const LOG_ROOT = join(homedir(), ".archon", "logs", "pi-archon");
const RUNS_PATH = join(LOG_ROOT, "runs.json");
const MAX_TASK_LENGTH = 8000;

function ensureLogRoot() {
  mkdirSync(LOG_ROOT, { recursive: true });
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = tokenize(raw.trim());
  const taskParts: string[] = [];
  const parsed: ParsedArgs = {
    workflow: DEFAULT_WORKFLOW,
    foreground: false,
    dryRun: false,
    task: "",
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const readValue = (flag: string) => {
      const value = tokens[++i];
      if (!value) throw new Error(`Missing value for ${flag}`);
      return value;
    };

    if (token === "--workflow" || token === "-w") parsed.workflow = readValue(token);
    else if (token.startsWith("--workflow=")) parsed.workflow = token.slice("--workflow=".length);
    else if (token === "--branch" || token === "-b") parsed.branch = readValue(token);
    else if (token.startsWith("--branch=")) parsed.branch = token.slice("--branch=".length);
    else if (token === "--repo" || token === "--cwd" || token === "-C") parsed.repo = readValue(token);
    else if (token.startsWith("--repo=")) parsed.repo = token.slice("--repo=".length);
    else if (token.startsWith("--cwd=")) parsed.repo = token.slice("--cwd=".length);
    else if (token === "--from") parsed.from = readValue(token);
    else if (token.startsWith("--from=")) parsed.from = token.slice("--from=".length);
    else if (token === "--foreground") parsed.foreground = true;
    else if (token === "--dry-run") parsed.dryRun = true;
    else taskParts.push(token);
  }

  parsed.task = taskParts.join(" ").trim();
  if (parsed.task.length > MAX_TASK_LENGTH) {
    throw new Error(`Task is too long (${parsed.task.length} chars). Keep it under ${MAX_TASK_LENGTH}.`);
  }
  return parsed;
}

function shortStamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function slugify(value: string, maxLength = 48) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/._]+|[-/._]+$/g, "")
    .slice(0, maxLength)
    .replace(/^[-/._]+|[-/._]+$/g, "");
  return slug || "task";
}

function defaultBranch(workflow: string, task: string, repoRoot: string) {
  const prefix = workflow === DEFAULT_WORKFLOW ? "assist" : slugify(workflow.replace(/^archon-/, ""), 28);
  const repo = slugify(basename(repoRoot), 24);
  const taskSlug = slugify(task, 40);
  return `${prefix}/${repo}-${taskSlug}-${shortStamp()}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandForDisplay(args: string[]) {
  return args.map(shellQuote).join(" ");
}

function expandPath(path: string, cwd: string) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function resolveRepoRoot(cwd: string, repoArg?: string) {
  const candidate = repoArg ? expandPath(repoArg, cwd) : cwd;
  const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  return candidate;
}

function archonAvailable() {
  const result = spawnSync("archon", ["version"], { encoding: "utf8" });
  return result.status === 0 || Boolean(result.stdout || result.stderr);
}

function readRuns(): DelegateRun[] {
  ensureLogRoot();
  if (!existsSync(RUNS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(RUNS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as DelegateRun[]) : [];
  } catch {
    return [];
  }
}

function writeRuns(runs: DelegateRun[]) {
  ensureLogRoot();
  writeFileSync(RUNS_PATH, `${JSON.stringify(runs.slice(-100), null, 2)}\n`, "utf8");
}

function recordRun(run: DelegateRun) {
  const runs = readRuns().filter((existing) => existing.id !== run.id);
  runs.push(run);
  writeRuns(runs);
}

function pidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(path: string, lineCount: number) {
  if (!existsSync(path)) return `(log not found: ${path})`;
  const text = readFileSync(path, "utf8");
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-lineCount).join("\n") || "(log is empty)";
}

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "archon-delegate", content, display: true });
}

function usage() {
  return [
    "Usage:",
    "  /archon [options] <task>",
    "",
    "Options:",
    "  --workflow, -w <name>   Archon workflow to run (default: archon-assist)",
    "  --branch, -b <name>     Branch/worktree name (default: generated assist/<slug>)",
    "  --repo, --cwd, -C <dir> Target repo/path (default: current pi cwd)",
    "  --from <branch>         Archon base branch/start point",
    "  --foreground            Wait for Archon to finish instead of backgrounding",
    "  --dry-run               Show the command without starting Archon",
    "",
    "Examples:",
    "  /archon investigate the failing chat reconnect flow",
    "  /archon --repo server --workflow archon-architect simplify the API routing layer",
    "  /archon-status",
    "  /archon-status latest --tail 80",
  ].join("\n");
}

function parseStatusArgs(raw: string): { id?: string; limit: number; tailLines?: number } {
  const tokens = tokenize(raw.trim());
  let id: string | undefined;
  let limit = 8;
  let tailLines: number | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--limit" || token === "-n") {
      limit = Math.max(1, Math.min(50, Number(tokens[++i]) || limit));
    } else if (token.startsWith("--limit=")) {
      limit = Math.max(1, Math.min(50, Number(token.slice("--limit=".length)) || limit));
    } else if (token === "--tail" || token === "-t") {
      tailLines = Math.max(1, Math.min(500, Number(tokens[++i]) || 60));
    } else if (token.startsWith("--tail=")) {
      tailLines = Math.max(1, Math.min(500, Number(token.slice("--tail=".length)) || 60));
    } else {
      id = token;
    }
  }

  return { id, limit, tailLines };
}

async function runForeground(args: string[], repoRoot: string, logPath: string) {
  return await new Promise<number>((resolvePromise, reject) => {
    const fd = openSync(logPath, "a");
    const child = spawn(args[0], args.slice(1), {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function startBackground(args: string[], repoRoot: string, logPath: string) {
  const fd = openSync(logPath, "a");
  const child = spawn(args[0], args.slice(1), {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  return child.pid;
}

export default function archonDelegateExtension(pi: ExtensionAPI) {
  pi.registerCommand("archon", {
    description: "Delegate a task to Archon in an isolated branch/worktree.",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const trimmed = rawArgs.trim();
      if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
        send(pi, usage());
        return;
      }

      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(trimmed);
      } catch (error) {
        send(pi, `Archon delegate argument error: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
        return;
      }

      if (!parsed.task) {
        send(pi, `Missing task.\n\n${usage()}`);
        return;
      }
      if (!archonAvailable()) {
        send(pi, "Archon CLI was not found on PATH. Install/configure Archon before using /archon.");
        return;
      }

      ensureLogRoot();
      const repoRoot = resolveRepoRoot(ctx.cwd, parsed.repo);
      const branch = parsed.branch || defaultBranch(parsed.workflow, parsed.task, repoRoot);
      const id = `${shortStamp()}-${Math.random().toString(36).slice(2, 8)}`;
      const logPath = join(LOG_ROOT, `${id}.log`);
      const command = ["archon", "workflow", "run", parsed.workflow, "--branch", branch];
      if (parsed.from) command.push("--from", parsed.from);
      command.push(parsed.task);

      const header = [
        `# Pi Archon Delegate`,
        `startedAt=${new Date().toISOString()}`,
        `cwd=${ctx.cwd}`,
        `repoRoot=${repoRoot}`,
        `workflow=${parsed.workflow}`,
        `branch=${branch}`,
        parsed.from ? `from=${parsed.from}` : undefined,
        `command=${commandForDisplay(command)}`,
        "",
      ]
        .filter(Boolean)
        .join("\n");
      writeFileSync(logPath, header, "utf8");

      const run: DelegateRun = {
        id,
        startedAt: new Date().toISOString(),
        cwd: ctx.cwd,
        repoRoot,
        workflow: parsed.workflow,
        branch,
        from: parsed.from,
        task: parsed.task,
        logPath,
        command,
      };

      if (parsed.dryRun) {
        send(
          pi,
          [
            "Archon dry run:",
            `id: ${id}`,
            `repo: ${repoRoot}`,
            `workflow: ${parsed.workflow}`,
            `branch: ${branch}`,
            `log: ${logPath}`,
            "",
            commandForDisplay(command),
          ].join("\n"),
        );
        return;
      }

      try {
        if (parsed.foreground) {
          recordRun(run);
          send(pi, `Starting Archon in foreground. Log: ${logPath}`);
          const code = await runForeground(command, repoRoot, logPath);
          send(pi, `Archon foreground run exited with code ${code}.\n\nLog: ${logPath}\n\n${tail(logPath, 80)}`);
          return;
        }

        run.pid = startBackground(command, repoRoot, logPath);
        recordRun(run);
        send(
          pi,
          [
            "Started Archon delegate run.",
            `id: ${id}`,
            `pid: ${run.pid ?? "unknown"}`,
            `repo: ${repoRoot}`,
            `workflow: ${parsed.workflow}`,
            `branch: ${branch}`,
            `log: ${logPath}`,
            "",
            "Check later with:",
            `  /archon-status ${id} --tail 80`,
          ].join("\n"),
        );
      } catch (error) {
        send(pi, `Failed to start Archon: ${error instanceof Error ? error.message : String(error)}\nLog: ${logPath}`);
      }
    },
  });

  pi.registerCommand("archon-status", {
    description: "Show recent Archon delegate runs, or tail a specific run log.",
    handler: async (rawArgs: string) => {
      const { id, limit, tailLines } = parseStatusArgs(rawArgs);
      const runs = readRuns();
      if (runs.length === 0) {
        send(pi, "No Archon delegate runs recorded yet.");
        return;
      }

      const selected = id
        ? id === "latest"
          ? runs.at(-1)
          : runs.find((run) => run.id.startsWith(id) || run.branch === id)
        : undefined;

      if (id && !selected) {
        send(pi, `No Archon delegate run matched '${id}'.`);
        return;
      }

      if (selected) {
        const lines = [
          `Archon delegate run: ${selected.id}`,
          `status: ${pidAlive(selected.pid) ? "running" : "not running/unknown"}`,
          `started: ${selected.startedAt}`,
          `pid: ${selected.pid ?? "unknown"}`,
          `repo: ${selected.repoRoot}`,
          `workflow: ${selected.workflow}`,
          `branch: ${selected.branch}`,
          `log: ${selected.logPath}`,
          `task: ${selected.task}`,
        ];
        if (tailLines) lines.push("", `Last ${tailLines} log lines:`, tail(selected.logPath, tailLines));
        send(pi, lines.join("\n"));
        return;
      }

      const recent = runs.slice(-limit).reverse();
      send(
        pi,
        [
          `Recent Archon delegate runs (${recent.length}/${runs.length}):`,
          ...recent.map((run) => {
            const status = pidAlive(run.pid) ? "running" : "not running/unknown";
            return `- ${run.id} [${status}] ${run.workflow} ${run.branch}\n  repo: ${run.repoRoot}\n  log: ${run.logPath}`;
          }),
          "",
          "Tail latest with: /archon-status latest --tail 80",
        ].join("\n"),
      );
    },
  });
}
