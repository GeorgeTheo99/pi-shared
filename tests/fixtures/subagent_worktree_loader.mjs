const stub = new URL("./subagent_worktree_stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
	// Stub only imports from pi-shared sources, never the SDK's own internal imports.
	if (context.parentURL?.includes("/node_modules/")) return nextResolve(specifier, context);
	if (specifier === "typebox" || specifier === "@earendil-works/pi-coding-agent" || specifier === "@earendil-works/pi-ai" || specifier === "@earendil-works/pi-tui" ||
		(specifier === "../_shared/agents.js" && context.parentURL?.endsWith("/spawn-subagent/index.ts")) ||
		(specifier === "../_shared/pi-agent-runner.ts" && context.parentURL?.endsWith("/spawn-subagent/index.ts"))) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
