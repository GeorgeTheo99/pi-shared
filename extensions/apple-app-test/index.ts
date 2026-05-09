import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ARTIFACT_ROOT = join(homedir(), ".pi", "apple-app-test");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 24_000;

type Platform = "ios" | "macos";
type ProjectKind = "project" | "workspace";

interface XcodeRef {
  kind: ProjectKind;
  path: string;
}

interface AppleOptions {
  cwd?: string;
  project?: string;
  workspace?: string;
  scheme?: string;
  configuration: string;
  platform?: Platform;
  device?: string;
  bundleId?: string;
  derivedData?: string;
  app?: string;
  timeoutMs: number;
  dryRun: boolean;
  noBuild: boolean;
  last: string;
  output?: string;
  extra: string[];
}

interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "apple-app-test", content, display: true });
}

function usage(command?: string) {
  const common = [
    "Common options:",
    "  --cwd <dir>                 Repo/project directory (default: current pi cwd)",
    "  --project <path>            .xcodeproj path",
    "  --workspace <path>          .xcworkspace path",
    "  --scheme <name>             Xcode scheme (default: first listed scheme)",
    "  --platform ios|macos        Target platform",
    "  --configuration <name>      Default: Debug",
    "  --derived-data <path>       Default: ~/.pi/apple-app-test/DerivedData/<project-scheme-platform>",
    "  --timeout <seconds>         Default: 600",
    "  --dry-run                   Show command without executing",
  ];

  const all = [
    "Apple app testing commands:",
    "  /apple-detect [options]",
    "  /apple-simulators",
    "  /apple-build [options]",
    "  /apple-run [options] [--no-build] [--bundle-id <id>]",
    "  /apple-test [options]",
    "  /apple-screenshot --platform ios|macos [--device <name-or-udid>] [--output <path>]",
    "  /apple-logs --platform ios|macos [--last 2m] [--bundle-id <id>] [--scheme <name>]",
    "",
    ...common,
    "",
    "GreekFlow examples:",
    "  /apple-detect --cwd ~/local_code/LanguageLearning/GreekFlow",
    "  /apple-run --cwd ~/local_code/LanguageLearning/GreekFlow --platform ios",
    "  /apple-screenshot --platform ios",
    "  /apple-logs --platform ios --scheme LanguageFlow --last 5m",
  ].join("\n");

  if (!command) return all;
  return all;
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
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseOptions(raw: string, ctx: ExtensionCommandContext): AppleOptions {
  const tokens = tokenize(raw);
  const opts: AppleOptions = {
    configuration: "Debug",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
    noBuild: false,
    last: "2m",
    extra: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const readValue = (flag: string) => {
      const value = tokens[++i];
      if (!value) throw new Error(`Missing value for ${flag}`);
      return value;
    };

    if (token === "--cwd" || token === "-C") opts.cwd = readValue(token);
    else if (token.startsWith("--cwd=")) opts.cwd = token.slice("--cwd=".length);
    else if (token === "--project") opts.project = readValue(token);
    else if (token.startsWith("--project=")) opts.project = token.slice("--project=".length);
    else if (token === "--workspace") opts.workspace = readValue(token);
    else if (token.startsWith("--workspace=")) opts.workspace = token.slice("--workspace=".length);
    else if (token === "--scheme") opts.scheme = readValue(token);
    else if (token.startsWith("--scheme=")) opts.scheme = token.slice("--scheme=".length);
    else if (token === "--configuration" || token === "--config") opts.configuration = readValue(token);
    else if (token.startsWith("--configuration=")) opts.configuration = token.slice("--configuration=".length);
    else if (token === "--platform") opts.platform = parsePlatform(readValue(token));
    else if (token.startsWith("--platform=")) opts.platform = parsePlatform(token.slice("--platform=".length));
    else if (token === "--device") opts.device = readValue(token);
    else if (token.startsWith("--device=")) opts.device = token.slice("--device=".length);
    else if (token === "--bundle-id") opts.bundleId = readValue(token);
    else if (token.startsWith("--bundle-id=")) opts.bundleId = token.slice("--bundle-id=".length);
    else if (token === "--derived-data") opts.derivedData = readValue(token);
    else if (token.startsWith("--derived-data=")) opts.derivedData = token.slice("--derived-data=".length);
    else if (token === "--app") opts.app = readValue(token);
    else if (token.startsWith("--app=")) opts.app = token.slice("--app=".length);
    else if (token === "--timeout") opts.timeoutMs = Number(readValue(token)) * 1000;
    else if (token.startsWith("--timeout=")) opts.timeoutMs = Number(token.slice("--timeout=".length)) * 1000;
    else if (token === "--last") opts.last = readValue(token);
    else if (token.startsWith("--last=")) opts.last = token.slice("--last=".length);
    else if (token === "--output" || token === "-o") opts.output = readValue(token);
    else if (token.startsWith("--output=")) opts.output = token.slice("--output=".length);
    else if (token === "--dry-run") opts.dryRun = true;
    else if (token === "--no-build") opts.noBuild = true;
    else if (token === "--") opts.extra.push(...tokens.slice(i + 1));
    else opts.extra.push(token);
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) opts.timeoutMs = DEFAULT_TIMEOUT_MS;
  opts.cwd = expandPath(opts.cwd ?? ctx.cwd, ctx.cwd);
  if (opts.project) opts.project = expandPath(opts.project, opts.cwd);
  if (opts.workspace) opts.workspace = expandPath(opts.workspace, opts.cwd);
  if (opts.derivedData) opts.derivedData = expandPath(opts.derivedData, opts.cwd);
  if (opts.app) opts.app = expandPath(opts.app, opts.cwd);
  if (opts.output) opts.output = expandPath(opts.output, opts.cwd);
  return opts;
}

function parsePlatform(value: string): Platform {
  const lower = value.toLowerCase();
  if (lower === "ios" || lower === "iphone" || lower === "simulator") return "ios";
  if (lower === "macos" || lower === "mac" || lower === "osx") return "macos";
  throw new Error(`Invalid platform '${value}'. Use ios or macos.`);
}

function expandPath(path: string, cwd: string) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "apple-app";
}

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function commandLine(command: string, args: string[]) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function summarizeResult(result: CommandResult) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const clipped = output.length > MAX_OUTPUT_CHARS ? `${output.slice(-MAX_OUTPUT_CHARS)}\n...[output clipped to last ${MAX_OUTPUT_CHARS} chars]` : output;
  const status = result.error ? `error: ${result.error.message}` : `exit: ${result.status}${result.signal ? ` signal: ${result.signal}` : ""}`;
  return `${status}${clipped ? `\n\n${clipped}` : ""}`;
}

function findXcodeRef(opts: AppleOptions): XcodeRef {
  if (opts.workspace) return { kind: "workspace", path: opts.workspace };
  if (opts.project) return { kind: "project", path: opts.project };

  const entries = safeReaddir(opts.cwd ?? process.cwd());
  const workspaces = entries.filter((name) => name.endsWith(".xcworkspace"));
  const projects = entries.filter((name) => name.endsWith(".xcodeproj"));
  if (workspaces.length) return { kind: "workspace", path: join(opts.cwd ?? process.cwd(), workspaces[0]) };
  if (projects.length) return { kind: "project", path: join(opts.cwd ?? process.cwd(), projects[0]) };
  throw new Error(`No .xcodeproj or .xcworkspace found in ${opts.cwd}`);
}

function safeReaddir(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function refArgs(ref: XcodeRef) {
  return ref.kind === "workspace" ? ["-workspace", ref.path] : ["-project", ref.path];
}

function xcodeList(ref: XcodeRef, cwd: string) {
  const json = run("xcodebuild", ["-list", "-json", ...refArgs(ref)], cwd, 60_000);
  if (json.status === 0 && json.stdout.trim()) {
    try {
      return JSON.parse(json.stdout) as { project?: { schemes?: string[]; targets?: string[]; configurations?: string[] }; workspace?: { schemes?: string[] } };
    } catch {
      // Fall back below.
    }
  }
  const text = run("xcodebuild", ["-list", ...refArgs(ref)], cwd, 60_000);
  return { raw: text.stdout || text.stderr };
}

function getSchemes(list: unknown): string[] {
  const data = list as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
  return data.project?.schemes ?? data.workspace?.schemes ?? [];
}

function resolveScheme(opts: AppleOptions, ref: XcodeRef) {
  if (opts.scheme) return opts.scheme;
  const schemes = getSchemes(xcodeList(ref, opts.cwd ?? process.cwd()));
  if (schemes.length) return schemes[0];
  throw new Error("No scheme provided and no schemes were detected.");
}

function defaultDerivedData(opts: AppleOptions, ref: XcodeRef, scheme: string, platform: Platform) {
  if (opts.derivedData) return opts.derivedData;
  return join(ARTIFACT_ROOT, "DerivedData", slugify(`${basename(ref.path)}-${scheme}-${platform}`));
}

function buildArgs(opts: AppleOptions, ref: XcodeRef, scheme: string, platform: Platform, derivedData: string, action: "build" | "test") {
  const args = [
    ...refArgs(ref),
    "-scheme",
    scheme,
    "-configuration",
    opts.configuration,
    "-derivedDataPath",
    derivedData,
  ];

  if (platform === "ios") {
    const device = selectSimulator(opts.device);
    args.push("-sdk", "iphonesimulator", "-destination", `id=${device.udid}`);
  } else {
    args.push("-destination", "platform=macOS");
  }

  args.push(action);
  return args;
}

interface SimulatorDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  runtime: string;
}

function listSimulators(): SimulatorDevice[] {
  const result = run("xcrun", ["simctl", "list", "devices", "available", "-j"], process.cwd(), 30_000);
  if (result.status !== 0) throw new Error(`simctl list failed: ${summarizeResult(result)}`);
  const parsed = JSON.parse(result.stdout) as { devices: Record<string, Array<Omit<SimulatorDevice, "runtime">>> };
  const devices: SimulatorDevice[] = [];
  for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
    for (const device of runtimeDevices) devices.push({ ...device, runtime });
  }
  return devices.filter((device) => device.isAvailable);
}

function selectSimulator(selector?: string): SimulatorDevice {
  const devices = listSimulators();
  if (selector) {
    const lower = selector.toLowerCase();
    const found = devices.find((device) => device.udid === selector || device.name.toLowerCase() === lower || device.name.toLowerCase().includes(lower));
    if (found) return found;
    throw new Error(`No available simulator matched '${selector}'.`);
  }
  const bootedPhone = devices.find((device) => device.state === "Booted" && /iphone/i.test(device.name));
  if (bootedPhone) return bootedPhone;
  const phone = devices.find((device) => /iphone/i.test(device.name));
  if (phone) return phone;
  if (devices[0]) return devices[0];
  throw new Error("No available iOS simulators found.");
}

function walk(dir: string, predicate: (path: string) => boolean, maxDepth = 8): string[] {
  const out: string[] = [];
  function visit(path: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (predicate(full)) out.push(full);
        else visit(full, depth + 1);
      } else if (predicate(full)) out.push(full);
    }
  }
  visit(dir, 0);
  return out;
}

function findBuiltApp(derivedData: string, scheme: string, platform: Platform): string | undefined {
  if (!existsSync(derivedData)) return undefined;
  const apps = walk(derivedData, (path) => extname(path) === ".app", 9);
  const preferred = apps.filter((path) => basename(path) === `${scheme}.app`);
  const candidates = preferred.length ? preferred : apps;
  const platformHint = platform === "ios" ? "iphonesimulator" : "Debug";
  return candidates.find((path) => path.includes(platformHint)) ?? candidates[0];
}

function readBundleId(appPath: string): string | undefined {
  const plist = join(appPath, "Info.plist");
  if (!existsSync(plist)) return undefined;
  const result = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], dirname(appPath), 10_000);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function ensureArtifactDir(...parts: string[]) {
  const dir = join(ARTIFACT_ROOT, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function maybeDryRun(pi: ExtensionAPI, opts: AppleOptions, cwd: string, command: string, args: string[]) {
  if (!opts.dryRun) return false;
  send(pi, [`Dry run:`, `cwd: ${cwd}`, commandLine(command, args)].join("\n"));
  return true;
}

function detect(pi: ExtensionAPI, opts: AppleOptions) {
  const ref = findXcodeRef(opts);
  const list = xcodeList(ref, opts.cwd ?? process.cwd());
  const schemes = getSchemes(list);
  send(
    pi,
    [
      "Apple project detected.",
      `cwd: ${opts.cwd}`,
      `${ref.kind}: ${ref.path}`,
      `schemes: ${schemes.length ? schemes.join(", ") : "(none detected)"}`,
      "",
      "Raw xcodebuild list:",
      JSON.stringify(list, null, 2),
    ].join("\n"),
  );
}

function build(pi: ExtensionAPI, opts: AppleOptions, action: "build" | "test" = "build") {
  const ref = findXcodeRef(opts);
  const scheme = resolveScheme(opts, ref);
  const platform = opts.platform ?? "ios";
  const derivedData = defaultDerivedData(opts, ref, scheme, platform);
  mkdirSync(derivedData, { recursive: true });
  const args = buildArgs(opts, ref, scheme, platform, derivedData, action);
  if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "xcodebuild", args)) return { ref, scheme, platform, derivedData };
  const result = run("xcodebuild", args, opts.cwd ?? process.cwd(), opts.timeoutMs);
  const app = findBuiltApp(derivedData, scheme, platform);
  send(
    pi,
    [
      `Apple ${action} finished.`,
      `platform: ${platform}`,
      `scheme: ${scheme}`,
      `derivedData: ${derivedData}`,
      app ? `app: ${app}` : undefined,
      "",
      summarizeResult(result),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { ref, scheme, platform, derivedData, result, app };
}

function runApp(pi: ExtensionAPI, opts: AppleOptions) {
  const ref = findXcodeRef(opts);
  const scheme = resolveScheme(opts, ref);
  const platform = opts.platform ?? "ios";
  const derivedData = defaultDerivedData(opts, ref, scheme, platform);

  let app = opts.app;
  if (!opts.noBuild) {
    const built = build(pi, opts, "build");
    app = built?.app;
  } else {
    app = opts.app ?? findBuiltApp(derivedData, scheme, platform);
  }
  if (!app) throw new Error(`Could not find built .app. Build first or pass --app <path>. DerivedData: ${derivedData}`);

  if (platform === "ios") {
    const device = selectSimulator(opts.device);
    const bundleId = opts.bundleId ?? readBundleId(app);
    if (!bundleId) throw new Error(`Could not determine bundle id from ${app}; pass --bundle-id.`);
    const bootArgs = ["simctl", "boot", device.udid];
    if (!opts.dryRun) run("xcrun", bootArgs, opts.cwd ?? process.cwd(), 60_000);
    const installArgs = ["simctl", "install", device.udid, app];
    if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "xcrun", installArgs)) return;
    const install = run("xcrun", installArgs, opts.cwd ?? process.cwd(), 120_000);
    const launchArgs = ["simctl", "launch", device.udid, bundleId];
    const launch = run("xcrun", launchArgs, opts.cwd ?? process.cwd(), 60_000);
    send(pi, [`iOS app launched.`, `device: ${device.name} (${device.udid})`, `bundleId: ${bundleId}`, `app: ${app}`, "", "Install:", summarizeResult(install), "", "Launch:", summarizeResult(launch)].join("\n"));
    return;
  }

  const args = ["-a", app];
  if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "open", args)) return;
  const result = run("open", args, opts.cwd ?? process.cwd(), 30_000);
  send(pi, [`macOS app launched.`, `app: ${app}`, "", summarizeResult(result)].join("\n"));
}

function screenshot(pi: ExtensionAPI, opts: AppleOptions) {
  const platform = opts.platform ?? "ios";
  const output = opts.output ?? join(ensureArtifactDir("screenshots"), `${stamp()}-${platform}.png`);
  mkdirSync(dirname(output), { recursive: true });

  if (platform === "ios") {
    const device = selectSimulator(opts.device);
    const args = ["simctl", "io", device.udid, "screenshot", output];
    if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "xcrun", args)) return;
    const result = run("xcrun", args, opts.cwd ?? process.cwd(), 60_000);
    send(pi, [`iOS screenshot captured.`, `device: ${device.name} (${device.udid})`, `output: ${output}`, "", summarizeResult(result)].join("\n"));
    return;
  }

  const args = ["-x", output];
  if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "screencapture", args)) return;
  const result = run("screencapture", args, opts.cwd ?? process.cwd(), 60_000);
  send(pi, [`macOS screenshot captured.`, `output: ${output}`, "", summarizeResult(result)].join("\n"));
}

function logs(pi: ExtensionAPI, opts: AppleOptions) {
  const platform = opts.platform ?? "ios";
  const scheme = opts.scheme ?? "";
  const bundleId = opts.bundleId ?? "";
  const predicateParts = [
    scheme ? `process == "${scheme.replace(/"/g, "")}"` : undefined,
    bundleId ? `subsystem == "${bundleId.replace(/"/g, "")}"` : undefined,
    bundleId ? `processImagePath CONTAINS "${bundleId.split(".").at(-1)?.replace(/"/g, "") ?? ""}"` : undefined,
  ].filter(Boolean);
  const predicate = predicateParts.length ? predicateParts.join(" OR ") : undefined;

  if (platform === "ios") {
    const device = selectSimulator(opts.device);
    const args = ["simctl", "spawn", device.udid, "log", "show", "--style", "compact", "--last", opts.last];
    if (predicate) args.push("--predicate", predicate);
    if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "xcrun", args)) return;
    const result = run("xcrun", args, opts.cwd ?? process.cwd(), 60_000);
    send(pi, [`iOS logs.`, `device: ${device.name} (${device.udid})`, `last: ${opts.last}`, predicate ? `predicate: ${predicate}` : undefined, "", summarizeResult(result)].filter(Boolean).join("\n"));
    return;
  }

  const args = ["show", "--style", "compact", "--last", opts.last];
  if (predicate) args.push("--predicate", predicate);
  if (maybeDryRun(pi, opts, opts.cwd ?? process.cwd(), "log", args)) return;
  const result = run("log", args, opts.cwd ?? process.cwd(), 60_000);
  send(pi, [`macOS logs.`, `last: ${opts.last}`, predicate ? `predicate: ${predicate}` : undefined, "", summarizeResult(result)].filter(Boolean).join("\n"));
}

function simulators(pi: ExtensionAPI) {
  const devices = listSimulators();
  const lines = devices.map((device) => `- ${device.name} (${device.udid}) [${device.state}] ${device.runtime}`);
  send(pi, [`Available Apple simulators:`, ...lines].join("\n"));
}

export default function appleAppTestExtension(pi: ExtensionAPI) {
  pi.registerCommand("apple-detect", {
    description: "Detect Xcode project/workspace and schemes for Apple app testing.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        detect(pi, opts);
      } catch (error) {
        send(pi, `apple-detect failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("detect")}`);
      }
    },
  });

  pi.registerCommand("apple-simulators", {
    description: "List available iOS simulators.",
    handler: async () => {
      try {
        simulators(pi);
      } catch (error) {
        send(pi, `apple-simulators failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerCommand("apple-build", {
    description: "Build an iOS Simulator or macOS app with xcodebuild.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        build(pi, opts, "build");
      } catch (error) {
        send(pi, `apple-build failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("build")}`);
      }
    },
  });

  pi.registerCommand("apple-test", {
    description: "Run xcodebuild test for an iOS Simulator or macOS scheme.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        build(pi, opts, "test");
      } catch (error) {
        send(pi, `apple-test failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("test")}`);
      }
    },
  });

  pi.registerCommand("apple-run", {
    description: "Build/install/launch an iOS Simulator app or build/open a macOS app.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        runApp(pi, opts);
      } catch (error) {
        send(pi, `apple-run failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("run")}`);
      }
    },
  });

  pi.registerCommand("apple-screenshot", {
    description: "Capture an iOS Simulator or macOS screenshot.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        screenshot(pi, opts);
      } catch (error) {
        send(pi, `apple-screenshot failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("screenshot")}`);
      }
    },
  });

  pi.registerCommand("apple-logs", {
    description: "Show recent iOS Simulator or macOS logs.",
    handler: async (rawArgs, ctx) => {
      try {
        const opts = parseOptions(rawArgs, ctx);
        logs(pi, opts);
      } catch (error) {
        send(pi, `apple-logs failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage("logs")}`);
      }
    },
  });
}
