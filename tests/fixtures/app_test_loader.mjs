const stub = new URL("./app_test_stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"].includes(specifier)) return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
