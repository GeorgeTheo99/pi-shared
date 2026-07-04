import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface PanelConfig {
  preferredModels?: string[];
  compareModels?: string[];
  excludeModels?: string[];
  excludedModels?: string[];
  exclusions?: string[];
  defaultCompareCount?: number;
  modelProfileDirs?: string[];
}

interface PanelModel {
  provider: string;
  id: string;
  key: string;
  family: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
  agentDir?: string;
  source: "current" | "profile";
}

function readJsonSafe(filePath: string): PanelConfig {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PanelConfig;
  } catch {
    return {};
  }
}

function findProjectConfig(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "panel-config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function loadPanelConfig(cwd: string): PanelConfig {
  const userConfig = readJsonSafe(path.join(os.homedir(), ".pi", "panel-config.json"));
  const projectConfigPath = findProjectConfig(cwd);
  const projectConfig = projectConfigPath ? readJsonSafe(projectConfigPath) : {};
  const merged = { ...userConfig, ...projectConfig };
  // Profile directories are a trust boundary: they load another Pi config and
  // its extensions. Do not let repo-controlled project config set them.
  return { ...merged, modelProfileDirs: userConfig.modelProfileDirs };
}

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function defaultProfileDirs(): string[] {
  return [path.join(os.homedir(), ".pi-omlx", "agent"), path.join(os.homedir(), ".pi", "agent")];
}

function familyFor(provider: string, id: string): string {
  const text = `${provider}/${id}`.toLowerCase();
  const checks: Array<[string, string[]]> = [
    ["claude", ["claude", "anthropic", "sonnet", "opus", "haiku"]],
    ["gpt", ["gpt", "openai", "codex", "o1", "o3", "o4"]],
    ["gemini", ["gemini", "google"]],
    ["deepseek", ["deepseek"]],
    ["qwen", ["qwen"]],
    ["glm", ["glm", "zai"]],
    ["gemma", ["gemma"]],
    ["kimi", ["kimi", "moonshot"]],
    ["minimax", ["minimax"]],
    ["mistral", ["mistral", "mixtral"]],
    ["grok", ["grok", "xai"]],
    ["llama", ["llama"]],
  ];
  for (const [family, tokens] of checks) {
    if (tokens.some((token) => text.includes(token))) return family;
  }
  return provider.toLowerCase();
}

function toPanelModel(model: any, source: PanelModel["source"] = "current", agentDir?: string): PanelModel {
  const provider = String(model.provider ?? "");
  const id = String(model.id ?? model.model ?? "");
  const input = Array.isArray(model.input) ? model.input : [];
  return {
    provider,
    id,
    key: `${provider}/${id}`,
    family: familyFor(provider, id),
    contextWindow: Number(model.contextWindow ?? model.context_window ?? 0),
    maxTokens: Number(model.maxTokens ?? model.max_tokens ?? 0),
    reasoning: Boolean(model.reasoning),
    images: input.includes("image"),
    agentDir,
    source,
  };
}

function loadProfileModels(agentDir: string): PanelModel[] {
  const expanded = expandTilde(agentDir);
  const modelsPath = path.join(expanded, "models.json");
  const authPath = path.join(expanded, "auth.json");
  if (!fs.existsSync(modelsPath)) return [];
  try {
    const registry = ModelRegistry.create(AuthStorage.create(authPath), modelsPath);
    return registry.getAvailable().map((model) => toPanelModel(model, "profile", expanded));
  } catch {
    return [];
  }
}

function availablePanelModels(ctx: { modelRegistry: any; cwd: string }): PanelModel[] {
  const config = loadPanelConfig(ctx.cwd);
  const models = ctx.modelRegistry.getAvailable().map((model: any) => toPanelModel(model));
  const profileDirs = config.modelProfileDirs ?? defaultProfileDirs();
  for (const dir of profileDirs) models.push(...loadProfileModels(dir));

  const seen = new Set<string>();
  return models.filter((model) => {
    const identity = `${model.key}\u0000${model.agentDir ?? "current"}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(model: PanelModel, rawPattern: string): boolean {
  const pattern = rawPattern.trim().toLowerCase();
  if (!pattern) return false;
  const fields = [model.key, model.id, model.provider, model.family].map((value) => value.toLowerCase());
  if (fields.includes(pattern)) return true;
  if (pattern.includes("*")) return fields.some((field) => globToRegex(pattern).test(field));
  return fields.some((field) => field.includes(pattern));
}

function resolveModel(models: PanelModel[], pattern: string): PanelModel | undefined {
  const exact = models.find((model) => matchesPattern(model, pattern) && [model.key, model.id].some((value) => value.toLowerCase() === pattern.toLowerCase()));
  return exact ?? models.find((model) => matchesPattern(model, pattern));
}

function uniqueModels(models: PanelModel[]): PanelModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.key)) return false;
    seen.add(model.key);
    return true;
  });
}

function modelScore(model: PanelModel, currentFamily?: string, preferredRank = 999): number {
  const preference = preferredRank < 999 ? 100_000 - preferredRank * 1_000 : 0;
  const differentFamily = currentFamily && model.family !== currentFamily ? 10_000 : 0;
  const subscriptionGpt = model.provider === "openai-codex" ? 20_000 : 0;
  const apiRoutedGptPenalty = model.family === "gpt" && model.provider !== "openai-codex" ? -20_000 : 0;
  const reasoning = model.reasoning ? 500 : 0;
  return preference + differentFamily + subscriptionGpt + apiRoutedGptPenalty + reasoning + Math.floor(model.contextWindow / 10_000) + Math.floor(model.maxTokens / 10_000);
}

function orderedCandidates(models: PanelModel[], config: PanelConfig, current?: PanelModel, mode = "single"): PanelModel[] {
  const exclusions = [...(config.excludeModels ?? []), ...(config.excludedModels ?? []), ...(config.exclusions ?? [])];
  const candidates = models.filter((model) => !exclusions.some((pattern) => matchesPattern(model, pattern)));
  const preferred = mode === "compare" ? config.compareModels ?? config.preferredModels ?? [] : config.preferredModels ?? [];

  return [...candidates].sort((a, b) => {
    const aRank = preferred.findIndex((pattern) => matchesPattern(a, pattern));
    const bRank = preferred.findIndex((pattern) => matchesPattern(b, pattern));
    return modelScore(b, current?.family, bRank < 0 ? 999 : bRank) - modelScore(a, current?.family, aRank < 0 ? 999 : aRank);
  });
}

function selectModels(models: PanelModel[], config: PanelConfig, options: { current?: string; explicit?: string[]; mode?: string; count?: number }) {
  const current = options.current ? resolveModel(models, options.current) : undefined;
  const mode = options.mode === "compare" ? "compare" : "single";
  const explicitPatterns = options.explicit?.map((pattern) => pattern.trim()).filter(Boolean) ?? [];
  const resolvedExplicit: PanelModel[] = [];
  const unresolvedExplicit: string[] = [];
  for (const pattern of explicitPatterns) {
    const resolved = resolveModel(models, pattern);
    if (resolved) resolvedExplicit.push(resolved);
    else unresolvedExplicit.push(pattern);
  }
  const explicit = uniqueModels(resolvedExplicit);
  if (explicitPatterns.length > 0) return { selected: explicit, current, mode, unresolved: unresolvedExplicit };

  const count = Math.max(1, Math.min(8, options.count ?? config.defaultCompareCount ?? (mode === "compare" ? 3 : 1)));
  const ordered = orderedCandidates(models, config, current, mode).filter((model) => model.key !== current?.key);

  if (mode === "single") {
    const selected = ordered.find((model) => model.family !== current?.family) ?? ordered[0] ?? models[0];
    return { selected: selected ? [selected] : [], current, mode, unresolved: [] };
  }

  const selected: PanelModel[] = [];
  const families = new Set<string>();
  for (const model of ordered) {
    if (selected.length >= count) break;
    if (!families.has(model.family)) {
      selected.push(model);
      families.add(model.family);
    }
  }
  for (const model of ordered) {
    if (selected.length >= count) break;
    if (!selected.some((item) => item.key === model.key)) selected.push(model);
  }
  return { selected, current, mode, unresolved: [] };
}

function formatModel(model: PanelModel): string {
  const context = model.contextWindow ? ` ctx:${Math.round(model.contextWindow / 1000)}K` : "";
  const thinking = model.reasoning ? " thinking" : "";
  const profile = model.agentDir ? ` profile:${model.agentDir}` : "";
  return `${model.key} (${model.family}${context}${thinking}${profile})`;
}

function formatModelList(models: PanelModel[], search?: string): string {
  const filtered = search ? models.filter((model) => matchesPattern(model, search)) : models;
  if (filtered.length === 0) return search ? `No panel models matched: ${search}` : "No available panel models.";
  const grouped = new Map<string, PanelModel[]>();
  for (const model of filtered) grouped.set(model.family, [...(grouped.get(model.family) ?? []), model]);
  const lines = [`Available panel models: ${filtered.length}`];
  for (const [family, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`\n## ${family}`);
    for (const model of items.sort((a, b) => a.key.localeCompare(b.key))) lines.push(`- ${formatModel(model)}`);
  }
  return lines.join("\n");
}

function panelPrompt(args: string): string {
  const trimmed = args.trim();
  return `Use the panel skill to run a second-opinion Pi panel for the current conversation.\n\nOriginal /panel arguments: ${trimmed || "(none)"}\n\nFollow the panel workflow: list/select models with panel_models or panel_select, then call spawn_subagent with agent=panelist. If --compare is present, run parallel panelists with different task-specific models and synthesize the results. If no explicit task is provided, summarize the latest relevant user request, decisions, code/files, and open question from this conversation into the panelist prompt.`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("panel", {
    description: "Ask an alternate-model Pi panelist for a second opinion, or compare multiple models",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const models = availablePanelModels(ctx);

      if (["--help", "help", "-h"].includes(trimmed)) {
        pi.sendMessage({
          customType: "panel",
          display: true,
          content: [
            "Usage:",
            "  /panel                       Second opinion on the current conversation",
            "  /panel <task>                Second opinion on an explicit task/question",
            "  /panel <model> <task>        Use a specific model pattern",
            "  /panel --compare [task]      Compare 2-3 different model families",
            "  /panel --list [search]       List available models",
            "",
            "Optional config: ~/.pi/panel-config.json and .pi/panel-config.json",
          ].join("\n"),
        });
        return;
      }

      if (trimmed === "--list" || trimmed === "models" || trimmed.startsWith("--list ") || trimmed.startsWith("models ")) {
        const search = trimmed.replace(/^--list\s*/, "").replace(/^models\s*/, "").trim() || undefined;
        pi.sendMessage({ customType: "panel", display: true, content: formatModelList(models, search) });
        return;
      }

      if (ctx.isIdle()) pi.sendUserMessage(panelPrompt(trimmed));
      else pi.sendUserMessage(panelPrompt(trimmed), { deliverAs: "followUp" });
    },
  });

  pi.registerTool({
    name: "panel_models",
    label: "Panel Models",
    description: "List available Pi models grouped by model family for the /panel second-opinion workflow.",
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Optional model/provider/family search pattern" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const models = availablePanelModels(ctx);
      return {
        content: [{ type: "text", text: formatModelList(models, params.search) }],
        details: { models: models.filter((model) => !params.search || matchesPattern(model, params.search)) },
      };
    },
  });

  pi.registerTool({
    name: "panel_select",
    label: "Panel Select",
    description: "Select alternate models for the /panel second-opinion workflow using runtime model discovery and optional panel config.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "single or compare. Defaults to single." })),
      currentModel: Type.Optional(Type.String({ description: "Current model as provider/model. Defaults to the active session model." })),
      models: Type.Optional(Type.Array(Type.String(), { description: "Explicit model patterns to resolve and use." })),
      count: Type.Optional(Type.Number({ description: "Number of models for compare mode. Defaults to config or 3." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const allModels = availablePanelModels(ctx);
      const config = loadPanelConfig(ctx.cwd);
      const currentModel = params.currentModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const { selected, current, mode, unresolved } = selectModels(allModels, config, {
        current: currentModel,
        explicit: params.models,
        mode: params.mode,
        count: params.count,
      });

      const text = selected.length
        ? [
            `Panel mode: ${mode}`,
            current ? `Current model: ${formatModel(current)}` : undefined,
            unresolved.length ? `Unresolved explicit pattern(s): ${unresolved.join(", ")}` : undefined,
            "Selected model(s):",
            ...selected.map((model) => `- ${formatModel(model)}`),
            "",
            "Use these values as `model` overrides in `spawn_subagent` calls; include `agentDir` for any selected model that has a profile.",
          ]
            .filter(Boolean)
            .join("\n")
        : unresolved.length
          ? `No explicit panel model pattern matched: ${unresolved.join(", ")}`
          : "No available models matched the panel selection criteria.";

      return { content: [{ type: "text", text }], details: { selected, current, mode, unresolved, config } };
    },
  });
}
