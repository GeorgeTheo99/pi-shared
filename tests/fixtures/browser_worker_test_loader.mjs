const stub = new URL("./browser_worker_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@earendil-works/pi-ai" ||
    specifier === "@earendil-works/pi-coding-agent"
  ) {
    return { url: stub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
