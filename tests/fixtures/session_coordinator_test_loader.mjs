const stub = new URL("./session_coordinator_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	// Stub only imports from pi-shared sources, never the SDK's own internal imports.
	if (context.parentURL?.includes("/node_modules/")) return nextResolve(specifier, context);
	if (
		specifier === "typebox" ||
		specifier === "@earendil-works/pi-coding-agent" ||
		specifier === "@earendil-works/pi-tui"
	) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
