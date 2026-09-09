/**
 * integration-bundles
 *
 * Active-schema bundle selector driven by a machine-local master list.
 *
 * - Hides non-default bundles' tools at startup via `pi.setActiveTools`.
 * - Exposes router tools so the model can load/unload/list bundles on demand;
 *   newly added tools are available to the next model response in the same run.
 * - Auto-loads bundles whose regex `triggers` match the user message.
 * - Injects `<available_bundles>` into the system prompt with NL descriptions
 *   so the model can self-discover when to load each bundle.
 * - Enforces a per-model active-tool cap (e.g. <=120 for gpt-* / o-series to
 *   stay under OpenAI's 128-tool API hard limit), evicting LRU-loaded
 *   bundles first (load-recency, not tool-use recency).
 *
 * Note: this extension does NOT register the underlying enterprise tools —
 * `pi-enterprise` does that. It only controls visibility (active set) of
 * tools that are already registered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "yaml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchCatalog } from "./catalog.ts";
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
	// An explicit path is authoritative; a missing file must not select another policy.
	const candidates = [process.env.PI_INTEGRATION_LIST ||
		path.join(os.homedir(), ".pi", "agent", "master_integration_list.yaml")];

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
	loadedAt: number; // monotonic successful-load sequence, not actual tool use
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
	eligible: Set<string>;
	manual: Set<string>;
	known: Set<string>;
	observed: Set<string> | null;
	loadSequence: number;
	budgetError: string | null;
}

// ---------------------------------------------------------------------------
// Active-set helpers
// ---------------------------------------------------------------------------

/** Compute the union of tools we want active right now. */
function computeDesiredActiveSet(state: ExtensionState, allTools: string[]): string[] {
	const desired = new Set<string>();

	// Only initially allowed or subsequently observed-active tools are eligible.
	const allBundleTools = new Set<string>();
	for (const b of state.bundles.values()) {
		for (const t of b.tools) allBundleTools.add(t);
	}
	for (const name of allTools) {
		if (state.eligible.has(name) && (!allBundleTools.has(name) || state.manual.has(name))) desired.add(name);
	}

	// 2. Eligible router tools are pinned.
	for (const name of state.routerTools) {
		if (allTools.includes(name) && state.eligible.has(name)) desired.add(name);
	}

	// 3. Tools from currently-loaded bundles.
	for (const b of state.bundles.values()) {
		if (!b.loaded) continue;
		for (const t of b.tools) if (state.eligible.has(t)) desired.add(t);
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
 * Apply model cap by evicting least-recently-loaded bundles until it fits.
 * Returns the evicted bundle names.
 */
function enforceModelCap(state: ExtensionState, allTools: string[]): string[] {
	const override = resolveModelOverride(state);
	const cap = override?.max_tools;
	if (cap == null) return [];

	const desired = computeDesiredActiveSet(state, allTools);
	if (desired.length <= cap) return [];

	// Need to evict. Pick oldest-loaded bundles that are not
	// in defaults.always_load.
	const alwaysLoad = new Set(state.master?.defaults?.always_load ?? []);
	const evictable = [...state.bundles.entries()]
		.filter(([name, b]) => b.loaded && !alwaysLoad.has(name))
		.sort((a, b) => a[1].loadedAt - b[1].loadedAt);

	const evicted: string[] = [];
	for (const [name, b] of evictable) {
		if (computeDesiredActiveSet(state, allTools).length <= cap) break;
		b.loaded = false;
		evicted.push(name);
	}
	return evicted;
}

/** No SDK exclusion provenance exists. Never infer permission from registration. */
function refreshPolicy(pi: ExtensionAPI, state: ExtensionState): void {
	const all = new Set(pi.getAllTools().map(t => t.name));
	const active = new Set(pi.getActiveTools().filter(n => all.has(n)));
	const changed = state.observed && (active.size !== state.observed.size ||
		[...active].some(n => !state.observed!.has(n)));
	if (!state.observed) {
		state.eligible = new Set(active);
	} else {
		// Registry-only additions are not evidence of an external full selection.
		const external = changed && ([...state.observed].some(n => all.has(n) && !active.has(n)) ||
			[...active].some(n => state.known.has(n) && !state.observed!.has(n)));
		for (const n of state.eligible) {
			if (!all.has(n) || (external && !active.has(n))) state.eligible.delete(n);
		}
		for (const n of active) {
			state.eligible.add(n);
			if (state.known.has(n) && !state.observed.has(n)) state.manual.add(n);
		}
		for (const n of state.manual) if (!active.has(n)) state.manual.delete(n);
	}
	state.known = all;
	state.observed = active;
	rebuildBundleState(pi, state);
	// Pinned bundles may gain their first eligible registration after startup.
	for (const name of state.master?.defaults?.always_load ?? []) loadBundle(state, name, "default");
}

function applyActiveSet(pi: ExtensionAPI, state: ExtensionState): void {
	if (!state.master) return;
	const allTools = pi.getAllTools().map((t) => t.name);
	enforceModelCap(state, allTools);
	const desired = computeDesiredActiveSet(state, allTools);
	const cap = resolveModelOverride(state)?.max_tools;
	state.budgetError = cap != null && desired.length > cap
		? `Tool budget impossible: pinned/base tools (${desired.length}) exceed cap ${cap}. Reduce the manual/base/default selection or change model; no base tools were silently removed.`
		: null;
	pi.setActiveTools(desired);
	state.observed = new Set(pi.getActiveTools());
}

function unavailableReason(state: ExtensionState, b: BundleState): string | undefined {
	if (!b.tools.length || b.def.tools.some(p => !matchToolNames([...state.known], [p]).length)) {
		return "Unavailable: one or more tool patterns have no registered matches.";
	}
	if (b.tools.some(n => !state.eligible.has(n))) return "Unavailable: bundle contains excluded tools; explicitly enable them outside this router first.";
	return undefined;
}

/** Preflight a requested load without evicting it or changing other bundles on failure. */
function requestLoad(pi: ExtensionAPI, state: ExtensionState, name: string, source: BundleState["source"]): { ok: boolean; reason?: string } {
	refreshPolicy(pi, state);
	const b = state.bundles.get(name);
	if (!b) return { ok: false, reason: `Unknown bundle: ${name}` };
	const reason = unavailableReason(state, b);
	if (reason) return { ok: false, reason };
	const snapshot = new Map([...state.bundles].map(([n, value]) => [n, { ...value }]));
	b.loaded = true;
	const cap = resolveModelOverride(state)?.max_tools;
	const all = [...state.known];
	const pinned = new Set(state.master?.defaults?.always_load ?? []);
	for (const [, other] of [...state.bundles].filter(([n, value]) => n !== name && value.loaded && !pinned.has(n))
		.sort((a, b) => a[1].loadedAt - b[1].loadedAt)) {
		if (cap == null || computeDesiredActiveSet(state, all).length <= cap) break;
		other.loaded = false;
	}
	if (cap != null && computeDesiredActiveSet(state, all).length > cap) {
		state.bundles = snapshot;
		return { ok: false, reason: `Bundle "${name}" cannot fit the tool budget (cap ${cap}); load not applied.` };
	}
	b.loadedAt = ++state.loadSequence;
	b.source = source;
	applyActiveSet(pi, state);
	const actual = new Set(pi.getActiveTools());
	if (!b.loaded || b.tools.some(n => !actual.has(n))) {
		return { ok: false, reason: `Bundle "${name}" is unavailable in the resulting active set.` };
	}
	return { ok: true };
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
	const reason = unavailableReason(state, b);
	if (reason) return { ok: false, reason };
	if (b.loaded) return { ok: true };
	b.loaded = true;
	b.loadedAt = ++state.loadSequence;
	b.source = source;
	return { ok: true };
}

function unloadBundle(state: ExtensionState, name: string): { ok: boolean; reason?: string } {
	const b = state.bundles.get(name);
	if (!b) return { ok: false, reason: `Unknown bundle: ${name}` };
	if (state.master?.defaults?.always_load?.includes(name)) return { ok: false, reason: `Bundle "${name}" is pinned by always_load.` };
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
		...(process.env.PI_SKILL_HINT_ROOTS ? process.env.PI_SKILL_HINT_ROOTS.split(":") : []),
		path.join(os.homedir(), "local_code", "pi-shared", "skills"),
		path.join(os.homedir(), "local_code", "pi-local", "skills"),
		path.join(os.homedir(), "local_code", "pi-databricks", "skills"),
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

function autoLoadBySkillMention(pi: ExtensionAPI, state: ExtensionState, userMessage: string): string[] {
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
			if (requestLoad(pi, state, bundleName, "trigger").ok) loaded.push(bundleName);
		}
	}
	return loaded;
}

function autoLoadByTriggers(pi: ExtensionAPI, state: ExtensionState, userMessage: string): string[] {
	const loaded: string[] = [];
	for (const [name, b] of state.bundles) {
		if (b.loaded) continue;
		const triggers = b.def.triggers ?? [];
		for (const pattern of triggers) {
			try {
				if (new RegExp(pattern).test(userMessage)) {
					if (requestLoad(pi, state, name, "trigger").ok) loaded.push(name);
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
		"The following integration bundles are configured. Only eligible, registered",
		"tools can be loaded; exclusions and missing registrations are never overridden.",
		"Use enterprise_list_bundles({query: \"…\"}) for bounded tool/capability discovery.",
		"Use `enterprise_load_bundle(\"<name>\")` to load a bundle when its",
		"description matches the user's intent. Use `enterprise_unload_bundle`",
		"to free slots if you are near the tool budget.",
		"",
	];
	if (cap != null) {
		lines.push(
			`Active-tool budget for this model: ${cap}. Loads may evict least-recently-loaded non-pinned bundles; impossible requests fail.`,
			"",
		);
	}
	if (state.budgetError) lines.push(state.budgetError);
	lines.push("<available_bundles>");
	for (const [name, b] of [...state.bundles].slice(0, 40)) {
		const status = unavailableReason(state, b) ? "unavailable" : b.loaded ? "loaded" : "available";
		lines.push("  <bundle>");
		lines.push(`    <name>${escapeXml(name)}</name>`);
		lines.push(`    <status>${status}</status>`);
		lines.push(`    <tool_count>${b.tools.length}</tool_count>`);
		if (b.def.summary) lines.push(`    <summary>${escapeXml(b.def.summary.slice(0, 300))}</summary>`);
		lines.push(`    <description>${escapeXml(b.def.description.trim().slice(0, 300))}</description>`);
		if (!b.loaded) {
			lines.push(`    <load>enterprise_load_bundle({"name": "${escapeXml(name)}"})</load>`);
		}
		lines.push("  </bundle>");
	}
	lines.push("</available_bundles>");
	if (state.bundles.size > 40) lines.push("Bundle preview limited to 40 entries; search/page enterprise_list_bundles for the remainder.");
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
	if (!state.master) lines.push("No master_integration_list.yaml found; activation management is disabled (discovery only).");
	if (cap != null && active.length > cap) lines.push(`Tool budget exceeded: ${active.length} active / cap ${cap}. Reduce selections/defaults or change model.`);
	lines.push("");
	lines.push("Bundles:");
	for (const [name, b] of state.bundles) {
		const tag = unavailableReason(state, b) ? "unavailable/excluded" : b.loaded ? `LOADED via ${b.source}` : "available";
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
		eligible: new Set(),
		manual: new Set(),
		known: new Set(),
		observed: null,
		loadSequence: 0,
		budgetError: null,
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
	for (const name of state.master.defaults?.router_tools ?? []) state.routerTools.add(name);

	registerRouterTools(pi, state);

	// Build bundle state once we know the universe of tools (after session_start).
	pi.on("session_start", async (_event, ctx) => {
		state.currentModelId = ctx.model?.id ?? null;
		refreshPolicy(pi, state);
		state.skillHints = discoverSkillHints();
		applyDefaultLoadout(state);
		applyActiveSet(pi, state);
	});

	pi.on("model_select", async (event, _ctx) => {
		state.currentModelId = event.model?.id ?? null;
		refreshPolicy(pi, state);
		// Re-apply default loadout for the new model so claude-* gets its full
		// pre-loaded set when the user switches into it mid-session.
		applyDefaultLoadout(state);
		applyActiveSet(pi, state);
	});

	// Per-prompt: auto-load by trigger, enforce cap, inject system-prompt block.
	pi.on("before_agent_start", async (event, ctx) => {
		const modelId = ctx.model?.id ?? state.currentModelId;
		const modelChanged = modelId !== state.currentModelId;
		state.currentModelId = modelId;
		refreshPolicy(pi, state);
		if (modelChanged) applyDefaultLoadout(state);
		applyActiveSet(pi, state);
		const triggered = autoLoadByTriggers(pi, state, event.prompt ?? "");
		const skillTriggered = autoLoadBySkillMention(pi, state, event.prompt ?? "");
		const stillLoaded = (names: string[]) => names.filter(n => state.bundles.get(n)?.loaded);

		const block = formatBundlesBlock(state);
		const notes: string[] = [];
		if (stillLoaded(triggered).length > 0) {
			notes.push(`auto-loaded by trigger: ${stillLoaded(triggered).join(", ")}`);
		}
		if (stillLoaded(skillTriggered).length > 0) {
			notes.push(`auto-loaded via skill mention: ${stillLoaded(skillTriggered).join(", ")}`);
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
			refreshPolicy(pi, state);

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
				const r = requestLoad(pi, state, target, "user");
				if (!r.ok) {
					ctx.ui.notify(r.reason || "load failed", "warning");
					return;
				}
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
	for (const [name, b] of state.bundles) {
		if (b.source === "default" && !names.has(name)) b.loaded = false;
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

// ---------------------------------------------------------------------------
// Router tools
// ---------------------------------------------------------------------------

function registerRouterTools(pi: ExtensionAPI, state: ExtensionState): void {
	pi.registerTool({
		name: "enterprise_load_bundle",
		label: "Load Bundle",
		description:
			"Load an eligible registered integration bundle for the next model response. Excluded/missing tools and impossible budgets fail. May evict least-recently-loaded non-pinned bundles (not actual-use recency).",
		parameters: Type.Object({
			name: Type.String({ description: "Bundle name from <available_bundles>" }),
		}),
		async execute(_id, params) {
			if (!state.master) {
				throw new Error("No master_integration_list.yaml found.");
			}
			const r = requestLoad(pi, state, params.name, "model");
			if (!r.ok) {
				throw new Error(r.reason || "load failed");
			}
			const b = state.bundles.get(params.name)!;
			return {
				content: [
					{
						type: "text",
						text:
							`Loaded bundle "${params.name}" (${b.tools.length} tools).\n\n` +
							`Tools now active: ${pi.getActiveTools().length}.\n` +
							"These tools are active now and available on the next response unless another operation changes the selection.",
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
			if (!state.master) throw new Error("No master_integration_list.yaml found; activation management is disabled.");
			refreshPolicy(pi, state);
			const r = unloadBundle(state, params.name);
			if (!r.ok) {
				throw new Error(r.reason || "unload failed");
			}
			applyActiveSet(pi, state);
			return {
				content: [
					{
						type: "text",
						text: `Unloaded bundle "${params.name}". Overlapping, router or manually selected tools may remain active. Active tools: ${pi.getActiveTools().length}.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "enterprise_list_bundles",
		label: "List Bundles",
		description:
			"Bounded read-only discovery of registered tool names/descriptions, configured bundles and pi-shared capability groups. Search uses case-insensitive literal terms (all must match). Groups are discovery labels, not loadable bundles unless configured. Registration/eligibility is not authorization or proof of service health.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ maxLength: 200 })),
			group: Type.Optional(Type.String({ maxLength: 200, description: "Exact bundle/capability group name" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
			offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
		}),
		async execute(_id, params) {
			refreshPolicy(pi, state);
			const active = new Set(pi.getActiveTools());
			const cap = resolveModelOverride(state)?.max_tools ?? null;
			const catalog = searchCatalog({ ...params, tools: pi.getAllTools(), active, eligible: state.eligible,
				bundles: [...state.bundles].map(([name, b]) => ({ name, description: `${b.def.summary ?? ""} ${b.def.description}`, tools: b.tools,
					loaded: b.loaded && !unavailableReason(state, b) && b.tools.every(n => active.has(n)), available: !unavailableReason(state, b) })) });
			const details = { ...catalog, activationManaged: !!state.master, activeCount: active.size, cap,
				budgetError: cap != null && active.size > cap ? `Tool budget exceeded: ${active.size} active / cap ${cap}.${state.budgetError ? " Pinned/base tools exceed the budget; reduce selections/defaults or change model." : ""}` : null,
				message: state.master ? "Only eligible registered bundles can be loaded." : "No master_integration_list.yaml found; activation management is disabled (discovery only)." };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
}
