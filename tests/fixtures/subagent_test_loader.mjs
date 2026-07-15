const piStub = new URL("./subagent_test_pi_stub.mjs", import.meta.url).href;
const aiStub = new URL("./subagent_test_ai_stub.mjs", import.meta.url).href;
const tuiStub = new URL("./subagent_test_tui_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@mariozechner/pi-coding-agent") {
		return { url: piStub, shortCircuit: true };
	}
	if (specifier === "@mariozechner/pi-ai") {
		return { url: aiStub, shortCircuit: true };
	}
	if (specifier === "@mariozechner/pi-tui") {
		return { url: tuiStub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
