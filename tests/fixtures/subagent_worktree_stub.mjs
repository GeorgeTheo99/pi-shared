export const Type = {
	String: (options = {}) => ({ type: "string", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Integer: (options = {}) => ({ type: "integer", ...options }),
	Unknown: () => ({}), Optional: (value) => value,
	Record: (_key, value, options = {}) => ({ type: "object", additionalProperties: value, ...options }),
	Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
	Array: (items, options = {}) => ({ type: "array", items, ...options }),
};
export const StringEnum = (values, options = {}) => ({ type: "string", enum: [...values], ...options });
export class Text { constructor(text) { this.text = text; } }
export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const untrustedSubagentProfileDirs = () => [];
export const createInteractivePiAgent = () => { throw new Error("Unexpected interactive runner"); };
export const runPiAgent = (options) => globalThis.worktreeRunner(options);
export const withFileMutationQueue = (_path, operation) => operation();
export const discoverAgents = () => ({
	agents: [{ name: "worker", source: "shared", description: "fixture", filePath: "/fixture/worker.md", systemPrompt: "fixture" }],
	sharedAgentsDir: "/fixture", userAgentsDir: "/fixture", projectAgentsDir: null,
});
export const formatAgentList = () => "worker";
