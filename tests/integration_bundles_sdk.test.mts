import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import integrationBundles from '../extensions/integration-bundles/index.ts';

test('real SDK: bundle load makes tools callable on the immediately following turn; core exclusions survive', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'integration-bundles-sdk-'));
  const previous = process.env.PI_INTEGRATION_LIST;
  let session: any;
  const fetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is forbidden in this fixture'); };
  try {
    process.env.PI_INTEGRATION_LIST = join(dir, 'master.yaml');
    writeFileSync(process.env.PI_INTEGRATION_LIST, JSON.stringify({ version: 1, bundles: {
      fixture: { description: 'Local fixture', tools: ['fixture_echo'] },
      excluded: { description: 'Excluded fixture', tools: ['fixture_excluded'] },
    }, defaults: {} }));
    let executed = 0;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [integrationBundles, (pi: any) => {
        for (const name of ['fixture_echo', 'fixture_excluded']) pi.registerTool({ name, label: name, description: 'Local no-op fixture', parameters: Type.Object({}),
          async execute() { executed++; return { content: [{ type: 'text', text: 'fixture-called' }], details: {} }; } });
      }],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false });
    const model = runtime.getModel('openai', 'gpt-4o');
    assert(model);
    await runtime.setRuntimeApiKey('openai', 'local-fixture-not-a-real-key');
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(dir), excludeTools: ['bash', 'fixture_excluded'] }));
    const errors: any[] = [];
    await session.bindExtensions({ onError: (e: any) => errors.push(e) });
    assert.deepEqual(errors, []);
    assert(!session.getActiveToolNames().includes('fixture_echo'));
    assert(!session.getActiveToolNames().includes('bash'));
    let turns = 0;
    const seen: string[][] = [];
    session.agent.streamFunction = (selected: any, context: any) => {
      seen.push(context.tools.map((t: any) => t.name));
      const turn = ++turns;
      const message: any = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: turn < 3 ? 'toolUse' : 'stop',
        content: turn === 1 ? [{ type: 'toolCall', id: 'load-1', name: 'enterprise_load_bundle', arguments: { name: 'fixture' } }] :
          turn === 2 ? [{ type: 'toolCall', id: 'echo-1', name: 'fixture_echo', arguments: {} }] : [{ type: 'text', text: 'done' }],
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
      return stream;
    };
    await session.prompt('Exercise the local fixture.');
    assert.equal(turns, 3);
    assert(!seen[0].includes('fixture_echo'));
    assert(seen[1].includes('fixture_echo'));
    assert.equal(executed, 1);
    assert.equal(networkAttempts, 0);
    assert(seen.every(names => !names.includes('bash') && !names.includes('fixture_excluded')));
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_INTEGRATION_LIST; else process.env.PI_INTEGRATION_LIST = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
