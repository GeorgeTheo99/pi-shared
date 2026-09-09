const stub = new URL("./subagent_worktree_stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "typebox" || specifier === "@mariozechner/pi-coding-agent" || specifier === "@mariozechner/pi-ai" || specifier === "@mariozechner/pi-tui" ||
		(specifier === "./agents.js" && context.parentURL?.endsWith("/spawn-subagent/index.ts")) ||
		(specifier === "../_shared/pi-agent-runner.ts" && context.parentURL?.endsWith("/spawn-subagent/index.ts"))) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
