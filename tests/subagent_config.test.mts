import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_SUBAGENT_MAX_CONCURRENCY,
	DEFAULT_SUBAGENT_MAX_FANOUT,
	canSpawnSubagent,
	loadSubagentConfig,
} from "../extensions/_shared/subagent-config.ts";

test("subagent limits default to 16 fan-out and 8 host-wide concurrency", () => {
	const config = loadSubagentConfig({});
	assert.equal(config.maxFanout, DEFAULT_SUBAGENT_MAX_FANOUT);
	assert.equal(config.maxFanout, 16);
	assert.equal(config.maxConcurrency, DEFAULT_SUBAGENT_MAX_CONCURRENCY);
	assert.equal(config.maxConcurrency, 8);
	assert.equal(config.maxBackgroundJobs, 8);
	assert.equal(config.maxDepth, 1);
	assert.equal(config.depth, 0);
	assert.equal(config.backgroundAgingMs, 60_000);
	assert.deepEqual(config.resourceLimits, {});
	assert.equal(config.errors.length, 0);
	assert.equal(canSpawnSubagent(config), true);
});

test("validated environment settings can raise or lower hard-bounded limits", () => {
	const config = loadSubagentConfig({
		PI_SUBAGENT_MAX_FANOUT: "32",
		PI_SUBAGENT_MAX_CONCURRENCY: "12",
		PI_SUBAGENT_MAX_BACKGROUND_JOBS: "20",
		PI_SUBAGENT_MAX_DEPTH: "2",
		PI_SUBAGENT_DEPTH: "1",
		PI_SUBAGENT_BACKGROUND_AGING_MS: "250",
		PI_SUBAGENT_RESOURCE_LIMITS: JSON.stringify({ "openai-codex": 4, anthropic: 2 }),
		PI_SUBAGENT_STATE_DIR: "~/tmp/subagent-state",
	});
	assert.equal(config.maxFanout, 32);
	assert.equal(config.maxConcurrency, 12);
	assert.equal(config.maxBackgroundJobs, 20);
	assert.equal(config.depth, 1);
	assert.equal(config.maxDepth, 2);
	assert.equal(config.backgroundAgingMs, 250);
	assert.deepEqual(config.resourceLimits, { "openai-codex": 4, anthropic: 2 });
	assert.equal(config.stateDir, path.join(os.homedir(), "tmp", "subagent-state"));
	assert.deepEqual(config.errors, []);
});

test("invalid settings fail closed while retaining safe defaults", () => {
	const config = loadSubagentConfig({
		PI_SUBAGENT_MAX_FANOUT: "0",
		PI_SUBAGENT_MAX_CONCURRENCY: "not-a-number",
		PI_SUBAGENT_HEARTBEAT_MS: "10000",
		PI_SUBAGENT_LEASE_MS: "10000",
		PI_SUBAGENT_BACKGROUND_AGING_MS: "20",
		PI_SUBAGENT_RESOURCE_LIMITS: "{\"openai-codex\":0}",
	});
	assert.equal(config.maxFanout, 16);
	assert.equal(config.maxConcurrency, 8);
	assert.ok(config.errors.some((error) => error.includes("PI_SUBAGENT_MAX_FANOUT")));
	assert.ok(config.errors.some((error) => error.includes("PI_SUBAGENT_MAX_CONCURRENCY")));
	assert.ok(config.errors.some((error) => error.includes("three times")));
	assert.ok(config.errors.some((error) => error.includes("PI_SUBAGENT_BACKGROUND_AGING_MS")));
	assert.ok(config.errors.some((error) => error.includes("PI_SUBAGENT_RESOURCE_LIMITS")));
	assert.equal(canSpawnSubagent(config), false);
});

test("depth one disables nested delegation by default", () => {
	const config = loadSubagentConfig({ PI_SUBAGENT_DEPTH: "1" });
	assert.deepEqual(config.errors, []);
	assert.equal(canSpawnSubagent(config), false);
});
