import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import setupExtension, { runWizard, formatReport } from '../extensions/setup/index.ts';
import { parseReport, resolveSetupExecutable, runBackend, homebrewAdminAncestor, type SetupReport } from '../extensions/setup/backend.ts';

function report(action: SetupReport['action'] = 'plan'): SetupReport {
  return { schemaVersion: 1, component: 'peekaboo', action, ok: true, summary: 'Fixture plan',
    actions: ['Configure the full catalog'], warnings: [], errors: [], nextSteps: [], planId: 'a'.repeat(64),
    evidence: { binaryPath: '/trusted/peekaboo', binaryPresent: true, configuration: 'missing', runnable: 'not-tested',
      permissions: { screenRecording: 'unknown', accessibility: 'unknown', eventSynthesizing: 'unknown' },
      mcp: 'not-tested', toolCount: null, desktop: 'not-tested' } };
}
function ui(selections: Array<string | undefined> = [], approved = false, input?: string) {
  const notices: string[] = [], confirmations: string[] = [], menus: string[][] = [];
  return { notices, confirmations, menus, ctx: { ui: {
    notify: (text: string) => notices.push(text),
    select: async (_title: string, options: string[]) => { menus.push(options); return selections.shift(); },
    confirm: async (_title: string, text: string) => { confirmations.push(text); return approved; },
    input: async () => input,
  } } as any };
}

test('strict versioned reports reject incompatible, oversized, and false readiness claims', () => {
  assert.equal(parseReport(JSON.stringify(report()), 'plan').component, 'peekaboo');
  for (const bad of [ { ...report(), schemaVersion: 2 }, { ...report(), action: 'apply' },
    { ...report(), warnings: 'not an array' }, { ...report(), planId: '--yes' },
    { ...report(), evidence: { ...report().evidence, desktop: 'succeeded' } },
    { ...report(), evidence: { ...report().evidence, permissions: null } } ]) {
    assert.throws(() => parseReport(JSON.stringify(bad), 'plan'), /Unsupported|malformed/);
  }
  assert.throws(() => parseReport('old CLI usage', 'plan'), /Update the owning/);
  assert.throws(() => parseReport(' '.repeat(65537), 'plan'), /size limit/);
});

test('report presentation separates inventory from desktop readiness and strips ANSI', () => {
  const value = report(); value.summary = '\x1b[31mConnected\x1b[0m'; value.evidence.mcp = 'connected'; value.evidence.toolCount = 26;
  const text = formatReport(value);
  assert.ok(!text.includes('\x1b'));
  assert.match(text, /tools: 26/);
  assert.match(text, /Desktop interaction: not tested/);
});

test('canceled selection or confirmation never applies or probes', async () => {
  for (const selections of [[undefined], ['Configure Peekaboo MCP']]) {
    const mock = ui(selections); const actions: string[] = [];
    await runWizard(mock.ctx, async action => { actions.push(action); return report(action); });
    assert.deepEqual(actions, ['plan']);
  }
});

test('apply uses exactly the approved plan ID and does not auto-probe', async () => {
  const mock = ui(['Configure Peekaboo MCP'], true); const calls: any[] = [];
  await runWizard(mock.ctx, async (action, args) => { calls.push([action, args]); return report(action); });
  assert.deepEqual(calls, [['plan', []], ['apply', ['--yes', '--expected-plan', 'a'.repeat(64)]]]);
  assert.match(mock.confirmations[0], /full tool catalog/);
  assert.ok(mock.notices.some(s => s.includes('Restart Pi or run /reload')));
});

test('install is explicitly selected, separately planned, warned and confirmed', async () => {
  const mock = ui(['Preview compatibility CLI install (4.5.0; known limitations)'], true); const calls: any[] = [];
  await runWizard(mock.ctx, async (action, args) => {
    calls.push([action, args]); const value = report(action); value.evidence.binaryPresent = false;
    value.warnings = ['Compatibility release lacks later input safety fixes'];
    if (args.includes('--install')) value.planId = 'b'.repeat(64);
    return value;
  });
  assert.deepEqual(calls, [['plan', []], ['plan', ['--install']], ['apply', ['--install', '--yes', '--expected-plan', 'b'.repeat(64)]]]);
  assert.match(mock.confirmations[0], /input safety fixes/);
});

test('existing path is one argv value, cancellation is terminal, relative paths rejected', async () => {
  for (const input of [undefined, '', '~/peekaboo', 'peekaboo; echo nope']) {
    const mock = ui(['Choose an existing Peekaboo executable'], false, input); let calls = 0;
    await runWizard(mock.ctx, async action => { calls++; return report(action); });
    assert.equal(calls, 1);
  }
  const mock = ui(['Choose an existing Peekaboo executable', undefined], false, '/trusted/path with spaces/peekaboo');
  const calls: any[] = [];
  await runWizard(mock.ctx, async (action, args) => { calls.push([action, args]); return report(action); });
  assert.deepEqual(calls[1], ['plan', ['--binary', '/trusted/path with spaces/peekaboo']]);
});

test('CLI check is explicit and does not claim MCP or desktop success', async () => {
  const mock = ui(['Check CLI and permissions (no desktop actions)']); const calls: string[] = [];
  await runWizard(mock.ctx, async action => { calls.push(action); return report(action); });
  assert.deepEqual(calls, ['plan', 'check']);
  assert.equal(mock.confirmations.length, 0);
  assert.match(mock.notices.at(-1)!, /not tested/);
});

test('conflicts do not offer apply or install; session cancellation cannot apply', async () => {
  const mock = ui([undefined]);
  await runWizard(mock.ctx, async action => { const value = report(action); value.ok = false; value.evidence.configuration = 'conflict'; return value; });
  assert.ok(mock.menus[0].every(s => !s.startsWith('Configure') && !s.startsWith('Preview compatibility')));
  const controller = new AbortController(); let calls = 0;
  const ctx = ui(['Configure Peekaboo MCP'], true).ctx;
  ctx.ui.confirm = async () => { controller.abort(); return true; };
  await runWizard(ctx, async action => { calls++; return report(action); }, controller.signal);
  assert.equal(calls, 1);
});

test('slash entry refuses headless, busy and unsupported targets before backend discovery', async () => {
  const commands = new Map<string, any>();
  setupExtension({ on() {}, registerCommand(name: string, command: any) { commands.set(name, command); } } as any);
  assert.deepEqual([...commands.keys()], ['setup']);
  for (const [args, mode, idle] of [['', 'print', true], ['peekaboo', 'tui', false], ['unknown-capability', 'tui', true]] as const) {
    const mock = ui(); await commands.get('setup').handler(args, { ...mock.ctx, mode, isIdle: () => idle });
    assert.equal(mock.notices.length, 1);
  }
});

test('session shutdown awaits cleanup even when the setup backend ignores TERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-shutdown-'));
  const prior = process.env.PI_SHARED_SETUP_BIN;
  try {
    const backend = join(dir, 'fixture');
    const pidFile = join(dir, 'pid');
    writeFileSync(backend, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    process.env.PI_SHARED_SETUP_BIN = backend;
    const commands = new Map<string, any>(), events = new Map<string, any>();
    setupExtension({ on(name: string, handler: any) { events.set(name, handler); },
      registerCommand(name: string, command: any) { commands.set(name, command); }, getAllTools: () => [{ name: 'mcp' }] } as any);
    const mock = ui(); let dialogs = 0;
    let shutdown: Promise<void> | undefined;
    mock.ctx.ui.custom = (factory: any) => new Promise(resolve => {
      factory({}, {}, {}, resolve);
      shutdown = (async () => {
        const deadline = Date.now() + 5000;
        while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        assert.ok(existsSync(pidFile));
        const pid = Number(readFileSync(pidFile, 'utf8'));
        await events.get('session_shutdown')();
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'shutdown must not return before owned backend exits');
      })();
    });
    mock.ctx.ui.select = async () => { dialogs++; return undefined; };
    await commands.get('setup').handler('peekaboo', { ...mock.ctx, mode: 'tui', isIdle: () => true });
    await shutdown;
    assert.equal(dialogs, 0);
    assert.ok(mock.notices.some(s => /aborted|canceled/.test(s)));
  } finally {
    if (prior === undefined) delete process.env.PI_SHARED_SETUP_BIN; else process.env.PI_SHARED_SETUP_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Homebrew admin-writable ancestor exception is narrowly package-bound', () => {
  const executable = '/opt/homebrew/Cellar/pi-shared/0.1.21/bin/pi-shared';
  const allowed = (exe = executable, ancestor = '/opt/homebrew/Cellar', gid = 80, mode = 0o775, platform = 'darwin', groups = [20, 80]) =>
    homebrewAdminAncestor(exe, ancestor, gid, mode, platform, groups);
  assert.equal(allowed(), true);
  assert.equal(allowed(executable, '/opt/homebrew'), true);
  assert.equal(allowed('/usr/local/Cellar/pi-shared/0.1.21/bin/pi-shared', '/usr/local/Cellar'), true);
  assert.equal(allowed('/tmp/source/bin/pi-shared'), false);
  assert.equal(allowed('/opt/homebrew/Cellar/other/1/bin/pi-shared'), false);
  assert.equal(allowed(executable, '/opt/homebrew/Cellar/pi-shared/0.1.21'), false);
  assert.equal(allowed(executable, '/opt/homebrew/Cellar', 20), false);
  assert.equal(allowed(executable, '/opt/homebrew/Cellar', 80, 0o777), false);
  assert.equal(allowed(executable, '/opt/homebrew/Cellar', 80, 0o775, 'linux'), false);
  assert.equal(allowed(executable, '/opt/homebrew/Cellar', 80, 0o775, 'darwin', [20]), false);
});

test('installer resolution requires an absolute trusted executable, never PATH/cwd', () => {
  assert.throws(() => resolveSetupExecutable({ PI_SHARED_SETUP_BIN: './pi-shared' }), /absolute/);
  assert.throws(() => resolveSetupExecutable({ PI_SHARED_SETUP_BIN: '' }), /absolute/);
  const dir = mkdtempSync(join(tmpdir(), 'setup-resolve-'));
  try {
    const file = join(dir, 'pi-shared'); writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(resolveSetupExecutable({ PI_SHARED_SETUP_BIN: file, PATH: '/malicious/project' }), realpathSync(file));
    chmodSync(file, 0o777);
    assert.throws(() => resolveSetupExecutable({ PI_SHARED_SETUP_BIN: file }), /Unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real runner preserves argv, validates process status, bounds output and cancels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-runner-'));
  const file = join(dir, 'fixture');
  const fixture = (body: string) => writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  try {
    fixture(`const r=${JSON.stringify(report())};r.action=process.argv[3];console.log(JSON.stringify(r));`);
    assert.equal((await runBackend(file, 'plan', ['--binary', '/path with spaces'], new AbortController().signal)).ok, true);
    fixture(`console.log(${JSON.stringify(JSON.stringify(report()))});process.exitCode=1;`);
    await assert.rejects(runBackend(file, 'plan', [], new AbortController().signal), /contradicted/);
    fixture(`process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);`);
    await assert.rejects(runBackend(file, 'plan', [], new AbortController().signal), /output_limit/);
    fixture(`setInterval(()=>{},1000);`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(runBackend(file, 'apply', [], controller.signal), /aborted/); }
    finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
