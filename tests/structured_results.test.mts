import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { structuredTool } from '../extensions/_shared/structured-result.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const commandId = 'cmd_00000000-0000-0000-0000-000000000001';
const names = ['command_start', 'command_cancel', 'command_status', 'command_list', 'subagent_status', 'subagent_list', 'wait_for_jobs', 'wait_for_ready', 'wait_for_condition', 'memory_read', 'kb_search', 'web_search', 'verify', 'dev_doctor', 'peer_sessions'];

test('structured helper preserves text/details/isError and exceptions, and projects nested fields', async () => {
  const details = { rendererOnly: 'private' };
  const content = [{ type: 'text', text: 'original' }];
  const tool = structuredTool({ async execute() { return { content, details, isError: true }; } },
    Type.Object({ items: Type.Array(Type.Object({ value: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
    () => ({ data: { internal: 'secret', items: [{ value: 'public', internal: 'secret' }] } }));
  const result = await tool.execute();
  assert.equal(result.details, details); assert.equal(result.content, content); assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { version: 1, status: 'error', data: { items: [{ value: 'public' }] } });
  assert(Check(tool.outputSchema, result.structuredContent));
  const failure = new Error('abort');
  const throwing = structuredTool({ async execute() { throw failure; } }, Type.Object({}), () => ({ data: {} }));
  await assert.rejects(throwing.execute(), error => error === failure);
});

test('priority tools: real schemas, outcomes, privacy projections and SDK codemode', { timeout: 60000 }, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'structured-results-')));
  const previous = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { previous.set(key, process.env[key]); process.env[key] = value; };
  let session: any;
  let extensions: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const query = JSON.parse(body).params.arguments.query;
    if (query === 'transport-failure') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', result: { isError: true, content: [{ type: 'text', text: 'MCP failure fixture' }] } }));
      return;
    }
    const payload = query === 'failure' ? { error: 'fixture failure' } : { results: [
      { title: 'Fixture', url: 'https://example.com/', snippet: 'Evidence', privateMetadata: 'DO_NOT_EXPORT' },
      { title: 'Extra', url: 'https://example.com/extra', snippet: 'extra' },
    ], backend: 'DO_NOT_EXPORT' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'fixture', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixtureOrigin = `http://127.0.0.1:${(server.address() as any).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: any, init?: any) => {
    assert.equal(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin, fixtureOrigin, 'Tests must never use personal endpoints');
    return originalFetch(input, init);
  };
  const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  try {
    for (const [key, value] of Object.entries({ PI_COMMAND_STATE_DIR: path.join(dir, 'commands'), PI_SUBAGENT_STATE_DIR: path.join(dir, 'subagents'),
      PI_SUBAGENT_DEPTH: '0', PI_SUBAGENT_MAX_DEPTH: '1', PI_SESSION_COORDINATOR_DIR: path.join(dir, 'peers'), PI_MEMORY_DIR: path.join(dir, 'memory'), PI_SOFTWARE_KB_ROOT: path.join(dir, 'kb'),
      HOME: dir, PI_CODING_AGENT_DIR: path.join(dir, 'profile'), PI_WEBSEARCH_MCP_URL: `${fixtureOrigin}/mcp`, SEARCH_MCP_URL: '', WEBSEARCH_MCP_URL: '',
      PI_WEBSEARCH_MCP_API_KEY: '', SEARCH_MCP_API_KEY: '', PI_WEBSEARCH_TAVILY_API_KEY: '', TAVILY_API_KEY: '',
    })) setEnv(key, value);
    const now = Date.now();
    writeJson(path.join(dir, 'commands', commandId, 'job.json'), { version: 1, id: commandId, owner: 'DO_NOT_EXPORT', ownerPid: process.pid,
      project: dir, label: 'fixture', status: 'failed', createdAt: now, updatedAt: now, finishedAt: now, exitCode: 3, exitSignal: null, cleanup: 'confirmed', readiness: 'not_requested' });
    writeJson(path.join(dir, 'subagents/jobs.json'), { version: 3, revision: 1, updatedAt: new Date().toISOString(), jobs: [{
      id: 'sub_fixture', status: 'failed', mode: 'single', label: 'fixture', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: 'child failed',
      result: { contentText: 'child output', details: { mode: 'single', agentScope: 'shared', agents: [], sharedAgentsDir: 'DO_NOT_EXPORT', userAgentsDir: 'DO_NOT_EXPORT', projectAgentsDir: null,
        results: [{ agent: 'worker', agentSource: 'shared', task: 'DO_NOT_EXPORT', exitCode: 1, stderr: 'DO_NOT_EXPORT', usage: {}, output: 'child output', status: 'failed', structuredOutput: { answer: 42 } }] } },
    }] });
    writeJson(path.join(dir, 'kb/sources.json'), { version: 1, sources: [{ id: 'fixture', title: 'Fixture reliability', tags: ['reliability'], access: 'metadata_only' }] });
    fs.writeFileSync(path.join(dir, 'input'), 'fixture');
    writeJson(path.join(dir, '.pi/verification.json'), { version: 1, checks: [0, 1].map(code => ({ id: `exit-${code}`, command: process.execPath, args: ['-e', `process.exit(${code})`], cwd: '.', timeoutSeconds: 5,
      inputs: { paths: ['input'], exclude: [], untracked: 'include' }, report: { format: 'exit' } })) });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ['+codemode'] });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'profile'), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: ['command-jobs', 'spawn-subagent', 'wait-for', 'memory', 'software-kb', 'websearch', 'verification', 'dev-doctor', 'session-coordinator'].map(name => path.join(repo, 'extensions', name, 'index.ts')),
      extensionFactories: [createCodemodeExtension({ mode: 'on' }), (pi: any) => {
        pi.registerTool(structuredTool({ name: 'structured_failure_fixture', label: 'Failure', description: 'In-process error fixture', parameters: Type.Object({}),
          async execute() { return { content: [{ type: 'text', text: 'fixture failure' }], details: {}, isError: true }; } }, Type.Object({ reason: Type.String() }), () => ({ data: { reason: 'fixture' } })));
      }],
    });
    await loader.reload();
    const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); extensions = loaded.extensions;
    const tools = new Map<string, any>(extensions.flatMap(e => [...e.tools.values()].map((tool: any) => [tool.definition.name, tool.definition])));
    for (const name of names) assert(tools.get(name)?.outputSchema, `${name} must advertise outputSchema`);
    const ctx: any = { cwd: dir, hasUI: true, isProjectTrusted: () => true, ui: { confirm: async () => true, notify() {} } };
    const call = async (name: string, args: any, signal?: AbortSignal) => {
      const tool = tools.get(name); const result = await tool.execute('contract', args, signal, undefined, ctx);
      if (tool.outputSchema) assert(Check(tool.outputSchema, result.structuredContent), `${name}: schema mismatch: ${JSON.stringify(result.structuredContent)}`);
      return result;
    };
    await t.test('inactive peer lookup exposes an explicit unavailable result', async () => {
      const peers = await call('peer_sessions', {});
      assert.equal(peers.structuredContent.status, 'error');
      assert.equal(peers.structuredContent.data.available, false);
      assert.deepEqual(peers.structuredContent.data.peers, []);
    });
    let passedId: string, failedId: string;
    await t.test('domain outcomes stay distinct; no owner/path/task metadata leaks', async () => {
      const status = await call('command_status', { id: commandId });
      assert.equal(status.structuredContent.status, 'ok'); assert.equal(status.structuredContent.data.job.status, 'failed');
      assert.equal(status.structuredContent.data.job.exitCode, 3); assert.equal(status.details.owner, 'DO_NOT_EXPORT');
      assert.equal(status.structuredContent.data.job.exitSignal, null);
      const listed = await call('command_list', {}); assert.equal(listed.structuredContent.data.jobs.length, 1);
      const sub = await call('subagent_status', { jobId: 'sub_fixture' });
      assert.equal(sub.structuredContent.data.job.status, 'failed'); assert.equal(sub.structuredContent.data.job.results[0].output, 'child output');
      assert.deepEqual(sub.structuredContent.data.job.results[0].structuredOutput, { answer: 42 });
      const subList = (await call('subagent_list', {})).structuredContent.data.jobs;
      assert.equal(subList.length, 1); assert.equal(subList[0].results, undefined);
      const waited = await call('wait_for_jobs', { jobs: [commandId, 'sub_fixture'], timeout: 2 });
      assert.equal(waited.structuredContent.data.met, true); assert.equal(waited.structuredContent.data.failedJobs, 2);
      assert.equal(waited.structuredContent.data.jobSnapshots[0].command.exitCode, 3);
      for (const result of [status, listed, sub, waited]) assert(!JSON.stringify(result.structuredContent).includes('DO_NOT_EXPORT'));
      assert.equal((await call('wait_for_condition', { condition: 'true', timeout: 2 })).structuredContent.data.met, true);
      const abort = new AbortController(); abort.abort();
      assert.equal((await call('wait_for_jobs', { jobs: [commandId], timeout: 2 }, abort.signal)).structuredContent.status, 'aborted');
      await assert.rejects(call('wait_for_jobs', { jobs: ['sub_missing'], timeout: 2 }), /Unknown/);
      await assert.rejects(call('wait_for_ready', { jobs: [commandId], timeout: 2 }), /cannot become ready/);
      await assert.rejects(call('command_status', { id: 'cmd_00000000-0000-0000-0000-000000000002' }), /Unknown/);
      await assert.rejects(call('subagent_status', { jobId: 'sub_missing' }), /not found/);
      await assert.rejects(call('wait_for_condition', { condition: 'exit 127', timeout: 2 }), /Condition evaluation failed/);
      await assert.rejects(call('wait_for_condition', { condition: 'false', timeout: 1 }), /Timed out/);
      const started = await call('command_start', { command: process.execPath, args: ['-e', ''], timeout_seconds: 5 });
      const startedId = started.structuredContent.data.job.id;
      const completed = await call('wait_for_jobs', { jobs: [startedId], timeout: 5, poll_interval: 1 });
      assert.equal(completed.structuredContent.data.failedJobs, 0);
      assert.equal((await call('command_status', { id: startedId })).structuredContent.data.job.status, 'succeeded');
      assert.equal((await call('command_cancel', { id: startedId })).structuredContent.data.job.status, 'succeeded');
      const readyId = 'cmd_00000000-0000-0000-0000-000000000003';
      writeJson(path.join(dir, 'commands', readyId, 'job.json'), { version: 1, id: readyId, owner: 'DO_NOT_EXPORT', ownerPid: process.pid,
        project: dir, label: 'ready fixture', status: 'running', createdAt: Date.now(), updatedAt: Date.now(), readiness: 'ready' });
      const ready = await call('wait_for_ready', { jobs: [readyId], timeout: 2 });
      assert.equal(ready.structuredContent.data.met, true); assert.equal(ready.structuredContent.data.jobSnapshots[0].command.status, 'running');
      const storePath = path.join(dir, 'subagents/jobs.json'); const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      store.jobs.push({ id: 'sub_question', status: 'awaiting_answer', mode: 'single', label: 'question fixture', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        owner: { id: 'foreign', pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() },
        interactive: true, maxExchanges: 10, question: { id: 'q_fixture', exchange: 1, text: 'Untrusted fixture question', askedAt: new Date().toISOString(), untrusted: true } });
      writeJson(storePath, store);
      const question = await call('subagent_status', { jobId: 'sub_question' });
      assert.equal(question.structuredContent.data.job.question.id, 'q_fixture'); assert.equal(question.structuredContent.data.job.question.untrusted, true);
      const actionable = await call('wait_for_jobs', { jobs: ['sub_question'], timeout: 2 });
      assert.equal(actionable.structuredContent.data.awaitingJobs, 1); assert.equal(actionable.structuredContent.data.jobSnapshots[0].status, 'awaiting_answer');
    });
    await t.test('memory respects mode; KB and web search return selected bounded data', async () => {
      const first = await call('memory_write', { action: 'add', text: 'Durable fixture fact', source: 'fixture test' });
      const second = await call('memory_write', { action: 'add', text: 'Archived fixture fact', source: 'fixture test' });
      await call('memory_write', { action: 'archive', id: second.details.memory.id });
      const active = await call('memory_read', {});
      assert.equal(active.details.memories.length, 2); assert.equal(active.structuredContent.data.memories.length, 1);
      assert.equal(active.structuredContent.data.memories[0].id, first.details.memory.id);
      assert.equal((await call('memory_read', { mode: 'all' })).structuredContent.data.memories.length, 2);
      assert.equal((await call('memory_read', { mode: 'review' })).structuredContent.data.memories.length, 0);
      assert.equal(active.structuredContent.data.project.root, undefined);
      const kb = await call('kb_search', { query: 'reliability' });
      assert.equal(kb.structuredContent.data.results[0].source_id, 'fixture'); assert.equal(kb.structuredContent.data.kb_root, undefined);
      assert.equal((await call('kb_search', { query: 'no-matching-phrase', mode: 'exact' })).structuredContent.data.count, 0);
      const web = await call('web_search', { query: 'fixture', num_results: 1 });
      assert.equal(web.details.results.length, 2); assert.equal(web.structuredContent.data.results.length, 1);
      assert.equal(web.structuredContent.data.results[0].url, 'https://example.com/');
      assert(!JSON.stringify(web.structuredContent).includes('DO_NOT_EXPORT'));
      const failure = await call('web_search', { query: 'failure' }); assert.equal(failure.structuredContent.status, 'error');
      assert.equal((await call('web_search', { query: 'transport-failure' })).structuredContent.status, 'error');
      const abort = new AbortController(); abort.abort();
      await assert.rejects(call('web_search', { query: 'fixture' }, abort.signal), /abort/i);
    });
    await t.test('verification lists and verdicts are typed without argv or internal evidence', async () => {
      assert.equal((await call('verify', { action: 'list' })).structuredContent.data.checks.length, 2);
      await assert.rejects(call('verify', { action: 'run', check: 'exit-0' }), /not trusted/);
      const command = extensions.flatMap(e => [...e.commands.values()]).find((c: any) => c.name === 'verification-trust');
      assert(command); await command.handler('', ctx);
      const passed = await call('verify', { action: 'run', check: 'exit-0' }); passedId = passed.details.id;
      const failed = await call('verify', { action: 'run', check: 'exit-1' }); failedId = failed.details.id;
      assert.equal(passed.structuredContent.status, 'ok'); assert.equal(failed.structuredContent.status, 'error');
      assert.equal(failed.structuredContent.data.verdict, 'failed'); assert.equal(failed.structuredContent.data.process.exitCode, 1);
      assert.equal(passed.structuredContent.data.command, undefined); assert.equal(passed.structuredContent.data.check.args, undefined);
      assert.equal((await call('verify', { action: 'result', id: passedId })).structuredContent.data.verdict, 'passed');
    });
    await t.test('real SDK codemode reads objects directly, resolves explicit error payloads, rejects thrown failures', async () => {
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: path.join(dir, 'models.json'), modelsStorePath: path.join(dir, 'model-store.json'), allowModelNetwork: false });
      const model = runtime.getModel('openai', 'gpt-4o'); assert(model); await runtime.setRuntimeApiKey('openai', 'fixture-not-a-key');
      ({ session } = await createAgentSession({ cwd: dir, agentDir: path.join(dir, 'profile'), modelRuntime: runtime, model, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir) }));
      const errors: any[] = []; await session.bindExtensions({ onError: (e: any) => errors.push(e) });
      const doctor = await call('dev_doctor', {});
      assert(['inspection_complete', 'issues_found'].includes(doctor.structuredContent.data.outcome));
      assert.equal(doctor.structuredContent.data.mcp_connections.native.service_readiness, 'not_probed');
      const script = `
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const c = await tools.command_status({id:${JSON.stringify(commandId)}});
        check(c.version === 1 && c.data.job.exitCode === 3 && c.data.job.status === 'failed', 'command object');
        check((await tools.command_list({})).data.jobs.length >= 1, 'command list');
        check((await tools.subagent_status({jobId:'sub_fixture'})).data.job.results[0].structuredOutput.answer === 42, 'subagent object');
        check((await tools.subagent_list({})).data.jobs.find(j => j.id === 'sub_fixture').status === 'failed', 'subagent list');
        const w = await tools.wait_for_jobs({jobs:[${JSON.stringify(commandId)}],timeout:2});
        check(w.data.met && w.data.failedJobs === 1, 'wait != job success');
        check((await tools.memory_read({})).data.memories.length === 1, 'filtered memory');
        check((await tools.kb_search({query:'reliability'})).data.results[0].source_id === 'fixture', 'KB object');
        check((await tools.web_search({query:'fixture',num_results:1})).data.results[0].url === 'https://example.com/', 'search object');
        check((await tools.web_search({query:'failure'})).status === 'error', 'search failure');
        check((await tools.verify({action:'list'})).data.checks.length === 2, 'verification list');
        const doctor = await tools.dev_doctor({});
        check(doctor.version === 1 && doctor.data.mcp_connections.native.service_readiness === 'not_probed', 'doctor object');
        const peers = await tools.peer_sessions({scope:'project'});
        check(peers.version === 1 && peers.data.available && Array.isArray(peers.data.peers), 'peer object');
        check((await tools.verify({action:'result',id:${JSON.stringify(passedId!)}})).data.verdict === 'passed', 'passed verdict');
        check((await tools.verify({action:'result',id:${JSON.stringify(failedId!)}})).status === 'error', 'failed verdict');
        check((await tools.structured_failure_fixture({})).status === 'error', 'isError payload must be explicit');
        let rejected = false;
        try { await tools.subagent_status({jobId:'sub_missing'}); } catch { rejected = true; }
        check(rejected, 'thrown failure must reject');
        return 'STRUCTURED_RESULTS_OK';
      `;
      assert(!script.includes('JSON.parse'));
      let turns = 0; const results: any[] = [];
      session.subscribe((event: any) => { if (event.type === 'tool_execution_end') results.push(event); });
      session.agent.streamFunction = (selected: any) => {
        const first = turns++ === 0;
        const message: any = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: first ? 'toolUse' : 'stop', content: first ? [{ type: 'toolCall', id: 'structured-code', name: 'codemode', arguments: { code: script } }] : [{ type: 'text', text: 'done' }] };
        const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
      };
      await session.prompt('Run the local structured contract fixture.');
      assert.deepEqual(errors, []);
      for (const event of results) {
        const schema = tools.get(event.toolName)?.outputSchema;
        if (schema && event.result.structuredContent !== undefined) {
          assert(Check(schema, event.result.structuredContent), `${event.toolName}: runtime structured result must match its schema`);
        }
      }
      const result = results.find(e => e.toolCallId === 'structured-code'); assert(result);
      assert.equal(result.isError, false, JSON.stringify(result.result));
      assert.match(result.result.content.map((c: any) => c.text ?? '').join(''), /STRUCTURED_RESULTS_OK/);
      assert(results.some(e => e.toolName === 'structured_failure_fixture' && e.isError));
    });
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    else for (const extension of extensions) for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ reason: 'exit' }, { cwd: dir });
    globalThis.fetch = originalFetch;
    server.close(); server.closeAllConnections();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
