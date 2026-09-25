// Real installed dependencies only: no schema, provider, or agent-loop stubs.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function sdkRoot() {
	const explicit = process.env.PI_TEST_SDK_DIR || process.env.PI_INSTALL_DIR;
	const candidates = explicit ? [explicit] : [
		"/opt/homebrew/opt/pi-shared/libexec/runtime/node_modules/@earendil-works/pi-coding-agent",
	];
	if (!explicit) {
		try { candidates.push(execFileSync("which", ["pi"], { encoding: "utf8", timeout: 2000 }).trim()); } catch {}
	}
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		let dir = fs.realpathSync(candidate);
		if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
		for (;;) {
			const manifest = path.join(dir, "package.json");
			if (fs.existsSync(manifest)) {
				const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
				if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(pkg.name)) return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error("Real Pi SDK not found. Set PI_TEST_SDK_DIR or PI_INSTALL_DIR to the installed pi-coding-agent package directory; this contract suite never skips SDK checks.");
}

export const root = sdkRoot();
export const requireSdk = createRequire(path.join(root, "package.json"));
export const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
export async function dependency(name) {
	// Pi's packages expose import-only exports, so require.resolve(name) cannot
	// resolve them. Locate the installed manifest and honor its import mapping.
	const parts = name.split("/");
	const packageName = parts.splice(0, name.startsWith("@") ? 2 : 1).join("/");
	const subpath = parts.length ? `./${parts.join("/")}` : ".";
	for (const searchPath of requireSdk.resolve.paths(packageName) ?? []) {
		const packageDir = path.join(searchPath, packageName);
		const manifest = path.join(packageDir, "package.json");
		if (!fs.existsSync(manifest)) continue;
		const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
		let target = pkg.exports?.[subpath];
		if (!target && subpath !== ".") {
			for (const [pattern, mapping] of Object.entries(pkg.exports ?? {})) {
				if (!pattern.endsWith("*") || !subpath.startsWith(pattern.slice(0, -1))) continue;
				const value = typeof mapping === "string" ? mapping : mapping.import;
				target = value?.replace("*", subpath.slice(pattern.length - 1));
			}
		}
		const entry = typeof target === "string" ? target : typeof target?.import === "string" ? target.import : target?.import?.default;
		if (entry) return import(pathToFileURL(path.join(packageDir, entry)).href);
		return import(pathToFileURL(requireSdk.resolve(name)).href);
	}
	throw new Error(`Required installed SDK dependency unavailable: ${name}`);
}
export const ai = await dependency("@earendil-works/pi-ai");
export const core = await dependency("@earendil-works/pi-agent-core");

// Use the same installed SDK when reading a source export with legacy imports.
export async function sourceModule(filename) {
	const { createJiti } = await dependency("jiti");
	const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
		"@mariozechner/pi-coding-agent": path.join(root, "dist/index.js"),
	} });
	return jiti.import(filename);
}

export async function loopCall(tool, args, beforeToolCall) {
	const model = { id: "offline-contract", name: "offline-contract", provider: "fixture", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1024 };
	const streamFn = () => {
		const stream = new ai.AssistantMessageEventStream();
		const message = { role: "assistant", content: [{ type: "toolCall", id: "contract-call", name: tool.name, arguments: args }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
		stream.push({ type: "done", reason: "toolUse", message });
		return stream;
	};
	const messages = await core.runAgentLoop(
		[{ role: "user", content: "Offline contract fixture", timestamp: Date.now() }],
		{ systemPrompt: "Offline test", messages: [], tools: [tool] },
		{ model, convertToLlm: (messages) => messages, shouldStopAfterTurn: () => true, finishTurn: () => ({ action: "end" }), beforeToolCall },
		() => {}, undefined, streamFn,
	);
	const result = messages.find((message) => message.role === "toolResult");
	if (!result) throw new Error("Real agent loop did not finalize a tool result");
	return result;
}
