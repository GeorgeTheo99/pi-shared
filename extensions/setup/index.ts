import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { resolveSetupExecutable, runBackend, type SetupAction, type SetupReport } from "./backend.ts";

type Run = (action: SetupAction, extra: string[]) => Promise<SetupReport>;
type WizardContext = Pick<ExtensionCommandContext, "ui">;

// Backend text is evidence, not terminal control sequences or agent instructions.
function clean(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 4096);
}
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
	let inFlight: Promise<SetupReport> | undefined;
	pi.on("session_shutdown", async () => {
		active?.abort();
		// Pi can exit immediately after this hook. Keep it alive until the
		// runner has completed its bounded TERM/KILL process-group cleanup.
		await inFlight?.catch(() => {});
	});
	pi.registerCommand("setup", {
		description: "Guided optional setup: /setup peekaboo (Mac computer use)",
		getArgumentCompletions: (prefix) => "peekaboo".startsWith(prefix) ? [{ value: "peekaboo", label: "peekaboo — Mac computer use" }] : null,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/setup requires interactive Pi. For an offline preview: pi-shared peekaboo plan --json", "error"); return; }
			if (active || !ctx.isIdle()) { ctx.ui.notify("Wait for current work/setup to finish before opening setup.", "warning"); return; }
			const target = args.trim();
			if (target && target !== "peekaboo") { ctx.ui.notify("Usage: /setup [peekaboo]. Only Peekaboo setup is currently implemented.", "warning"); return; }
			const controller = new AbortController();
			active = controller;
			try {
				if (!target) {
					const selected = await ctx.ui.select("Optional capability setup", ["Peekaboo — Mac computer use", "Cancel"], { signal: controller.signal });
					if (selected !== "Peekaboo — Mac computer use" || controller.signal.aborted) return;
				}
				const command = resolveSetupExecutable();
				if (!pi.getAllTools().some(tool => tool.name === "mcp")) ctx.ui.notify("Pi's MCP adapter is not currently loaded. This wizard configures Peekaboo but does not install the adapter; enable the existing MCP adapter before using its tools.", "warning");
				const run: Run = async (action, extra) => {
					if (controller.signal.aborted) throw new Error("Setup canceled.");
					const outcome = await ctx.ui.custom<{ report?: SetupReport; error?: string }>((tui, theme, _keys, done) => {
						const loader = new BorderedLoader(tui, theme, `Peekaboo setup: ${action}…`);
						// Do not close the dialog on Esc until bounded process cleanup finishes.
						loader.onAbort = () => {};
						const signal = AbortSignal.any([controller.signal, loader.signal]);
						const operation = runBackend(command, action, extra, signal);
						inFlight = operation;
						void operation.then(
							report => done({ report }), error => done({ error: error instanceof Error ? error.message : String(error) }),
						).finally(() => { if (inFlight === operation) inFlight = undefined; });
						return loader;
					});
					if (!outcome?.report || controller.signal.aborted) throw new Error(outcome?.error ?? "Setup canceled.");
					return outcome.report;
				};
				await runWizard(ctx, run, controller.signal);
			} catch (error) {
				ctx.ui.notify(clean(error instanceof Error ? error.message : String(error)), "error");
			} finally {
				if (active === controller) active = undefined;
			}
		},
	});
}
