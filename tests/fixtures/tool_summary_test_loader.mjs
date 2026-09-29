const aiStub = new URL("./tool_summary_ai_stub.mjs", import.meta.url).href;
const piStub = new URL("./tool_summary_pi_stub.mjs", import.meta.url).href;
const typeboxStub = new URL("./tool_summary_typebox_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Stub only imports from pi-shared sources, never the SDK's own internal imports.
  if (context.parentURL?.includes("/node_modules/")) return nextResolve(specifier, context);
  if (specifier === "@earendil-works/pi-ai/compat") {
    return { url: aiStub, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: piStub, shortCircuit: true };
  }
  if (specifier === "typebox") {
    return { url: typeboxStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
