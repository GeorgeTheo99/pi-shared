import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as sdkResolve } from "./integration_bundles_test_loader.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier, context.parentURL);
    const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
  }
  if (specifier === "@earendil-works/pi-agent-core") {
    const ai = await sdkResolve("@earendil-works/pi-ai", context, nextResolve);
    return nextResolve(specifier, { ...context, parentURL: ai.url });
  }
  return sdkResolve(specifier, context, nextResolve);
}
