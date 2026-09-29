export async function resolve(specifier, context, nextResolve) {
  // Stub only imports from pi-shared sources, never the SDK's own internal imports.
  if (context.parentURL?.includes("/node_modules/")) return nextResolve(specifier, context);
  if (specifier === "@earendil-works/pi-ai") return { url: new URL("./code_intel_pi_stub.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
