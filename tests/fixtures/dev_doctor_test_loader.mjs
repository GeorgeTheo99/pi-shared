const stub = new URL("./dev_doctor_test_stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (["@mariozechner/pi-ai", "@mariozechner/pi-coding-agent"].includes(specifier)) {
    return { url: stub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
