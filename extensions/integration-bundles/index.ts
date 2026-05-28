/**
 * integration-bundles
 *
 * Lazy tool-bundle loader driven by `pi-shared/master_integration_list.yaml`.
 *
 * - Hides non-default bundles' tools at startup via `pi.setActiveTools`.
 * - Exposes router tools so the model can load/unload/list bundles on demand.
 * - Auto-loads bundles whose regex `triggers` match the user message.
 * - Injects `<available_bundles>` into the system prompt with NL descriptions
 *   so the model can self-discover when to load each bundle.
 * - Enforces a per-model active-tool cap (e.g. <=120 for gpt-* / o-series to
 *   stay under OpenAI's 128-tool API hard limit), evicting LRU-loaded
 *   bundles first.
 *
 * Note: this extension does NOT register the underlying enterprise tools —
 * `pi-enterprise` does that. It only controls visibility (active set) of
 * tools that are already registered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "yaml";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// YAML schema
// ---------------------------------------------------------------------------

interface BundleDef {
	summary?: string;
	description: string;
	tools: string[]; // glob patterns ("*" suffix)
	triggers?: string[]; // regex strings
}

interface ModelOverride {
	max_tools: number | null;
	strategy?: "all" | "trigger-based" | string;
}

interface MasterList {
	version: number;
	bundles: Record<string, BundleDef>;
	defaults: {
		always_load?: string[];
		model_always_load?: Record<string, string[]>;
		router_tools?: string[];
		model_overrides?: Record<string, ModelOverride>;
	};
}

// ---------------------------------------------------------------------------
// YAML discovery
// ---------------------------------------------------------------------------

function findMasterList(): { path: string; data: MasterList } | null {
	const candidates = [
		process.env.PI_INTEGRATION_LIST,
		path.join(os.homedir(), "local_code", "pi-shared", "master_integration_list.yaml"),
		path.join(os.homedir(), ".pi", "agent", "master_integration_list.yaml"),
	].filter((p): p is string => Boolean(p));

	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const raw = fs.readFileSync(candidate, "utf8");
			const data = yaml.parse(raw) as MasterList;
			if (data && typeof data === "object" && data.bundles) {
				return { path: candidate, data };
			}
		} catch {
			// continue
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tool name globbing
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function matchToolNames(allTools: string[], patterns: string[]): string[] {
	const matched = new Set<string>();
	for (const pattern of patterns) {
		const re = globToRegex(pattern);
		for (const name of allTools) {
			if (re.test(name)) matched.add(name);
		}
	}
	return [...matched];
}

function modelMatches(modelId: string, glob: string): boolean {
	return globToRegex(glob).test(modelId);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BundleState {
	def: BundleDef;
	tools: string[]; // resolved tool names (after glob expansion)
	loaded: boolean;
	loadedAt: number; // for LRU eviction
	source: "default" | "trigger" | "model" | "user";
}

interface SkillBundleHint {
	name: string;
	requires: string[];
}

interface ExtensionState {
	listPath: string | null;
	master: MasterList | null;
	bundles: Map<string, BundleState>;
	routerTools: Set<string>;
	currentModelId: string | null;
	skillHints: SkillBundleHint[];
}

// ---------------------------------------------------------------------------
// Active-set helpers
// ---------------------------------------------------------------------------

/** Compute the union of tools we want active right now. */
function computeDesiredActiveSet(state: ExtensionState, allTools: string[]): string[] {
	const desired = new Set<string>();

	// 1. All non-bundle tools (built-ins + non-enterprise extensions) stay on.
	const allBundleTools = new Set<string>();
	for (const b of state.bundles.values()) {
		for (const t of b.tools) allBundleTools.add(t);
	}
	for (const name of allTools) {
		if (!allBundleTools.has(name)) desired.add(name);
	}

	// 2. Router tools always on.
	for (const name of state.routerTools) {
		if (allTools.includes(name)) desired.add(name);
	}

	// 3. Tools from currently-loaded bundles.
	for (const b of state.bundles.values()) {
		if (!b.loaded) continue;
		for (const t of b.tools) desired.add(t);
	}

	return [...desired];
}

function resolveModelOverride(state: ExtensionState): ModelOverride | null {
	const overrides = state.master?.defaults?.model_overrides;
	if (!overrides) return null;
	const id = state.currentModelId ?? "";
	let best: { glob: string; o: ModelOverride } | null = null;
	for (const [glob, o] of Object.entries(overrides)) {
		if (!modelMatches(id, glob)) continue;
		// Prefer the more specific glob (longer non-* prefix).
		if (!best || glob.replace(/\*/g, "").length > best.glob.replace(/\*/g, "").length) {
			best = { glob, o };
		}
	}
	return best?.o ?? null;
}

/**
 * Apply model cap by evicting LRU bundles until the active set fits.
 * Returns the evicted bundle names.
 */
function enforceModelCap(state: ExtensionState, allTools: string[]): string[] {
	const override = resolveModelOverride(state);
	const cap = override?.max_tools;
	if (cap == null) return [];

	const desired = computeDesiredActiveSet(state, allTools);
	if (desired.length <= cap) return [];

	// Need to evict. Pick LRU bundles (oldest loadedAt first) that are not
	// in defaults.always_load.
	const alwaysLoad = new Set(state.master?.defaults?.always_load ?? []);
	const evictable = [...state.bundles.entries()]
		.filter(([name, b]) => b.loaded && !alwaysLoad.has(name))
		.sort((a, b) => a[1].loadedAt - b[1].loadedAt);

	const evicted: string[] = [];
	let projected = desired.length;
	for (const [name, b] of evictable) {
		if (projected <= cap) break;
		b.loaded = false;
		projected -= b.tools.length;
		evicted.push(name);
	}
	return evicted;
}

function applyActiveSet(pi: ExtensionAPI, state: ExtensionState): void {
	const allTools = pi.getAllTools().map((t) => t.name);
	enforceModelCap(state, allTools);
	const desired = computeDesiredActiveSet(state, allTools);
	pi.setActiveTools(desired);
}

// ---------------------------------------------------------------------------
// Bundle ops
// ---------------------------------------------------------------------------

function loadBundle(
	state: ExtensionState,
	name: string,
	source: BundleState["source"],
): { ok: boolean; reason?: string } {
	const b = state.bundles.get(name);
	if (!b) return { ok: false, reason: `Unknown bundle: ${name}` };
	if (b.loaded) return { ok: true };
	b.loaded = true;
	b.loadedAt = Date.now();
	b.source = source;
	return { ok: true };
}

function unloadBundle(state: ExtensionState, name: string): { ok: boolean; reason?: string } {
	const b = state.bundles.get(name);
	if (!b) return { ok: false, reason: `Unknown bundle: ${name}` };
	if (!b.loaded) return { ok: true };
	b.loaded = false;
	return { ok: true };
}

/**
 * Walk the standard pi skill roots, parse SKILL.md (or *.md root) front-matter
 * with the YAML library, and pull out an optional `requires_bundles:` field.
 * Pi's skill loader ignores unknown front-matter fields, so we re-parse
 * ourselves to support skill-driven bundle loading.
 */
function discoverSkillHints(): SkillBundleHint[] {
	const hints: SkillBundleHint[] = [];
	const roots = [
		path.join(os.homedir(), ".pi", "agent", "skills"),
		path.join(os.homedir(), "local_code", "pi-shared", "skills"),
		path.join(os.homedir(), "local_code", "pi-local", "skills"),
		path.join(process.cwd(), ".pi", "skills"),
	];
	const seen = new Set<string>();
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			let skillPath: string | null = null;
			let skillName: string;
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const candidate = path.join(root, entry.name, "SKILL.md");
				if (fs.existsSync(candidate)) {
					skillPath = candidate;
					skillName = entry.name;
				} else {
					continue;
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				skillPath = path.join(root, entry.name);
				skillName = entry.name.replace(/\.md$/, "");
			} else {
				continue;
			}
			if (!skillPath || seen.has(skillName)) continue;
			seen.add(skillName);
			try {
				const raw = fs.readFileSync(skillPath, "utf8");
				const fm = extractFrontmatter(raw);
				if (!fm) continue;
				const parsed = yaml.parse(fm) as Record<string, unknown> | null;
				if (!parsed) continue;
				const requires = parsed.requires_bundles ?? parsed["requires-bundles"];
				if (Array.isArray(requires)) {
					const names = requires.filter((x): x is string => typeof x === "string");
					if (names.length > 0) hints.push({ name: skillName, requires: names });
				}
			} catch {
				// ignore unreadable / malformed skill files
			}
		}
	}
	return hints;
}

function extractFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return null;
	return content.slice(3, end).replace(/^\n/, "");
}

function autoLoadBySkillMention(state: ExtensionState, userMessage: string): string[] {
	if (!userMessage || state.skillHints.length === 0) return [];
	const loaded: string[] = [];
	for (const hint of state.skillHints) {
		// Match skill name as a whole word, case-insensitive.
		const escaped = hint.name.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`\\b${escaped}\\b`, "i");
		if (!re.test(userMessage)) continue;
		for (const bundleName of hint.requires) {
			const b = state.bundles.get(bundleName);
			if (!b || b.loaded) continue;
			loadBundle(state, bundleName, "trigger");
			loaded.push(`${bundleName} (via skill ${hint.name})`);
		}
	}
	return loaded;
}

function autoLoadByTriggers(state: ExtensionState, userMessage: string): string[] {
	const loaded: string[] = [];
	for (const [name, b] of state.bundles) {
		if (b.loaded) continue;
		const triggers = b.def.triggers ?? [];
		for (const pattern of triggers) {
			try {
				if (new RegExp(pattern).test(userMessage)) {
					loadBundle(state, name, "trigger");
					loaded.push(name);
					break;
				}
			} catch {
				// invalid regex; skip
			}
		}
	}
	return loaded;
}

// ---------------------------------------------------------------------------
// System-prompt block
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatBundlesBlock(state: ExtensionState): string {
	if (!state.master || state.bundles.size === 0) return "";
	const override = resolveModelOverride(state);
	const cap = override?.max_tools;

	const lines: string[] = [
		"",
		"",
		"The following enterprise tool bundles are available. Each bundle's",
		"tools are registered but only become callable once the bundle is loaded.",
		"Use `enterprise_load_bundle(\"<name>\")` to load a bundle when its",
		"description matches the user's intent. Use `enterprise_unload_bundle`",
		"to free slots if you are near the tool budget.",
		"",
	];
	if (cap != null) {
		lines.push(
			`Active-tool budget for this model: ${cap}. Loading more bundles than fit will evict the least-recently-used non-default bundle automatically.`,
			"",
		);
	}
	lines.push("<available_bundles>");
	for (const [name, b] of state.bundles) {
		const status = b.loaded ? "loaded" : "available";
		lines.push("  <bundle>");
		lines.push(`    <name>${escapeXml(name)}</name>`);
		lines.push(`    <status>${status}</status>`);
		lines.push(`    <tool_count>${b.tools.length}</tool_count>`);
		if (b.def.summary) lines.push(`    <summary>${escapeXml(b.def.summary)}</summary>`);
		lines.push(`    <description>${escapeXml(b.def.description.trim())}</description>`);
		if (!b.loaded) {
			lines.push(`    <load>enterprise_load_bundle({"name": "${escapeXml(name)}"})</load>`);
		}
		lines.push("  </bundle>");
	}
	lines.push("</available_bundles>");
	return lines.join("\n");
}

function formatStatusReport(state: ExtensionState, pi: ExtensionAPI): string {
	const allTools = pi.getAllTools().map((t) => t.name);
	const active = pi.getActiveTools();
	const override = resolveModelOverride(state);
	const cap = override?.max_tools;
	const lines: string[] = [];
	lines.push(`Master list: ${state.listPath ?? "(none)"}`);
	lines.push(`Model: ${state.currentModelId ?? "(unknown)"}`);
	lines.push(`Active tools: ${active.length}${cap != null ? ` / cap ${cap}` : " (no cap)"}`);
	lines.push(`Total registered: ${allTools.length}`);
	lines.push("");
	lines.push("Bundles:");
	for (const [name, b] of state.bundles) {
		const tag = b.loaded ? `LOADED via ${b.source}` : "available";
		lines.push(`  - ${name.padEnd(22)} ${tag.padEnd(22)}  ${b.tools.length} tools`);
		if (b.def.summary) lines.push(`      ${b.def.summary}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function integrationBundlesExtension(pi: ExtensionAPI) {
	const state: ExtensionState = {
		listPath: null,
		master: null,
		bundles: new Map(),
		routerTools: new Set([
			"enterprise_load_bundle",
			"enterprise_unload_bundle",
			"enterprise_list_bundles",
		]),
		currentModelId: null,
		skillHints: [],
	};

	const found = findMasterList();
	if (!found) {
		// Extension is harmless without a master list; just register router
		// tools that report "no master list found" so misconfig is visible.
		registerRouterTools(pi, state);
		return;
	}
	state.listPath = found.path;
	state.master = found.data;

	registerRouterTools(pi, state);

	// Build bundle state once we know the universe of tools (after session_start).
	pi.on("session_start", async (_event, ctx) => {
		state.currentModelId = ctx.model?.id ?? null;
		rebuildBundleState(pi, state);
		state.skillHints = discoverSkillHints();
		applyDefaultLoadout(state);
		applyActiveSet(pi, state);
	});

	pi.on("model_select", async (event, _ctx) => {
		state.currentModelId = event.model?.id ?? null;
		// Re-apply default loadout for the new model so claude-* gets its full
		// pre-loaded set when the user switches into it mid-session.
		applyDefaultLoadout(state);
		applyActiveSet(pi, state);
	});

	// Per-prompt: auto-load by trigger, enforce cap, inject system-prompt block.
	pi.on("before_agent_start", async (event, ctx) => {
		state.currentModelId = ctx.model?.id ?? state.currentModelId;
		// Lazily rebuild if pi-enterprise registered tools after session_start.
		if (state.bundles.size === 0 || anyBundleStale(pi, state)) {
			rebuildBundleState(pi, state);
			applyDefaultLoadout(state);
		}
		const triggered = autoLoadByTriggers(state, event.prompt ?? "");
		const skillTriggered = autoLoadBySkillMention(state, event.prompt ?? "");
		applyActiveSet(pi, state);

		const block = formatBundlesBlock(state);
		const notes: string[] = [];
		if (triggered.length > 0) {
			notes.push(`auto-loaded by trigger: ${triggered.join(", ")}`);
		}
		if (skillTriggered.length > 0) {
			notes.push(`auto-loaded via skill mention: ${skillTriggered.join(", ")}`);
		}
		const note = notes.length > 0 ? `\n\n[integration-bundles] ${notes.join("; ")}` : "";
		return {
			systemPrompt: `${event.systemPrompt}${block}${note}`,
		};
	});

	// Slash command: /bundles
	pi.registerCommand("bundles", {
		description:
			"Manage integration tool bundles: status (default), load <name>, unload <name>, reset.",
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			const action = (tokens[0] || "status").toLowerCase();

			if (action === "status" || !action) {
				ctx.ui.notify(formatStatusReport(state, pi), "info");
				return;
			}

			if (action === "reset") {
				for (const b of state.bundles.values()) b.loaded = false;
				applyDefaultLoadout(state);
				applyActiveSet(pi, state);
				ctx.ui.notify(`Reset to defaults.\n\n${formatStatusReport(state, pi)}`, "info");
				return;
			}

			const target = tokens[1];
			if (!target) {
				ctx.ui.notify("Usage: /bundles [status | load <name> | unload <name> | reset]", "warning");
				return;
			}

			if (action === "load") {
				const r = loadBundle(state, target, "user");
				if (!r.ok) {
					ctx.ui.notify(r.reason || "load failed", "warning");
					return;
				}
				applyActiveSet(pi, state);
				ctx.ui.notify(`Loaded ${target}.\n\n${formatStatusReport(state, pi)}`, "info");
				return;
			}

			if (action === "unload") {
				const r = unloadBundle(state, target);
				if (!r.ok) {
					ctx.ui.notify(r.reason || "unload failed", "warning");
					return;
				}
				applyActiveSet(pi, state);
				ctx.ui.notify(`Unloaded ${target}.\n\n${formatStatusReport(state, pi)}`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown /bundles action: ${action}\nUsage: /bundles [status | load <name> | unload <name> | reset]`,
				"warning",
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Bundle-state rebuild
// ---------------------------------------------------------------------------

/**
 * Resolve the default loadout for the current model:
 *  - merge `defaults.always_load` with the longest-prefix match in
 *    `defaults.model_always_load` (e.g. "claude-*")
 *  - load each resulting bundle (idempotent).
 */
function applyDefaultLoadout(state: ExtensionState): void {
	const names = new Set<string>(state.master?.defaults?.always_load ?? []);
	const modelMap = state.master?.defaults?.model_always_load;
	if (modelMap && state.currentModelId) {
		let best: { glob: string; list: string[] } | null = null;
		for (const [glob, list] of Object.entries(modelMap)) {
			if (!modelMatches(state.currentModelId, glob)) continue;
			const score = glob.replace(/\*/g, "").length;
			if (!best || score > best.glob.replace(/\*/g, "").length) {
				best = { glob, list };
			}
		}
		if (best) for (const n of best.list) names.add(n);
	}
	for (const n of names) loadBundle(state, n, "default");
}

function rebuildBundleState(pi: ExtensionAPI, state: ExtensionState): void {
	if (!state.master) return;
	const allTools = pi.getAllTools().map((t) => t.name);
	const previous = state.bundles;
	state.bundles = new Map();
	for (const [name, def] of Object.entries(state.master.bundles)) {
		const tools = matchToolNames(allTools, def.tools ?? []);
		const prev = previous.get(name);
		state.bundles.set(name, {
			def,
			tools,
			loaded: prev?.loaded ?? false,
			loadedAt: prev?.loadedAt ?? 0,
			source: prev?.source ?? "default",
		});
	}
}

function anyBundleStale(pi: ExtensionAPI, state: ExtensionState): boolean {
	if (!state.master) return false;
	const allTools = new Set(pi.getAllTools().map((t) => t.name));
	for (const [, b] of state.bundles) {
		// If the resolved tool list now picks up new matches that weren't
		// captured at last rebuild, treat as stale.
		const expected = matchToolNames([...allTools], b.def.tools ?? []);
		if (expected.length !== b.tools.length) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Router tools
// ---------------------------------------------------------------------------

function registerRouterTools(pi: ExtensionAPI, state: ExtensionState): void {
	pi.registerTool({
		name: "enterprise_load_bundle",
		label: "Load Bundle",
		description:
			"Load an enterprise tool bundle by name, making its tools callable on the next user message. Use when a bundle's <description> in <available_bundles> matches the user's intent. The active-tool budget is enforced automatically — loading may evict the least-recently-used bundle.",
		parameters: Type.Object({
			name: Type.String({ description: "Bundle name from <available_bundles>" }),
		}),
		async execute(_id, params) {
			if (!state.master) {
				return {
					content: [{ type: "text", text: "No master_integration_list.yaml found." }],
					isError: true,
				};
			}
			const r = loadBundle(state, params.name, "model");
			if (!r.ok) {
				return {
					content: [{ type: "text", text: r.reason || "load failed" }],
					isError: true,
				};
			}
			applyActiveSet(pi, state);
			const b = state.bundles.get(params.name)!;
			return {
				content: [
					{
						type: "text",
						text:
							`Loaded bundle "${params.name}" (${b.tools.length} tools).\n\n` +
							`Tools now active: ${pi.getActiveTools().length}.\n` +
							`These tools become callable on the NEXT user/assistant turn (pi snapshots tools per prompt).`,
					},
				],
				details: { bundle: params.name, tools: b.tools },
			};
		},
	});

	pi.registerTool({
		name: "enterprise_unload_bundle",
		label: "Unload Bundle",
		description:
			"Unload an enterprise tool bundle to free slots in the active-tool budget. Hidden tools stay registered (they can be reloaded later).",
		parameters: Type.Object({
			name: Type.String({ description: "Bundle name to unload" }),
		}),
		async execute(_id, params) {
			const r = unloadBundle(state, params.name);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: r.reason || "unload failed" }],
					isError: true,
				};
			}
			applyActiveSet(pi, state);
			return {
				content: [
					{
						type: "text",
						text: `Unloaded bundle "${params.name}". Active tools: ${pi.getActiveTools().length}.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "enterprise_list_bundles",
		label: "List Bundles",
		description:
			"List all integration bundles with their loaded/available status, summary, and tool counts. Use this to discover what enterprise capabilities exist before loading one.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: formatStatusReport(state, pi) }],
			};
		},
	});
}
