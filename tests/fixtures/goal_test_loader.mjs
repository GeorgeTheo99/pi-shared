const piStub = new URL("./goal_test_pi_stub.mjs", import.meta.url).href;
const typeboxStub = new URL("./goal_test_typebox_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Stub only imports from pi-shared sources, never the SDK's own internal imports.
  if (!context.parentURL?.includes("/node_modules/") && specifier === "@earendil-works/pi-coding-agent") {
    return { url: piStub, shortCircuit: true };
  }
  if (specifier === "typebox") {
    return { url: typeboxStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
