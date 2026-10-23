// Resolve real SDK dependencies only for this suite; never stub schemas or YAML.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
// The type-check toolchain's lockfile pins the SDK and every @earendil-works
// package it depends on; a global install resolves those by caret range and drifts.
const locked = fileURLToPath(new URL('../../tools/typecheck/node_modules/@earendil-works/pi-coding-agent', import.meta.url));
function globalSdk() {
  // npm --prefix propagates npm_config_prefix to scripts; it is not the global SDK prefix.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_prefix'));
  return join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env }).trim(), '@earendil-works/pi-coding-agent');
}
const root = process.env.PI_TEST_SDK_DIR || (existsSync(join(locked, 'package.json')) ? locked : globalSdk());
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox' || specifier === '@earendil-works/pi-coding-agent' || specifier === '@earendil-works/pi-ai' || specifier === '@earendil-works/pi-tui') {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(root, 'package.json')).href });
  }
  return nextResolve(specifier, context);
}
