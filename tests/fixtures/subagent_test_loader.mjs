const piStub = new URL("./subagent_test_pi_stub.mjs", import.meta.url).href;
const aiStub = new URL("./subagent_test_ai_stub.mjs", import.meta.url).href;
const tuiStub = new URL("./subagent_test_tui_stub.mjs", import.meta.url).href;

// Stub only imports from pi-shared sources, never the SDK's own internal imports.
const sdkInternal = (context) => context.parentURL?.includes("/node_modules/");

export async function resolve(specifier, context, nextResolve) {
	if (sdkInternal(context)) return nextResolve(specifier, context);
	if (specifier === "@earendil-works/pi-coding-agent") {
		return { url: piStub, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-ai") {
		return { url: aiStub, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-tui") {
		return { url: tuiStub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
