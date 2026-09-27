import { BorderedLoader, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveSetupExecutable, runBackend, type SetupAction, type SetupReport } from "./backend.ts";
import { CAPABILITIES, clean, isCapability, runCapabilityBackend, runCapabilityWizard } from "./capabilities.ts";

type Run = (action: SetupAction, extra: string[]) => Promise<SetupReport>;
type WizardContext = Pick<ExtensionCommandContext, "ui">;

export function formatReport(report: SetupReport): string {
	const e = report.evidence;
	return [
		clean(report.summary),
		`Executable: ${clean(e.binaryPath ?? "not selected")} (${e.binaryPresent ? "present" : "absent"}; runnable: ${e.runnable})`,
		`MCP configuration: ${e.configuration}; connection: ${e.mcp}${e.toolCount === null ? "" : `; tools: ${e.toolCount}`}`,
		`Permissions: screen ${e.permissions.screenRecording}, accessibility ${e.permissions.accessibility}, input ${e.permissions.eventSynthesizing}`,
		"Desktop interaction: not tested. A connection or permission report is not proof of successful computer use.",
		...report.actions.map(s => `Action: ${clean(s)}`),
		...report.warnings.map(s => `Warning: ${clean(s)}`),
		...report.errors.map(s => `Error: ${clean(s)}`),
		...report.nextSteps.map(s => `Next: ${clean(s)}`),
	].join("\n");
}

export async function runWizard(ctx: WizardContext, run: Run, signal: AbortSignal = new AbortController().signal): Promise<void> {
	let options: string[] = [];
	let plan = await run("plan", options);
	while (!signal.aborted) {
		ctx.ui.notify(formatReport(plan), plan.ok ? "info" : "warning");
		const choices: string[] = [];
		if (plan.evidence.binaryPresent) choices.push("Check CLI and permissions (no desktop actions)");
		if (plan.ok && plan.planId && plan.evidence.binaryPresent && plan.evidence.configuration === "missing") choices.push("Configure Peekaboo MCP");
		choices.push("Choose an existing Peekaboo executable");
		if (!plan.evidence.binaryPresent && !["conflict", "invalid"].includes(plan.evidence.configuration)) choices.push("Preview compatibility CLI install (4.5.0; known limitations)");
		choices.push("Done / cancel");
		const choice = await ctx.ui.select("Peekaboo setup — full MCP catalog", choices, { signal });
		if (signal.aborted || !choice || !choices.includes(choice) || choice === "Done / cancel") return;
		if (choice === "Choose an existing Peekaboo executable") {
			const path = await ctx.ui.input("Absolute path to a trusted Peekaboo executable", plan.evidence.binaryPath ?? "/absolute/path/to/peekaboo", { signal });
			if (signal.aborted || path === undefined || !path.trim()) return;
			if (!isAbsolute(path.trim()) || /[\x00-\x1f\x7f]/.test(path)) {
				ctx.ui.notify("Use an absolute executable path, not a shell command or ~/ shortcut.", "error");
				return;
			}
			options = ["--binary", path.trim()];
			plan = await run("plan", options);
			continue;
		}
		if (choice.startsWith("Check CLI")) {
			const checked = await run("check", options);
			ctx.ui.notify(formatReport(checked), checked.ok ? "info" : "warning");
			return;
		}
		if (choice.startsWith("Preview compatibility")) {
			options = ["--install"];
			plan = await run("plan", options);
		}
		if (!plan.ok || !plan.planId) {
			ctx.ui.notify(formatReport(plan), "warning");
			return;
		}
		const approved = await ctx.ui.confirm("Apply this Peekaboo setup plan?", [
			formatReport(plan),
			"Exposes the full tool catalog, including foreground control. OS permissions remain manual.",
			"Does not grant consent to sensitive/external actions or prove desktop readiness.",
		].join("\n\n"), { signal });
		if (signal.aborted || !approved) return;
		const applied = await run("apply", [...options, "--yes", "--expected-plan", plan.planId]);
		ctx.ui.notify(formatReport(applied), applied.ok ? "info" : "warning");
		if (applied.ok) ctx.ui.notify("Restart Pi or run /reload to load MCP configuration, then /setup peekaboo to check. Verify permissions again through the actual Pi MCP adapter; setup-process grants can differ. No desktop action was tested.", "info");
		return;
	}
}

export default function setupExtension(pi: ExtensionAPI) {
	let active: AbortController | undefined;
	let inFlight: Promise<unknown> | undefined;
	pi.on("session_shutdown", async () => {
		active?.abort();
		// Pi can exit immediately after this hook. Keep it alive until the
		// runner has completed its bounded TERM/KILL process-group cleanup.
		await inFlight?.catch(() => {});
	});
	pi.registerCommand("setup", {
		description: "Guided capability setup: search, browser, MCP, development, documents, Apple, knowledge, models, diagnostics, Peekaboo",
		getArgumentCompletions: (prefix) => {
			const matches = [{ id: "peekaboo", label: "Mac computer use" }, ...CAPABILITIES]
				.filter(item => item.id.startsWith(prefix)).map(item => ({ value: item.id, label: `${item.id} — ${item.label}` }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/setup requires interactive Pi. Use pi-shared setup --plan for a terminal preview, or pi-shared capability --help for capability previews.", "error"); return; }
			if (active || !ctx.isIdle()) { ctx.ui.notify("Wait for current work/setup to finish before opening setup.", "warning"); return; }
			let target = args.trim();
			if (target && target !== "peekaboo" && !isCapability(target)) { ctx.ui.notify(`Usage: /setup [peekaboo|${CAPABILITIES.map(item => item.id).join("|")}]`, "warning"); return; }
			const controller = new AbortController();
			active = controller;
			try {
				if (!target) {
					const entries = [{ id: "peekaboo", label: "Peekaboo — Mac computer use" }, ...CAPABILITIES];
					const selected = await ctx.ui.select("Optional capability setup", [...entries.map(item => item.label), "Cancel"], { signal: controller.signal });
					target = entries.find(item => item.label === selected)?.id ?? "";
					if (!target || controller.signal.aborted) return;
				}
				const command = resolveSetupExecutable();
				async function progress<T>(action: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
					if (controller.signal.aborted) throw new Error("Setup canceled.");
					const outcome = await ctx.ui.custom<{ report?: T; error?: string }>((tui, theme, _keys, done) => {
						const loader = new BorderedLoader(tui, theme, `${target} setup: ${action}…`);
						// Keep the dialog open until bounded process-group cleanup finishes.
						loader.onAbort = () => {};
						const signal = AbortSignal.any([controller.signal, loader.signal]);
						const pending = operation(signal);
						inFlight = pending;
						void pending.then(
							report => done({ report }), error => done({ error: error instanceof Error ? error.message : String(error) }),
						).finally(() => { if (inFlight === pending) inFlight = undefined; });
						return loader;
					});
					if (outcome?.report === undefined || controller.signal.aborted) throw new Error(outcome?.error ?? "Setup canceled.");
					return outcome.report;
				}
				if (target === "peekaboo") {
					if (!pi.getAllTools().some(tool => tool.name === "mcp")) ctx.ui.notify("Pi's MCP adapter is not currently loaded. Use /setup mcp to prepare adapter installation; this flow only configures Peekaboo.", "warning");
					await runWizard(ctx, (action, extra) => progress(action, signal => runBackend(command, action, extra, signal)), controller.signal);
				} else if (isCapability(target)) {
					const id = target;
					if (id === "mcp") ctx.ui.notify(`Current-session MCP adapter tool: ${pi.getAllTools().some(tool => tool.name === "mcp") ? "registered (connections not tested)" : "not registered"}.`, "info");
					await runCapabilityWizard(ctx, id, (action, options, extra) => progress(action, signal => runCapabilityBackend(command, id, action, options, {
						project: realpathSync(ctx.cwd), agentDir: realpathSync(getAgentDir()), sharedRoot: realpathSync(fileURLToPath(new URL("../../", import.meta.url))), nodeExecutable: realpathSync(process.execPath),
					}, signal, extra)), controller.signal);
				}
			} catch (error) {
				ctx.ui.notify(clean(error instanceof Error ? error.message : String(error)), "error");
			} finally {
				if (active === controller) active = undefined;
			}
		},
	});
}
