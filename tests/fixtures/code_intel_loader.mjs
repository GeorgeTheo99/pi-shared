export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-ai") return { url: new URL("./code_intel_pi_stub.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
