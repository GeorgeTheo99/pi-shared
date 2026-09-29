const stub = new URL("./dev_doctor_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Stub only imports from pi-shared sources, never the SDK's own internal imports.
  if (!context.parentURL?.includes("/node_modules/") && ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"].includes(specifier)) {
    return { url: stub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
