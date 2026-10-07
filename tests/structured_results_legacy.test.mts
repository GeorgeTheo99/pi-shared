import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// No codemode API imports: this also runs against pre-codemode SDK installations.
test('additive result fields load on pre-codemode Pi without changing text/details or thrown failures', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'structured-legacy-')));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const previous = new Map<string, string | undefined>();
  let extensions: any[] = [];
  try {
    for (const [key, value] of Object.entries({ PI_COMMAND_STATE_DIR: path.join(dir, 'commands'), PI_SUBAGENT_STATE_DIR: path.join(dir, 'subagents'), PI_MEMORY_DIR: path.join(dir, 'memory'), PI_SOFTWARE_KB_ROOT: path.join(dir, 'kb'), PI_SUBAGENT_DEPTH: '0', PI_SUBAGENT_MAX_DEPTH: '1' })) {
      previous.set(key, process.env[key]); process.env[key] = value;
    }
    fs.mkdirSync(path.join(dir, 'kb')); fs.writeFileSync(path.join(dir, 'kb/sources.json'), JSON.stringify({ version: 1, sources: [] }));
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'profile'), settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: ['command-jobs', 'spawn-subagent', 'wait-for', 'memory', 'software-kb', 'websearch', 'verification'].map(name => path.join(repo, 'extensions', name, 'index.ts')) });
    await loader.reload(); const loaded = loader.getExtensions(); extensions = loaded.extensions; assert.deepEqual(loaded.errors, []);
    const tools = new Map<string, any>(extensions.flatMap(e => [...e.tools.values()].map((tool: any) => [tool.definition.name, tool.definition])));
    const ctx = { cwd: dir, isProjectTrusted: () => true, hasUI: false };
    for (const [name, args] of [['command_list', {}], ['subagent_list', {}], ['memory_read', {}], ['kb_search', { query: 'fixture' }]] as const) {
      const result = await tools.get(name).execute('legacy', args, undefined, undefined, ctx);
      assert.equal(result.content[0].type, 'text'); assert(result.details); assert.equal(result.structuredContent.version, 1);
      assert.equal(result.structuredContent.status, 'ok');
    }
    await assert.rejects(tools.get('subagent_status').execute('legacy', { jobId: 'sub_missing' }, undefined, undefined, ctx), /not found/);
    await assert.rejects(tools.get('wait_for_jobs').execute('legacy', { jobs: ['sub_missing'], timeout: 2 }, undefined, undefined, ctx), /Unknown/);
  } finally {
    for (const extension of extensions) for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ reason: 'exit' }, { cwd: dir });
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
