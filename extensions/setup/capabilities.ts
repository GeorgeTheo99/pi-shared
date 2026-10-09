import { isAbsolute } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runSetupProcess } from "./backend.ts";

export const CAPABILITIES = [
	{ id: "search", label: "Web search & research" },
	{ id: "browser", label: "Browser automation & private-app testing" },
	{ id: "mcp", label: "MCP integrations" },
	{ id: "development", label: "Project development tools" },
	{ id: "documents", label: "PowerPoint & document tools" },
	{ id: "apple", label: "Apple development prerequisites" },
	{ id: "knowledge", label: "Private knowledge base" },
	{ id: "models", label: "Models & connections" },
	{ id: "diagnostics", label: "Check my setup" },
] as const;
export type CapabilityId = typeof CAPABILITIES[number]["id"];
export type CapabilityAction = "plan" | "apply" | "check";
export type CapabilityOptions = Record<string, string | string[]>;
export interface CapabilityReport {
	schemaVersion: 1;
	component: CapabilityId;
	action: CapabilityAction;
	ok: boolean;
	summary: string;
	status: "not-installed" | "needs-configuration" | "configured-untested" | "verified" | "unknown";
	evidence: { label: string; value: string }[];
	actions: string[];
	warnings: string[];
	errors: string[];
	nextSteps: string[];
	handoffs: { label: string; command: string; kind: "terminal" | "pi" }[];
	planId?: string;
}
export interface CapabilityContext {
	project: string;
	agentDir: string;
	sharedRoot: string;
	nodeExecutable: string;
}
export type CapabilityRun = (action: CapabilityAction, options: CapabilityOptions, extra?: string[]) => Promise<CapabilityReport>;
type WizardContext = Pick<ExtensionCommandContext, "ui" | "isProjectTrusted">;

export function clean(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 4096);
}
export function isCapability(value: string): value is CapabilityId {
	return CAPABILITIES.some(item => item.id === value);
}
export function parseCapabilityReport(text: string, component: CapabilityId, action: CapabilityAction): CapabilityReport {
	if (Buffer.byteLength(text) > 65536) throw new Error("Setup result exceeded its size limit.");
	let value: any;
	try { value = JSON.parse(text); } catch { throw new Error("Capability setup received no versioned report. A newer owning pi-shared CLI may be required, or the CLI failed to start. Inspect the owning installation; no automatic update was attempted."); }
	const string = (v: unknown): v is string => typeof v === "string" && v.length <= 4096;
	const list = (v: unknown, check: (row: any) => boolean) => Array.isArray(v) && v.length <= 40 && v.every(check);
	if (value?.schemaVersion !== 1 || value.component !== component || value.action !== action || typeof value.ok !== "boolean" ||
		!string(value.summary) || !["not-installed", "needs-configuration", "configured-untested", "verified", "unknown"].includes(value.status) ||
		!list(value.evidence, row => row && string(row.label) && string(row.value)) ||
		!["actions", "warnings", "errors", "nextSteps"].every(key => list(value[key], string)) ||
		!list(value.handoffs, row => row && string(row.label) && string(row.command) && row.command.length > 0 &&
			![...row.command].some(char => /[\x00-\x1f\x7f-\x9f]/.test(char)) &&
			(row.kind === "terminal" || row.kind === "pi" && ["/login", "/model", "/mcp", "/mcp setup", "/verification-trust"].includes(row.command))) ||
		(value.planId !== undefined && (typeof value.planId !== "string" || !/^[a-f0-9]{64}$/.test(value.planId) ||
			!["development", "knowledge", "mcp"].includes(component)))) {
		throw new Error("Unsupported or malformed capability setup response. Update the owning pi-shared CLI; capability readiness is unknown.");
	}
	return value;
}
export async function runCapabilityBackend(command: string, component: CapabilityId, action: CapabilityAction,
	options: CapabilityOptions, context: CapabilityContext, signal: AbortSignal, extra: string[] = []): Promise<CapabilityReport> {
	for (const path of Object.values(context)) {
		if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Setup context must use absolute paths.");
	}
	const args = ["capability", component, action, "--json", "--project", context.project, "--agent-dir", context.agentDir,
		"--shared-root", context.sharedRoot, "--node-executable", context.nodeExecutable, "--options", JSON.stringify(options), ...extra];
	const result = await runSetupProcess(command, args, signal, action === "apply");
	const report = parseCapabilityReport(result.stdout, component, action);
	if ((result.exitCode === 0) !== report.ok) throw new Error("Setup exit status contradicted its report; result is unverified.");
	return report;
}

export function formatCapabilityReport(report: CapabilityReport): string {
	return [clean(report.summary), `State: ${report.status}`,
		...report.evidence.map(row => `${clean(row.label)}: ${clean(row.value)}`),
		...report.actions.map(text => `Proposed: ${clean(text)}`),
		...report.warnings.map(text => `Warning: ${clean(text)}`),
		...report.errors.map(text => `Error: ${clean(text)}`),
		...report.nextSteps.map(text => `Next: ${clean(text)}`),
		"Configured is not ready. Checks establish only the evidence listed above; no inference, browser actions, or desktop interaction is tested.",
	].join("\n");
}

async function choose(ctx: WizardContext, title: string, choices: [string, string][], signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) return;
	const answer = await ctx.ui.select(title, [...choices.map(([, label]) => label), "Cancel"], { signal });
	if (signal.aborted) return;
	return choices.find(([, label]) => label === answer)?.[0];
}
async function input(ctx: WizardContext, title: string, placeholder: string, signal: AbortSignal, optional = false): Promise<string | undefined> {
	if (signal.aborted) return;
	const answer = await ctx.ui.input(title, placeholder, { signal });
	if (signal.aborted || answer === undefined) return;
	const text = answer.trim();
	if ((!text && !optional) || text.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error("Enter a nonempty, single-line value (at most 4096 characters), or cancel setup.");
	return text;
}
function absolute(path: string): string {
	if (!isAbsolute(path)) throw new Error("Use an absolute path, not a ~/ shortcut or a shell command.");
	return path;
}
function stringArray(text: string, title: string, allowEmpty: boolean): string[] {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error(`${title} must be a JSON array of strings.`); }
	if (!Array.isArray(value) || value.length > 64 || !allowEmpty && value.length === 0 ||
		!value.every(item => typeof item === "string" && item.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(item))) {
		throw new Error(`${title} must be ${allowEmpty ? "a" : "a nonempty"} JSON array of at most 64 single-line strings.`);
	}
	return value;
}

// Collect only explicit choices. Cancel at any stage ends the entire wizard.
export async function collectCapabilityOptions(ctx: WizardContext, id: CapabilityId, signal: AbortSignal): Promise<CapabilityOptions | undefined> {
	if (signal.aborted) return;
	if (id === "search") {
		const mode = await choose(ctx, "Web search & research", [["guided", "Use the existing guided service setup"], ["local", "Local Brave-backed search"], ["existing", "Connect an existing compatible search endpoint"]], signal);
		if (!mode) return;
		if (mode === "guided") return { mode };
		let url: string | undefined;
		if (mode === "existing") {
			url = await input(ctx, "Search MCP URL (no embedded credentials or query tokens)", "https://search.example/mcp", signal);
			if (url === undefined) return;
			let parsed: URL;
			try { parsed = new URL(url); } catch { throw new Error("Enter an absolute HTTP(S) URL."); }
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Use HTTP(S) without embedded credentials, query parameters, or fragments; supply a private key file separately.");
		}
		const keyFile = await input(ctx, mode === "local" ? "Absolute path to your private Brave API-key file (not the key)" : "Absolute private bearer-key file path (blank for no authentication)", "/absolute/path/to/key-file", signal, mode === "existing");
		if (keyFile === undefined) return;
		if (keyFile) absolute(keyFile);
		// Optional Decodo page-fetch fallback; blank keeps fetch recovery on Jina only.
		const decodoKeyFile = mode === "local"
			? await input(ctx, "Optional absolute path to a private Decodo token file (blank to skip)", "/absolute/path/to/decodo-key-file", signal, true)
			: "";
		if (decodoKeyFile === undefined) return;
		return { mode, ...(url ? { url } : {}), ...(keyFile ? { keyFile } : {}),
			...(decodoKeyFile ? { decodoKeyFile: absolute(decodoKeyFile) } : {}) };
	}
	if (id === "browser") {
		const mode = await choose(ctx, "Separate browser runtimes", [["public", "Public browser-worker service"], ["app", "Local/private app-testing dependencies"]], signal);
		return mode ? { mode } : undefined;
	}
	if (id === "mcp") {
		const mode = await choose(ctx, "Official MCP — current profile", [
			["inventory", "Inspect official MCP configuration"],
			["migrate", "Preview migration from the existing MCP adapter"],
		], signal);
		return mode ? (mode === "migrate" ? { mode } : {}) : undefined;
	}
	if (id === "development") {
		if (!ctx.isProjectTrusted?.()) throw new Error("Project setup requires Pi project trust. Review /trust and restart Pi first; setup never grants trust.");
		const mode = await choose(ctx, "Project development tools — current workspace only", [["code-intel", "TypeScript/JavaScript code intelligence"], ["verification", "Declare a verification command (do not execute it)"]], signal);
		if (!mode) return;
		if (mode === "code-intel") return { mode };
		const command = await input(ctx, "Executable for your check (no shell expression)", "npm", signal);
		if (command === undefined) return;
		const args = await input(ctx, "Explicit argv as a JSON array", '["run", "typecheck"]', signal);
		if (args === undefined) return;
		const inputs = await input(ctx, "Existing project-relative source paths as a JSON array (no globs)", '["src", "package.json"]', signal);
		if (inputs === undefined) return;
		return { mode, command, args: stringArray(args, "Arguments", true), inputs: stringArray(inputs, "Source paths", false) };
	}
	if (id === "knowledge") {
		const mode = await choose(ctx, "Private knowledge base", [["initialize", "Prepare a private metadata layout (no books downloaded)"], ["ingest", "Prepare an indexing command for my local books"]], signal);
		if (!mode) return;
		const location = await choose(ctx, "Knowledge-base location", [["default", "Use the configured/default machine-local location"], ["custom", "Choose a custom absolute location"]], signal);
		if (!location) return;
		if (location === "default") return { mode };
		const root = await input(ctx, "Absolute path outside the managed installation", "/absolute/path/to/private-knowledge", signal);
		return root === undefined ? undefined : { mode, root: absolute(root) };
	}
	if (id === "models") {
		const mode = await choose(ctx, "Models & connections", [["native", "Native providers and subscriptions (/login, /model)"], ["guided", "Guided setup, including an existing remote gateway"], ["gateway", "Local model gateway"], ["omlx", "Local oMLX setup guidance (no weight downloads)"]], signal);
		return mode ? { mode } : undefined;
	}
	return {};
}

export async function runCapabilityWizard(ctx: WizardContext, id: CapabilityId, run: CapabilityRun,
	signal: AbortSignal = new AbortController().signal): Promise<void> {
	const options = await collectCapabilityOptions(ctx, id, signal);
	if (options === undefined || signal.aborted) return;
	const report = await run("plan", options);
	if (signal.aborted) return;
	ctx.ui.notify(formatCapabilityReport(report), report.ok ? "info" : "warning");
	const apply = id === "mcp" ? "Review and migrate this profile to official MCP" : "Review and create the missing configuration";
	const check = "Run explicit prerequisite checks (no installs)";
	const handoffs = report.handoffs.map((handoff, index) => ({
		...handoff, choice: `${index + 1}. ${handoff.kind === "pi" ? "Prepare Pi command" : "Show terminal command"}: ${clean(handoff.label)}`,
	}));
	const choices = [...(report.ok && report.planId ? [apply] : []), check, ...handoffs.map(handoff => handoff.choice), "Done / cancel"];
	const selected = await ctx.ui.select(`${CAPABILITIES.find(item => item.id === id)!.label} — ${report.status}`, choices, { signal });
	if (signal.aborted || !selected || !choices.includes(selected) || selected === "Done / cancel") return;
	if (selected === apply) {
		if (id === "development" && !ctx.isProjectTrusted?.()) throw new Error("Project trust is required; nothing was written.");
		const warning = id === "mcp"
			? "Creates a missing native MCP config and narrowly updates this profile's adapter/built-in selection, with private backups. Existing native config is not overwritten. Review all compatibility warnings; avoid concurrent settings edits and restart this profile after applying. No servers or credential commands are executed."
			: "Existing files will not be overwritten. No commands are executed, and no project or verification trust is granted.";
		const approved = await ctx.ui.confirm(id === "mcp" ? "Migrate exactly this MCP configuration?" : "Create exactly this configuration?", `${formatCapabilityReport(report)}\n\n${warning}`, { signal });
		if (signal.aborted || !approved) return;
		if (id === "development" && !ctx.isProjectTrusted?.()) throw new Error("Project trust changed; nothing was written.");
		const applied = await run("apply", options, ["--yes", "--expected-plan", report.planId!]);
		if (!signal.aborted) ctx.ui.notify(formatCapabilityReport(applied), applied.ok ? "info" : "warning");
		return;
	}
	if (selected === check) {
		const checked = await run("check", id === "mcp" ? {} : options);
		if (!signal.aborted) ctx.ui.notify(formatCapabilityReport(checked), checked.ok ? "info" : "warning");
		return;
	}
	const handoff = handoffs.find(item => item.choice === selected)!;
	if (handoff.kind === "terminal") {
		ctx.ui.notify(`Run this command in a separate terminal:\n\n${handoff.command}\n\nNothing was executed by /setup. Review the command and its scope before running it. Interactive installers must not be run through Pi's captured ! shell. Return to /setup ${id} afterward to check.`, "info");
		return;
	}
	const draft = ctx.ui.getEditorText();
	const approved = await ctx.ui.confirm("Prepare this Pi command?", `${handoff.command}\n\n${draft ? "This replaces your current editor draft. " : ""}It will not run until you press Enter.`, { signal });
	if (signal.aborted || !approved) return;
	ctx.ui.setEditorText(handoff.command);
}
