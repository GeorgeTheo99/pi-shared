// Explicit cross-repo contract check; pass a trusted source backend launcher.
// node --experimental-loader ./tests/fixtures/setup_test_loader.mjs tests/fixtures/peekaboo_backend_contract.mjs /absolute/launcher
// Uses only private fixture config and invalid offline plans. No probes or writes by the backend.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runBackend } from '../../extensions/setup/backend.ts';

const backend = process.argv[2];
assert.ok(backend && isAbsolute(backend), 'Pass an explicit absolute backend launcher path');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peekaboo-contract-')));
const config = join(dir, 'mcp.json');
try {
  const cases = [
    { args: ['--bridge-socket', join(dir, 'bridge.sock')], mode: 'direct', state: 'not-applicable', error: /requires Bridge mode/ },
    { args: ['--mode', 'direct', '--bridge-socket', join(dir, 'bridge.sock')], mode: 'direct', state: 'not-applicable', error: /requires Bridge mode/ },
    { args: ['--mode', 'bridge'], mode: 'bridge', state: 'invalid', error: /requires --bridge-socket/ },
    { args: ['--mode', 'bridge', '--bridge-socket', 'relative'], mode: 'bridge', state: 'invalid', error: /normalized absolute path/ },
  ];
  for (const item of cases) {
    const report = await runBackend(backend, 'plan', ['--config', config, ...item.args], new AbortController().signal);
    assert.equal(report.ok, false);
    assert.equal(report.evidence.mode, item.mode);
    assert.equal(report.evidence.bridgeSocketState, item.state);
    assert.equal(report.evidence.runnable, 'not-tested');
    assert.equal(report.evidence.permissionSource, null);
    assert.match(report.errors.join('\n'), item.error);
    assert.equal(existsSync(config), false);
  }
  writeFileSync(config, JSON.stringify({ mcpServers: { peekaboo: {
    command: '/fixture/peekaboo', args: ['mcp', '--bridge-socket', join(dir, 'original.sock'), '--allow-foreground'],
    env: { PEEKABOO_DISABLE_TOOLS: 'browser' }, lifecycle: 'lazy-keep-alive', requestTimeoutMs: 30000, directTools: false,
  } } }), { mode: 0o600 });
  const conflict = await runBackend(backend, 'plan', ['--config', config, '--bridge-socket', join(dir, 'different.sock')], new AbortController().signal);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.evidence.configuration, 'conflict');
  assert.equal(conflict.evidence.mode, 'bridge');
  assert.equal(conflict.evidence.bridgeSocketState, 'invalid');
  assert.match(conflict.errors.join('\n'), /Selected Bridge socket conflicts/);
  console.log('PASS: five actual backend failure reports preserve actionable diagnostics through the frontend schema-v2 parser.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
