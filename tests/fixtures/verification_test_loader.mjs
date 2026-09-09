const stub = new URL("./verification_test_stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "typebox") return { url: stub, shortCircuit: true };
	return nextResolve(specifier, context);
}
