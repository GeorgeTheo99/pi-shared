import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import askUser from '../extensions/ask-user/index.ts';
import integrationBundles from '../extensions/integration-bundles/index.ts';
import askParent from '../extensions/spawn-subagent/ask-parent.ts';

const server = fileURLToPath(new URL('./fixtures/mcp_echo_server.mjs', import.meta.url));
const MCP_TOOL = 'mcp__fixture__echo_text';

test('real SDK: pi-shared tools coexist with built-in MCP and codemode', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mcp-codemode-sdk-'));
  const previous = { list: process.env.PI_INTEGRATION_LIST, agentDir: process.env.PI_CODING_AGENT_DIR };
  let session: any;
  try {
    // The MCP extension reads mcp.json from the process agent directory.
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
    process.env.PI_INTEGRATION_LIST = join(dir, 'master.yaml');
    writeFileSync(process.env.PI_INTEGRATION_LIST, JSON.stringify({ version: 1, defaults: {},
      bundles: { fixture: { description: 'Fixture MCP server', tools: ['mcp__fixture__*'] },
        direct: { description: 'Direct fixture tool', tools: ['fixture_direct'] } } }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createCodemodeExtension(), createMcpExtension(), integrationBundles, askUser, askParent, (pi: any) => {
        pi.registerTool({ name: 'fixture_direct', label: 'fixture_direct', description: 'Local no-op fixture', parameters: Type.Object({}),
          async execute() { return { content: [{ type: 'text', text: 'direct-called' }], details: {} }; } });
      }],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false });
    const model = runtime.getModel('openai', 'gpt-4o');
    assert(model);
    await runtime.setRuntimeApiKey('openai', 'local-fixture-not-a-real-key');
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(dir) }));
    const errors: any[] = [];
    await session.bindExtensions({ onError: (e: any) => errors.push(e) });

    const seen: string[][] = [];
    const results: Record<string, string> = {};
    session.subscribe((event: any) => {
      if (event.type === 'tool_execution_end') results[event.toolCallId] = event.result.content.map((c: any) => c.text ?? '').join('');
    });
    const script = `const r = await tools.${MCP_TOOL}({ text: "hi" });\nreturn JSON.stringify({ echo: r.content[0].text, askUser: "ask_user" in tools, askParent: "ask_parent" in tools });`;
    const calls = [
      { id: 'code-1', name: 'codemode', arguments: { code: script } },
      { id: 'load-direct', name: 'enterprise_load_bundle', arguments: { name: 'direct' } },
      { id: 'load-1', name: 'enterprise_load_bundle', arguments: { name: 'fixture' } },
      { id: 'direct-1', name: MCP_TOOL, arguments: { text: 'direct' } },
    ];
    session.agent.streamFunction = (selected: any, context: any) => {
      seen.push(getCurrentTools(context.messages).map((t: any) => t.name));
      const call = calls[seen.length - 1];
      const message: any = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call ? 'toolUse' : 'stop', content: call ? [{ type: 'toolCall', ...call }] : [{ type: 'text', text: 'done' }] };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      return stream;
    };
    await session.prompt('Exercise the native MCP fixture.');

    assert.deepEqual(errors, []);
    assert.equal(seen.length, 5);
    // The MCP server activates codemode; its tool is callable from scripts without being declared.
    assert(seen[0].includes('codemode') && seen[0].includes('ask_user'));
    assert(!seen[0].includes(MCP_TOOL));
    assert.match(results['code-1'], /"echo":"echo:hi"/);
    // Interactive tools are model-only: declared to the model, never callable from scripts.
    assert.match(results['code-1'], /"askUser":false,"askParent":false/);
    // Pi activating codemode for the MCP server is not an external selection that excludes direct bundles.
    assert.match(results['load-direct'], /Loaded bundle "direct"/);
    // Inactive codemode-exposure tools are loadable, not treated as excluded.
    assert.match(results['load-1'], /fixture/);
    assert.doesNotMatch(results['load-1'], /Unavailable/);
    assert(seen[3].includes(MCP_TOOL) && seen[3].includes('fixture_direct'));
    assert.equal(results['direct-1'], 'echo:direct');
  } finally {
    // Shutdown closes the MCP server process; dispose alone leaves it running.
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session?.dispose();
    for (const [key, value] of [['PI_INTEGRATION_LIST', previous.list], ['PI_CODING_AGENT_DIR', previous.agentDir]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
