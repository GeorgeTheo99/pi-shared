// Resolve real SDK dependencies only for this suite; never stub schemas or YAML.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
// npm --prefix propagates npm_config_prefix to scripts; it is not the global SDK prefix.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_prefix'));
const root = process.env.PI_TEST_SDK_DIR || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env }).trim(), '@earendil-works/pi-coding-agent');
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox' || specifier === '@earendil-works/pi-coding-agent' || specifier === '@earendil-works/pi-ai' || specifier === '@earendil-works/pi-tui') {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(root, 'package.json')).href });
  }
  return nextResolve(specifier, context);
}
