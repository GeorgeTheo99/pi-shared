export async function withFileMutationQueue(_path, operation) {
	return operation();
}

export function defineTool(definition) {
	return definition;
}

export const bashToolDefinitions = [];
export const settingsManagerCreates = [];

export function createBashToolDefinition(cwd, options = {}) {
	const record = { cwd, options, executions: [] };
	bashToolDefinitions.push(record);
	return {
		name: "bash",
		label: "bash",
		description: "stub bash",
		parameters: { type: "object" },
		async execute(...args) {
			record.executions.push(args);
			return { content: [{ type: "text", text: "stub" }] };
		},
	};
}

export function getAgentDir() {
	return "/tmp/pi-stub-agent";
}

export class SettingsManager {
	static create(cwd, agentDir, options) {
		settingsManagerCreates.push({ cwd, agentDir, options });
		return { getShellPath: () => "/bin/stub-shell", getShellCommandPrefix: () => "stub-prefix" };
	}
}
