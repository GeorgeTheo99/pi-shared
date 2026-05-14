import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "shared" | "user" | "project" | "all";
export type AgentSource = "shared" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  sharedAgentsDir: string;
  userAgentsDir: string;
  projectAgentsDir: string | null;
}

function extensionDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function sharedAgentsDir() {
  return path.join(extensionDir(), "agents");
}

function parseTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.map((item) => String(item).trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (typeof value === "string") {
    const tools = value
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) continue;

    const model = typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
    agents.push({
      name,
      description,
      tools: parseTools(frontmatter.tools),
      model,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function mergeAgents(groups: AgentConfig[][]): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const group of groups) {
    for (const agent of group) byName.set(agent.name, agent);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const sharedDir = sharedAgentsDir();
  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const sharedAgents = scope === "shared" || scope === "all" ? loadAgentsFromDir(sharedDir, "shared") : [];
  const userAgents = scope === "user" || scope === "all" ? loadAgentsFromDir(userDir, "user") : [];
  const projectAgents =
    (scope === "project" || scope === "all") && projectDir ? loadAgentsFromDir(projectDir, "project") : [];

  return {
    agents: mergeAgents([sharedAgents, userAgents, projectAgents]),
    sharedAgentsDir: sharedDir,
    userAgentsDir: userDir,
    projectAgentsDir: projectDir,
  };
}

export function formatAgentList(agents: AgentConfig[]) {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n");
}
