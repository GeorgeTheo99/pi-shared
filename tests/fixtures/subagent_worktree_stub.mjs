export { Type, StringEnum, validateToolArguments } from "./subagent_test_ai_stub.mjs";
export const defineTool = (tool) => tool;
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
