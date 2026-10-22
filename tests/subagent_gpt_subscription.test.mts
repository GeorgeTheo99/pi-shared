import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The runner resolves ~/.pi/agent when it loads, so isolate HOME first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gpt-subscription-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, "empty-profile");
const { resolveSubagentModel, schedulerResourceKey, subagentEnv } = await import("../extensions/_shared/pi-agent-runner.ts");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function profile(name: string, auth: Record<string, unknown>): string {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(auth));
	return fs.realpathSync(dir);
}

const signedIn = profile("sign-in-with-chatgpt", { openai: { type: "oauth" }, "openai-codex": { type: "oauth" } });
const legacy = profile("legacy-codex", { "openai-codex": { type: "oauth" } });
const apiKey = profile("api-key", { openai: { type: "api_key", key: "test-only" } });

test("GPT subagents use Sign in with ChatGPT on the openai provider", () => {
	assert.deepEqual(resolveSubagentModel("gpt-6-sol", signedIn), { agentDir: signedIn, model: "openai/gpt-6-sol" });
	assert.deepEqual(resolveSubagentModel("openai-codex/gpt-6-sol:high", signedIn), {
		agentDir: signedIn,
		model: "openai/gpt-6-sol:high",
	});
	assert.deepEqual(resolveSubagentModel("openai/gpt-6-astra", signedIn), { agentDir: signedIn, model: "openai/gpt-6-astra" });
});

test("a profile with only the legacy login keeps openai-codex", () => {
	assert.deepEqual(resolveSubagentModel("openai/gpt-6-sol", legacy), { agentDir: legacy, model: "openai-codex/gpt-6-sol" });
});

test("an OpenAI API key is never used for GPT subagents", () => {
	// No subscription anywhere: route to openai-codex, which fails without its login.
	assert.deepEqual(resolveSubagentModel("openai/gpt-6-sol", apiKey), { agentDir: apiKey, model: "openai-codex/gpt-6-sol" });
});

test("other models and profiles are untouched", () => {
	assert.deepEqual(resolveSubagentModel("model-gateway/glm-5.3-fw", apiKey), {
		agentDir: apiKey,
		model: "model-gateway/glm-5.3-fw",
	});
	assert.deepEqual(resolveSubagentModel(undefined, undefined), { agentDir: undefined, model: undefined });
});

test("both subscription providers share one ChatGPT-plan resource limit", () => {
	assert.equal(schedulerResourceKey("openai/gpt-6-sol", {}), "openai");
	assert.equal(schedulerResourceKey("openai/gpt-6-sol", { "openai-codex": 4 }), "openai-codex");
	assert.equal(schedulerResourceKey("openai-codex/gpt-6-sol", { openai: 2 }), "openai");
	assert.equal(schedulerResourceKey("anthropic/claude-sonnet-4-6", { openai: 2 }), "anthropic");
	assert.equal(schedulerResourceKey(undefined, {}), "default");
});

test("subscription children never receive an OpenAI API key", () => {
	const base = { OPENAI_API_KEY: "test-only", OPENAI_BASE_URL: "https://invalid.example", KEEP: "1" };
	for (const model of ["openai/gpt-6-sol", "openai-codex/gpt-6-sol:high"]) {
		assert.deepEqual(subagentEnv({ ...base }, model), { KEEP: "1" });
	}
	assert.deepEqual(subagentEnv({ ...base }, "model-gateway/glm-5.3-fw"), base);
});

// Last: it signs in ~/.pi/agent, which the earlier tests rely on having no login.
test("a profile without a login falls back to the signed-in ~/.pi/agent", () => {
	const fallback = profile(path.join(".pi", "agent"), { openai: { type: "oauth" } });
	assert.deepEqual(resolveSubagentModel("gpt-6-sol", apiKey), { agentDir: fallback, model: "openai/gpt-6-sol" });
});
