// Exercise the actual installed SDK parser, including malformed YAML handling.
import { resolve as resolveSdk } from "./integration_bundles_test_loader.mjs";

export function resolve(specifier, context, nextResolve) {
  return resolveSdk(
    specifier === "@mariozechner/pi-coding-agent" ? "@earendil-works/pi-coding-agent" : specifier,
    context,
    nextResolve,
  );
}
