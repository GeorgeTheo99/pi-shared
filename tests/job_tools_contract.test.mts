import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ai, dependency, loopCall, sdk, sourceModule } from "./fixtures/job_tools_sdk.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const secret = "contract-private-command-prompt-answer";
const commandId = "cmd_00000000-0000-0000-0000-000000000001";
const common = ["model", "thinking", "agentDir", "agentScope", "confirmProjectAgents"];
const single = ["agent", "task", "cwd", ...common];
// Deliberately independent of implementation tables: this is the advertised API.
const contracts: Record<string, { required: string[]; optional: string[]; valid: Record<string, any> }> = {
	wait_for_condition: { required: ["condition", "timeout"], optional: ["poll_interval", "progress", "failure_exit_codes"], valid: { condition: "true", timeout: 2 } },
	wait_for_jobs: { required: ["jobs", "timeout"], optional: ["job_mode", "poll_interval"], valid: { jobs: ["sub_fixture"], timeout: 2 } },
	wait_for_ready: { required: ["jobs", "timeout"], optional: ["poll_interval"], valid: { jobs: [commandId], timeout: 2 } },
	command_start: { required: ["command", "timeout_seconds"], optional: ["args", "cwd", "label", "readiness"], valid: { command: process.execPath, timeout_seconds: 5 } },
	command_status: { required: ["id"], optional: [], valid: { id: commandId } },
	command_list: { required: [], optional: [], valid: {} },
	command_logs: { required: ["id"], optional: ["stream", "cursor", "max_bytes"], valid: { id: commandId } },
	command_cancel: { required: ["id"], optional: [], valid: { id: commandId } },
	subagent_run: { required: ["agent", "task"], optional: [...single.slice(2), "background", "outputSchema"], valid: { agent: "worker", task: "fixture" } },
	subagent_parallel: { required: ["tasks"], optional: [...common, "background", "outputSchema"], valid: { tasks: [{ agent: "worker", task: "fixture" }] } },
	subagent_chain: { required: ["chain"], optional: [...common, "background", "outputSchema"], valid: { chain: [{ agent: "worker", task: "fixture" }] } },
	subagent_interactive: { required: ["agent", "task"], optional: [...single.slice(2), "background", "maxExchanges"], valid: { agent: "worker", task: "fixture" } },
	subagent_worktree: { required: ["task"], optional: ["cwd", ...common, "baseRevision", "outputSchema"], valid: { task: "fixture" } },
	subagent_list: { required: [], optional: [], valid: {} },
	subagent_status: { required: ["jobId"], optional: [], valid: { jobId: "sub_fixture" } },
	subagent_cancel: { required: ["jobId"], optional: [], valid: { jobId: "sub_fixture" } },
	subagent_answer: { required: ["jobId", "questionId", "answer"], optional: ["background"], valid: { jobId: "sub_fixture", questionId: "q_fixture", answer: "fixture" } },
	subagent_steer: { required: ["jobId", "message"], optional: [], valid: { jobId: "sub_fixture", message: "fixture" } },
	subagent_followup: { required: ["jobId", "message"], optional: [], valid: { jobId: "sub_fixture", message: "fixture" } },
};

let dir: string;
let tools: Map<string, any>;
let extensions: any[] = [];
const previousEnv = new Map<string, string | undefined>();
const ctx: any = { isProjectTrusted: () => true, hasUI: false };
const validate = (tool: any, args: unknown) => ai.validateToolArguments(tool, { type: "toolCall", id: "validation", name: tool.name, arguments: args });
const call = (name: string, args: any) => tools.get(name).execute("fixture", args, undefined, undefined, ctx);
const wire = (value: any) => JSON.parse(JSON.stringify(value));
const fallbackTools = new Set(["subagent_run", "subagent_parallel", "subagent_chain", "subagent_worktree"]);

// No personal profiles/configuration, child invocations, credentials, or model requests.
test.before(async () => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-job-contract-")));
	ctx.cwd = dir;
	for (const [name, value] of Object.entries({ PI_COMMAND_STATE_DIR: path.join(dir, "commands"), PI_SUBAGENT_STATE_DIR: path.join(dir, "subagents"), PI_SUBAGENT_DEPTH: "0", PI_SUBAGENT_MAX_DEPTH: "1", PI_OFFLINE: "1" })) {
		previousEnv.set(name, process.env[name]); process.env[name] = value;
	}
	const agentDir = path.join(dir, "profile");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: ["command-jobs", "wait-for", "spawn-subagent"].map(name => path.join(repo, "extensions", name, "index.ts")) }));
	const settingsManager = sdk.SettingsManager.create(dir, agentDir, { projectTrusted: false });
	const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	extensions = loaded.extensions;
	assert.deepEqual(loaded.errors, [], "Actual SDK must load every extension successfully");
	tools = new Map();
	for (const extension of extensions) for (const [name, tool] of extension.tools) {
		assert.ok(!tools.has(name), `duplicate tool ${name}`);
		tools.set(name, tool.definition);
	}
});
test.after(async () => {
	try {
		for (const extension of extensions) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	} finally {
		for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("real SDK registers exactly the operation tools, with closed top-level schemas", () => {
	assert.deepEqual([...tools.keys()].sort(), Object.keys(contracts).sort());
	for (const [name, contract] of Object.entries(contracts)) {
		const tool = tools.get(name);
		assert.equal(tool.parameters.type, "object", name);
		assert.equal(tool.parameters.additionalProperties, false, name);
		assert.deepEqual([...(tool.parameters.required ?? [])].sort(), [...contract.required].sort(), name);
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [...contract.required, ...contract.optional].sort(), name);
		assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" }, name);
		assert.equal(typeof tool.prepareArguments, "function", name);
		assert.equal(tool.executionMode, "sequential", name);
		assert.deepEqual(validate(tool, contract.valid), contract.valid, name);
		assert.doesNotMatch([tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n"), /\b(?:spawn_subagent|command_job|wait_for|jobAction)\b/, name);
	}
});

for (const [name, contract] of Object.entries(contracts)) {
	test(`${name}: SDK, prepareArguments, direct execute, and real loop reject invalid input before execution`, async () => {
		const tool = tools.get(name);
		const invalid: any[] = [null, [], secret, { ...contract.valid, foreign: secret }, { ...contract.valid, foreign: null }];
		for (const field of contract.required) {
			const missing = { ...contract.valid }; delete missing[field]; invalid.push(missing);
		}
		for (const field of [...contract.required, ...contract.optional]) {
			// Non-coercible types: stock SDK intentionally accepts some numeric/boolean strings.
			const schema = tool.parameters.properties[field];
			invalid.push({ ...contract.valid, [field]: schema.type === "object" ? [secret] : { private: secret } });
		}
		let executions = 0;
		const guarded = { ...tool, execute: async () => { executions++; throw new Error("ENGINE EXECUTED"); } };
		const poisonedContext = new Proxy({}, { get() { throw new Error("ENGINE ACCESSED CONTEXT"); } });
		for (const args of invalid) {
			assert.throws(() => validate(tool, args), undefined, `${name}: SDK ${JSON.stringify(args)}`);
			const redacted = (error: Error) => {
				assert.match(error.message, new RegExp(`^Invalid arguments for ${name}\\.`));
				assert.ok(!error.message.includes(secret));
				assert.doesNotMatch(error.message, /ENGINE/);
				return true;
			};
			assert.throws(() => tool.prepareArguments(args), redacted);
			await assert.rejects(tool.execute("invalid", args, undefined, undefined, poisonedContext), redacted);
			const result = await loopCall(guarded, args);
			assert.equal(result.isError, true, name);
			redacted(new Error(result.content.map((part: any) => part.text ?? "").join("\n")));
		}
		assert.equal(executions, 0, "prepareArguments must stop calls before SDK errors echo input or execute runs");
	});
}

test("required nulls and coercible primitive types never reach an operation handler", async () => {
	for (const [name, contract] of Object.entries(contracts)) {
		const tool = tools.get(name);
		const invalid: any[] = contract.required.map(field => ({ ...contract.valid, [field]: null }));
		for (const field of [...contract.required, ...contract.optional]) {
			const type = tool.parameters.properties[field].type;
			const wrong = type === "string" ? [0, false] : type === "number" || type === "integer" ? ["2", true] : type === "boolean" ? ["false", 0] : [];
			for (const value of wrong) invalid.push({ ...contract.valid, [field]: value });
		}
		let executions = 0;
		const guarded = { ...tool, execute: async () => { executions++; throw new Error("ENGINE EXECUTED"); } };
		const poisonedContext = new Proxy({}, { get() { throw new Error("ENGINE ACCESSED CONTEXT"); } });
		for (const args of invalid) {
			assert.throws(() => tool.prepareArguments(args), /Invalid arguments/, `${name}: ${JSON.stringify(args)}`);
			await assert.rejects(tool.execute("invalid", args, undefined, undefined, poisonedContext), /Invalid arguments/);
			const result = await loopCall(guarded, args);
			assert.equal(result.isError, true, name);
			assert.match(result.content[0].text, /Invalid arguments/);
		}
		assert.equal(executions, 0);
	}
	for (const args of [
		{ tasks: [{ agent: 0, task: "fixture" }] },
		{ tasks: [{ agent: "worker", task: null }] },
	]) assert.throws(() => tools.get("subagent_parallel").prepareArguments(args), /Invalid arguments/);
	assert.throws(() => tools.get("command_start").prepareArguments({ command: process.execPath, timeout_seconds: 2, readiness: { kind: "tcp", port: "12345", timeout_seconds: 1 } }), /Invalid arguments/);
});

test("optional nulls, omissions, defaults, and preparation are stock-SDK-compatible and idempotent", async () => {
	for (const [name, contract] of Object.entries(contracts)) {
		const tool = tools.get(name);
		for (const args of [contract.valid, { ...contract.valid, ...Object.fromEntries(contract.optional.map(field => [field, null])) }]) {
			const before = structuredClone(args);
			const expected = validate(tool, args);
			assert.deepEqual(expected, contract.valid, `${name}: optional null must mean omitted, not injected defaults`);
			const prepared = tool.prepareArguments(args);
			assert.deepEqual(prepared, expected, name);
			assert.deepEqual(tool.prepareArguments(prepared), prepared, name);
			assert.deepEqual(args, before, `${name}: must not mutate caller data`);
			const result = await loopCall({ ...tool, execute: async (_id: string, input: any) => ({ content: [{ type: "text", text: "synthetic execution only" }], details: input }) }, args);
			assert.equal(result.isError, false, name);
			assert.deepEqual(result.details, expected, name);
		}
	}
	assert.equal(tools.get("subagent_run").parameters.properties.background.default, false);
	assert.equal(tools.get("subagent_run").parameters.properties.agentScope.default, "shared");
	assert.equal(tools.get("subagent_run").parameters.properties.confirmProjectAgents.default, true);
	const explicitDefaults = { ...contracts.subagent_run.valid, background: false, agentScope: "shared", confirmProjectAgents: false };
	assert.deepEqual(tools.get("subagent_run").prepareArguments(explicitDefaults), explicitDefaults, "explicit false must not disappear into defaults");
	const nested = { command: process.execPath, timeout_seconds: 1, readiness: { kind: "tcp", port: 12345, timeout_seconds: 1, path: null } };
	assert.deepEqual(tools.get("command_start").prepareArguments(nested).readiness, { kind: "tcp", port: 12345, timeout_seconds: 1 });
	for (const name of ["subagent_parallel", "subagent_chain"]) {
		const field = name === "subagent_parallel" ? "tasks" : "chain";
		assert.deepEqual(tools.get(name).prepareArguments({ [field]: [{ agent: "worker", task: "fixture", cwd: null, outputSchema: null }] }), contracts[name].valid);
	}
});

test("empty values retain their meanings; cross-operation fields and nested extras fail closed", () => {
	for (const [name, patch] of [
		["wait_for_condition", { failure_exit_codes: [] }], ["command_start", { args: [] }], ["subagent_answer", { answer: "" }],
		["subagent_run", { outputSchema: {} }], ["subagent_parallel", { outputSchema: {} }], ["subagent_chain", { outputSchema: {} }], ["subagent_worktree", { outputSchema: {} }],
	] as const) {
		const input = { ...contracts[name].valid, ...patch };
		assert.deepEqual(tools.get(name).prepareArguments(input), input, name);
	}
	const bad: Array<[string, any]> = [
		["wait_for_condition", { jobs: [] }], ["wait_for_condition", { job_mode: "all" }],
		["wait_for_jobs", { jobs: [] }], ["wait_for_jobs", { readiness: true }],
		["wait_for_ready", { jobs: [] }], ["wait_for_ready", { jobs: ["sub_fixture"] }], ["wait_for_ready", { job_mode: "all" }],
		["command_status", { max_bytes: 8192 }], ["command_list", { id: commandId }],
		["command_start", { readiness: { kind: "tcp", port: 12345, timeout_seconds: 1, extra: secret } }],
		["subagent_run", { tasks: [] }], ["subagent_run", { isolation: "worktree" }],
		["subagent_parallel", { tasks: [] }], ["subagent_chain", { chain: [] }],
		["subagent_parallel", { tasks: [{ agent: "worker" }] }], ["subagent_chain", { chain: [{ task: "fixture" }] }],
		["subagent_run", { task: " \n\t" }], ["subagent_interactive", { task: " " }], ["subagent_worktree", { task: " " }],
		["subagent_parallel", { tasks: [{ agent: "worker", task: " " }] }], ["subagent_chain", { chain: [{ agent: "worker", task: " " }] }],
		["subagent_parallel", { tasks: [{ agent: " ", task: "fixture" }] }], ["subagent_chain", { chain: [{ agent: " ", task: "fixture" }] }],
		["subagent_parallel", { tasks: [{ agent: "worker", task: "fixture", background: true }] }],
		["subagent_chain", { chain: [{ agent: "worker", task: "fixture", unexpected: null }] }],
		["subagent_interactive", { outputSchema: {} }], ["subagent_interactive", { isolation: "worktree" }],
		["subagent_worktree", { agent: "worker" }], ["subagent_worktree", { background: false }], ["subagent_worktree", { isolation: "worktree" }],
		["subagent_status", { jobAction: "status" }], ["subagent_answer", { message: secret }],
	];
	for (const [name, patch] of bad) {
		const input = { ...contracts[name].valid, ...patch };
		assert.throws(() => validate(tools.get(name), input), undefined, `${name}: ${JSON.stringify(patch)}`);
		assert.throws(() => tools.get(name).prepareArguments(input), /Invalid arguments/);
	}
});

test("public subagent lifecycle operations preserve foreign ownership, interactive wake, and cancellation requests", async () => {
	const store = await sourceModule(path.join(repo, "extensions/_shared/job-store.ts"));
	const now = new Date().toISOString();
	const jobId = "sub_contract_foreign_owner";
	const owner = { id: "other-live-session", pid: process.pid, startedAt: now, heartbeatAt: now, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
	await store.upsertStoredJob({ id: jobId, status: "awaiting_answer", mode: "single", cwd: dir, startedAt: now, updatedAt: now, interactive: true, maxExchanges: 2, stateRevision: 1, owner,
		question: { id: "q_contract", exchange: 1, text: "Untrusted fixture question", askedAt: now, untrusted: true } });
	assert.match((await call("subagent_list", {})).content[0].text, new RegExp(jobId));
	const status = await call("subagent_status", { jobId });
	assert.equal(status.details.status, "awaiting_answer");
	assert.equal(status.details.question.id, "q_contract");
	const waiting = await call("wait_for_jobs", { jobs: [jobId], job_mode: "any_success", timeout: 2 });
	assert.equal(waiting.details.awaitingJobs, 1);
	const before = store.readBackgroundJobStore().jobs.find((job: any) => job.id === jobId);
	for (const [name, args] of [
		["subagent_answer", { jobId, questionId: "q_contract", answer: "fixture" }],
		["subagent_steer", { jobId, message: "fixture" }],
		["subagent_followup", { jobId, message: "fixture" }],
	] as const) await assert.rejects(call(name, args), /not owned by this live Pi session/);
	assert.deepEqual(store.readBackgroundJobStore().jobs.find((job: any) => job.id === jobId), before);
	const canceled = await call("subagent_cancel", { jobId });
	assert.equal(canceled.details.status, "canceling", "cross-session cancellation requests are not termination");
	const persisted = store.readBackgroundJobStore().jobs.find((job: any) => job.id === jobId);
	assert.equal(persisted.status, "canceling");
	assert.equal(persisted.owner.id, owner.id);
	assert.ok(persisted.cancelRequestedAt);
});

test("strict conversion uses supported closed schemas and preserves arbitrary outputSchema via prefer fallback", async () => {
	const { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } = await dependency("@earendil-works/pi-ai/api/constrained-sampling");
	for (const [name, tool] of tools) {
		const before = wire(tool.parameters);
		assert.equal(resolveJsonSchemaStrictSampling(tool, true), fallbackTools.has(name) ? undefined : true, name);
		assert.equal(resolveJsonSchemaStrictSampling(tool, false), undefined, name);
		if (fallbackTools.has(name)) {
			assert.throws(() => makeStrictJsonSchema(tool.parameters), /unsupported/);
			const outputSchema = { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false };
			assert.deepEqual(tool.prepareArguments({ ...contracts[name].valid, outputSchema }).outputSchema, outputSchema);
		} else {
			const strict = makeStrictJsonSchema(tool.parameters);
			assert.equal(strict.additionalProperties, false, name);
			assert.deepEqual([...strict.required].sort(), Object.keys(strict.properties).sort(), name);
			for (const field of contracts[name].optional) assert.ok(strict.properties[field].anyOf.some((part: any) => part.type === "null"), `${name}.${field}`);
		}
		assert.deepEqual(wire(tool.parameters), before, `${name}: strict conversion must not mutate registration`);
	}
});

test("OpenAI Responses and Google serialize every real tool with strict/fallback semantics", async () => {
	const openai = await dependency("@earendil-works/pi-ai/api/openai-responses-shared");
	const google = await dependency("@earendil-works/pi-ai/api/google-shared");
	const strict = await dependency("@earendil-works/pi-ai/api/constrained-sampling");
	const definitions = [...tools.values()];
	for (const supported of [true, false]) {
		const o = wire(openai.convertResponsesTools(definitions, { supportsStrictMode: supported }));
		const g = wire(google.convertTools(definitions, false, supported))[0].functionDeclarations;
		assert.deepEqual(o.map((item: any) => item.name), [...tools.keys()]);
		assert.deepEqual(g.map((item: any) => item.name), [...tools.keys()]);
		for (const [index, tool] of definitions.entries()) {
			const isStrict = supported && !fallbackTools.has(tool.name);
			const expected = wire(isStrict ? strict.makeStrictJsonSchema(tool.parameters) : tool.parameters);
			assert.equal(o[index].type, "function");
			assert.equal(o[index].strict, supported ? isStrict : undefined, tool.name);
			assert.deepEqual(o[index].parameters, expected, tool.name);
			assert.deepEqual(g[index].parametersJsonSchema, expected, tool.name);
		}
	}
	assert.equal(google.resolveGoogleFunctionCallingMode(definitions, undefined, true), "VALIDATED");
	assert.equal(google.resolveGoogleFunctionCallingMode(definitions, undefined, false), undefined);
});

test("Anthropic public stream serializes tools before any network call", async () => {
	// Anthropic's converter is private. Capture its actual stream payload using
	// public onPayload, then abort there; injected client makes networking impossible.
	const anthropic = await dependency("@earendil-works/pi-ai/api/anthropic-messages");
	const strict = await dependency("@earendil-works/pi-ai/api/constrained-sampling");
	for (const supported of [true, false]) {
		let payload: any;
		let requests = 0;
		const stream = anthropic.stream({ id: "offline-contract", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictTools: supported } },
			{ messages: [
				// Pi 0.86+ provider streams read tool declarations from the transcript.
				...(typeof ai.getCurrentTools === "function" ? [{ role: "system", content: "Offline contract", toolsAdded: [...tools.values()], timestamp: Date.now() }] : []),
				{ role: "user", content: "offline", timestamp: Date.now() },
			], tools: [...tools.values()] },
			{ client: { beta: { messages: { create() { requests++; throw new Error("NETWORK FORBIDDEN"); } } } }, onPayload(value: any) { payload = wire(value); throw new Error("PAYLOAD CAPTURE COMPLETE"); } });
		const result = await stream.result();
		assert.equal(requests, 0);
		assert.match(result.errorMessage, /PAYLOAD CAPTURE COMPLETE/);
		assert.deepEqual(payload.tools.map((tool: any) => tool.name), [...tools.keys()]);
		for (const serialized of payload.tools) {
			const tool = tools.get(serialized.name);
			const isStrict = supported && !fallbackTools.has(tool.name);
			assert.equal(serialized.strict, isStrict ? true : undefined, tool.name);
			// Installed Anthropic fallback intentionally sends only these root
			// keys. Closed-object enforcement still happens locally for every call.
			const expected = isStrict ? strict.makeStrictJsonSchema(tool.parameters) : {
				type: "object", properties: tool.parameters.properties, required: tool.parameters.required ?? [],
			};
			assert.deepEqual(serialized.input_schema, wire(expected), tool.name);
		}
	}
});

test("execute revalidates after a real agent-loop preflight hook mutates validated arguments", async () => {
	const definition = tools.get("command_list");
	const result = await loopCall({ ...definition, execute: (id: string, args: any, signal: any, update: any) => definition.execute(id, args, signal, update, ctx) }, {}, ({ args }: any) => { args.foreign = secret; });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /^Invalid arguments for command_list/);
	assert.ok(!result.content[0].text.includes(secret));
});

test("local command and wait semantics survive schema normalization and real loop finalization", { timeout: 15000 }, async () => {
	assert.deepEqual((await call("command_list", {})).details, []);
	const started = await call("command_start", { command: process.execPath, timeout_seconds: 5, args: ["-e", "process.stdout.write('stdout-contract');process.stderr.write('stderr-contract');process.exitCode=7"], readiness: null });
	const id = started.details.id;
	assert.match(id, /^cmd_/);
	const waited = await call("wait_for_jobs", { jobs: [id], timeout: 5, poll_interval: 1, job_mode: null });
	assert.equal(waited.details.met, true);
	assert.equal(waited.details.failedJobs, 1);
	assert.equal(waited.details.jobMode, "all");
	const status = (await call("command_status", { id })).details;
	assert.equal(status.status, "failed");
	assert.equal(status.exitCode, 7);
	assert.match(JSON.stringify((await call("command_logs", { id, stream: null, cursor: null, max_bytes: null })).details), /stdout-contract/);
	assert.match(JSON.stringify((await call("command_logs", { id, stream: "stderr" })).details), /stderr-contract/);
	const definition = tools.get("wait_for_jobs");
	const failed = await loopCall({ ...definition, execute: (id: string, args: any, signal: any, update: any) => definition.execute(id, args, signal, update, ctx) }, { jobs: [id], timeout: 2, job_mode: "any_success" });
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /All jobs terminal without matching/);
	await assert.rejects(call("wait_for_ready", { jobs: [id], timeout: 1 }), /cannot become ready/);
	const met = await call("wait_for_condition", { condition: "true", timeout: 2, poll_interval: null, progress: null, failure_exit_codes: null });
	assert.equal(met.details.met, true);
	assert.equal(met.details.pollInterval, 10);
	await assert.rejects(call("wait_for_condition", { condition: "exit 127", timeout: 2 }), /exit 127/);
	await assert.rejects(call("wait_for_condition", { condition: "exit 127", timeout: 1, failure_exit_codes: [] }), /Timed out/);
});

test("child recursion exclusion constant includes all five launches, legacy launch, and workflow", async () => {
	const runner = await sourceModule(path.join(repo, "extensions/_shared/pi-agent-runner.ts"));
	assert.deepEqual(new Set(runner.CHILD_DELEGATION_EXCLUSIONS.split(",")), new Set(["spawn_subagent", "subagent_run", "subagent_parallel", "subagent_chain", "subagent_interactive", "subagent_worktree", "workflow"]));
});
