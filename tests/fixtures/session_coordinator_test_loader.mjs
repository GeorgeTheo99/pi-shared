const stub = new URL("./session_coordinator_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (
		specifier === "typebox" ||
		specifier === "@earendil-works/pi-coding-agent" ||
		specifier === "@earendil-works/pi-tui"
	) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
