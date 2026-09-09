#!/usr/bin/env node
// Offline only: verifies pinned inputs, applies the patch in an owned temp tree,
// then extracts and executes the actual loader functions (not the whole module).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const provenance = JSON.parse(readFileSync(join(here, "provenance.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const source of provenance.sources) {
	const bytes = readFileSync(join(here, source.local));
	assert.equal(sha256(bytes), source.sha256, `source hash: ${source.local}`);
	assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlob);
}
assert.equal(sha256(readFileSync(join(here, "context-dedup.patch"))), provenance.patch.sha256, "patch hash");
const root = mkdtempSync(join(tmpdir(), "pi-context-dedup-validation-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
Object.assign(env, {
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
	TMPDIR: root, TMP: root, TEMP: root,
});
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")}`);
}
function between(source, start, end) {
	assert.equal(source.split(start).length, 2, `unique start anchor: ${start}`);
	assert.equal(source.split(end).length, 2, `unique end anchor: ${end}`);
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	assert.ok(to > from);
	return source.slice(from, to);
}
const erase = (source) => stripTypeScriptTypes(source, { mode: "strip" });

try {
	for (const source of provenance.sources) {
		const target = join(root, source.path);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(here, source.local), target);
	}
	run("git", ["-c", "init.templateDir=", "init", "-q"]);
	run("git", ["apply", "--check", join(here, "context-dedup.patch")]);
	run("git", ["apply", "--whitespace=error-all", join(here, "context-dedup.patch")]);
	for (const output of provenance.patch.outputs) {
		assert.equal(sha256(readFileSync(join(root, output.path))), output.sha256, `patched hash: ${output.path}`);
	}
	const loader = readFileSync(join(root, "packages/coding-agent/src/core/resource-loader.ts"), "utf8");
	const paths = readFileSync(join(root, "packages/coding-agent/src/utils/paths.ts"), "utf8");
	const footer = readFileSync(join(root, "packages/coding-agent/src/core/footer-data-provider.ts"), "utf8");
	const text = readFileSync(join(root, "packages/coding-agent/src/utils/text.ts"), "utf8");
	const contextFunctions = between(loader, "function loadContextFileFromDir(", "export interface DefaultResourceLoaderOptions");
	const canonical = between(paths, "export function canonicalizePath(", "export function getFileRevision(");
	const normalization = between(paths, "export function normalizeWindowsShellPath(", "export function getCwdRelativePath(");
	const constants = between(paths, "const UNICODE_SPACES =", "export interface PathInputOptions");
	const gitPaths = between(footer, "export type GitPaths =", "/** Ask git for the current branch.");
	// Only imports/binding plumbing are supplied. Function bodies and helpers are
	// verbatim pinned/patched source; the TypeScript eraser does not typecheck.
	const moduleSource = `
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, resolve as nodeResolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
${text.replaceAll("export ", "")}
export const text = { stripBom };
export function createLoader(overrides = {}) {
 const { existsSync, readFileSync, realpathSync, statSync } = { ...fs, ...overrides };
 const console = overrides.console ?? globalThis.console;
 const chalk = { yellow: (value) => value };
 const stripBom = (content) => text.stripBom(content);
 ${constants}
 ${canonical.replaceAll("export ", "")}
 ${normalization.replaceAll("export ", "")}
 ${gitPaths.replaceAll("export ", "")}
 ${contextFunctions.replaceAll("export ", "")}
 return loadProjectContextFiles;
}
export const loadProjectContextFiles = createLoader();
`;
	writeFileSync(join(root, "loader.mjs"), erase(moduleSource));
	const baseline = readFileSync(join(here, "baseline/resource-loader.ts.txt"), "utf8");
	const baselineFunctions = between(baseline, "function loadContextFileFromDir(", "export interface DefaultResourceLoaderOptions");
	writeFileSync(join(root, "baseline-loader.mjs"), erase(moduleSource.replace(
		contextFunctions.replaceAll("export ", ""), baselineFunctions.replaceAll("export ", ""))));
	// Run the six new upstream regressions using node:test/assert, without installing
	// Vitest. Adapt only imports and the two one-shot spies; no assertions are changed.
	writeFileSync(join(root, "vitest-adapter.mjs"), `
import { mock } from "node:test";
export { afterEach, beforeEach, describe, it } from "node:test";
export const vi = {
 restoreAllMocks: () => mock.restoreAll(),
 spyOn: (object, key) => ({ mockImplementationOnce: (fn) => mock.method(object, key, fn, { times: 1 }) }),
};
`);
	const upstreamTests = readFileSync(join(root, "packages/coding-agent/test/resource-loader-context-dedup.test.ts"), "utf8");
	writeFileSync(join(root, "upstream-tests.mjs"), erase(upstreamTests
		.replace('from "vitest"', 'from "./vitest-adapter.mjs"')
		.replace('from "../src/core/resource-loader.ts"', 'from "./loader.mjs"')
		.replace('import * as text from "../src/utils/text.ts";', 'import { text } from "./loader.mjs";')));
	copyFileSync(join(here, "offline-tests.mjs"), join(root, "offline-tests.mjs"));
	run(process.execPath, ["--test", "--test-concurrency=1", "upstream-tests.mjs", "offline-tests.mjs"]);
	run("git", ["apply", "--reverse", "--check", join(here, "context-dedup.patch")]);
	console.log(`PASS: pinned ${provenance.commit}; hashes, patch apply/reverse-check, extracted-loader regressions`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
