const stub = new URL("./session_coordinator_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (
		specifier === "@mariozechner/pi-ai" ||
		specifier === "@mariozechner/pi-coding-agent" ||
		specifier === "@mariozechner/pi-tui"
	) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
