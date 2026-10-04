import {
	createBashToolDefinition,
	getAgentDir,
	SettingsManager,
	type BashSpawnContext,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { PROCESS_GROUP_LEDGER_ENV, processGroupRegistrationPrefix } from "../_shared/process-group-ledger.ts";

/**
 * Child-only Bash override for managed subagents, loaded first via --extension.
 *
 * Pi runs each Bash command as its own process-group leader, so background jobs
 * survive the child. Every command first appends its group to the parent's
 * run-scoped ledger; a command that cannot register does not run. Shell
 * settings mirror Pi's built-in Bash tool.
 */
export default function childBashExtension(pi: ExtensionAPI) {
	const ledgerPath = process.env[PROCESS_GROUP_LEDGER_ENV];
	if (!ledgerPath) return;
	// Commands get the literal path in their prefix; nothing downstream inherits the variable.
	delete process.env[PROCESS_GROUP_LEDGER_ENV];

	const prefix = processGroupRegistrationPrefix(ledgerPath);
	const spawnHook = (context: BashSpawnContext): BashSpawnContext => ({
		...context,
		command: `${prefix}\n${context.command}`,
	});
	const shellSettings = new Map<string, { shellPath?: string; commandPrefix?: string }>();
	const resolveShellSettings = (cwd: string, projectTrusted: boolean) => {
		const key = `${projectTrusted}\0${cwd}`;
		let settings = shellSettings.get(key);
		if (!settings) {
			const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
			settings = { shellPath: manager.getShellPath(), commandPrefix: manager.getShellCommandPrefix() };
			shellSettings.set(key, settings);
		}
		return settings;
	};

	const template = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...template,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createBashToolDefinition(ctx.cwd, {
				...resolveShellSettings(ctx.cwd, ctx.isProjectTrusted()),
				spawnHook,
			});
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
