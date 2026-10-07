import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import setupExtension from '../extensions/setup/index.ts';
import { CAPABILITIES, collectCapabilityOptions, formatCapabilityReport, parseCapabilityReport,
  runCapabilityBackend, runCapabilityWizard, type CapabilityReport, type CapabilityId } from '../extensions/setup/capabilities.ts';

function report(component: CapabilityId = 'documents', action: CapabilityReport['action'] = 'plan'): CapabilityReport {
  return { schemaVersion: 1, component, action, ok: true, summary: 'Fixture only', status: 'needs-configuration',
    evidence: [{ label: 'Dependency', value: 'not installed' }], actions: [], warnings: [], errors: [], nextSteps: [], handoffs: [] };
}
function ui(selections: (string | undefined)[] = [], inputs: (string | undefined)[] = [], approved = false) {
  const notices: string[] = [], menus: string[][] = [], confirmations: string[] = [], drafts: string[] = [];
  return { notices, menus, confirmations, drafts, ctx: {
    isProjectTrusted: () => true,
    ui: { notify: (text: string) => notices.push(text), select: async (_title: string, options: string[]) => { menus.push(options); return selections.shift(); },
      input: async () => inputs.shift(), confirm: async (_title: string, text: string) => { confirmations.push(text); return approved; },
      getEditorText: () => 'unsent draft', setEditorText: (text: string) => drafts.push(text) },
  } as any };
}
const signal = () => new AbortController().signal;
const codeIntel = 'TypeScript/JavaScript code intelligence';
const verify = 'Declare a verification command (do not execute it)';
const initKb = 'Prepare a private metadata layout (no books downloaded)';
const defaultKb = 'Use the configured/default machine-local location';
const apply = 'Review and create the missing configuration';
const check = 'Run explicit prerequisite checks (no installs)';

test('all capability IDs have slash completions and menu entries; no startup provisioning', async () => {
  const commands = new Map<string, any>();
  setupExtension({ on() {}, registerCommand: (id: string, command: any) => commands.set(id, command) } as any);
  const command = commands.get('setup');
  assert.deepEqual(command.getArgumentCompletions('').map((item: any) => item.value), ['peekaboo', ...CAPABILITIES.map(item => item.id)]);
  assert.equal(command.getArgumentCompletions('not-a-capability'), null);
  const mock = ui([undefined]);
  await command.handler('', { ...mock.ctx, mode: 'tui', isIdle: () => true });
  assert.equal(mock.menus[0].length, 11);
  for (const item of CAPABILITIES) assert.ok(mock.menus[0].includes(item.label));
  assert.equal(mock.notices.length, 0);
});

test('strict capability contract rejects wrong identity, oversized, malformed and unsafe handoffs', () => {
  for (const component of CAPABILITIES.map(item => item.id)) {
    assert.equal(parseCapabilityReport(JSON.stringify(report(component)), component, 'plan').component, component);
  }
  const base = report();
  for (const value of [ { ...base, schemaVersion: 2 }, { ...base, component: 'search' }, { ...base, action: 'check' },
    { ...base, evidence: [{ label: 1, value: 'text' }] }, { ...base, status: 'ready' }, { ...base, errors: null },
    { ...base, actions: Array(41).fill('x') }, { ...base, planId: 'a'.repeat(64) },
    ...['/self-handoff', '/login\n/run', '/login\x1b[31m'].map(command => ({ ...base, handoffs: [{ kind: 'pi', label: 'bad', command }] })),
    { ...base, handoffs: [{ kind: 'terminal', label: 'bad', command: 'echo ok\nrm bad' }] },
    { ...base, handoffs: [{ kind: 'unknown', label: 'bad', command: 'echo ok' }] },
  ]) assert.throws(() => parseCapabilityReport(JSON.stringify(value), 'documents', 'plan'), /Unsupported|malformed/);
  assert.throws(() => parseCapabilityReport('old backend usage', 'documents', 'plan'), /newer owning/);
  assert.throws(() => parseCapabilityReport(' '.repeat(65537), 'documents', 'plan'), /size limit/);
  assert.equal(parseCapabilityReport(JSON.stringify({ ...report('knowledge'), planId: 'a'.repeat(64) }), 'knowledge', 'plan').planId, 'a'.repeat(64));
  assert.equal(parseCapabilityReport(JSON.stringify({ ...report('mcp'), planId: 'a'.repeat(64), handoffs: [{kind: 'pi', label: 'Manage MCP', command: '/mcp'}] }), 'mcp', 'plan').planId, 'a'.repeat(64));
});

test('report presentation strips terminal escapes and separates setup from runtime checks', () => {
  const r = report(); r.summary = '\x1b[31mSummary\x1b[0m'; r.evidence[0].value = '\x1b]0;evil\x07present';
  const text = formatCapabilityReport(r);
  assert.ok(!text.includes('\x1b'));
  assert.match(text, /configured|Configured/);
  assert.match(text, /no inference, browser actions, or desktop interaction/);
});

test('search collects file paths not secret values, preserves URL/path as single values', async () => {
  const local = ui(['Local Brave-backed search'], ['/private/key with spaces']);
  assert.deepEqual(await collectCapabilityOptions(local.ctx, 'search', signal()), { mode: 'local', keyFile: '/private/key with spaces' });
  const existing = ui(['Connect an existing compatible search endpoint'], ['https://search.example/mcp', '']);
  assert.deepEqual(await collectCapabilityOptions(existing.ctx, 'search', signal()), { mode: 'existing', url: 'https://search.example/mcp' });
  for (const url of ['https://user:secret@search.example/mcp', 'https://search.example/mcp?key=secret', 'file:///etc/passwd', 'not-a-url']) {
    await assert.rejects(collectCapabilityOptions(ui(['Connect an existing compatible search endpoint'], [url]).ctx, 'search', signal()), /HTTP|absolute/);
  }
  await assert.rejects(collectCapabilityOptions(ui(['Local Brave-backed search'], ['sk-not-a-file']).ctx, 'search', signal()), /absolute/);
});

test('browser, model and private-corpus choices preserve explicit scope', async () => {
  for (const [label, mode] of [['Public browser-worker service', 'public'], ['Local/private app-testing dependencies', 'app']]) {
    assert.deepEqual(await collectCapabilityOptions(ui([label]).ctx, 'browser', signal()), { mode });
  }
  for (const [label, mode] of [['Native providers and subscriptions (/login, /model)', 'native'],
    ['Guided setup, including an existing remote gateway', 'guided'], ['Local model gateway', 'gateway'],
    ['Local oMLX setup guidance (no weight downloads)', 'omlx']]) {
    assert.deepEqual(await collectCapabilityOptions(ui([label]).ctx, 'models', signal()), { mode });
  }
  assert.deepEqual(await collectCapabilityOptions(ui(['Prepare an indexing command for my local books', 'Choose a custom absolute location'], ['/private/my books']).ctx, 'knowledge', signal()), { mode: 'ingest', root: '/private/my books' });
  assert.deepEqual(await collectCapabilityOptions(ui(['Use the existing guided service setup']).ctx, 'search', signal()), { mode: 'guided' });
});

test('all option flows terminate on cancellation without backend invocation', async () => {
  const cases: [CapabilityId, (string | undefined)[], (string | undefined)[]][] = [
    ['search', [undefined], []], ['search', ['Local Brave-backed search'], [undefined]],
    ['search', ['Connect an existing compatible search endpoint'], ['https://search.example/mcp', undefined]],
    ['browser', [undefined], []], ['mcp', [undefined], []], ['development', [undefined], []], ['development', [verify], ['npm', undefined]],
    ['development', [verify], ['npm', '[]', undefined]], ['knowledge', [undefined], []], ['knowledge', [initKb, undefined], []],
    ['knowledge', [initKb, 'Choose a custom absolute location'], [undefined]], ['models', [undefined], []],
  ];
  for (const [id, selections, inputs] of cases) {
    let calls = 0;
    await runCapabilityWizard(ui(selections, inputs).ctx, id, async action => { calls++; return report(id, action); });
    assert.equal(calls, 0, id);
  }
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await collectCapabilityOptions(ui().ctx, 'documents', aborted.signal), undefined);
});

test('development requires project trust and explicit verification argv/source paths', async () => {
  const mock = ui([verify], ['npm', '["run","typecheck"]', '["src","package.json"]']);
  assert.deepEqual(await collectCapabilityOptions(mock.ctx, 'development', signal()), {
    mode: 'verification', command: 'npm', args: ['run', 'typecheck'], inputs: ['src', 'package.json'],
  });
  const untrusted = ui([codeIntel]); untrusted.ctx.isProjectTrusted = () => false;
  await assert.rejects(collectCapabilityOptions(untrusted.ctx, 'development', signal()), /project trust/);
  for (const args of ['echo command', '{}', '[1]', '["line\\nbreak"]']) {
    await assert.rejects(collectCapabilityOptions(ui([verify], ['node', args, '["src"]']).ctx, 'development', signal()), /JSON array/);
  }
  await assert.rejects(collectCapabilityOptions(ui([verify], ['node', '[]', '[]']).ctx, 'development', signal()), /nonempty/);
});

test('safe scaffold uses the exact approval digest and never auto-checks', async () => {
  for (const id of ['development', 'knowledge'] as const) {
    const mock = ui(id === 'development' ? [codeIntel, apply] : [initKb, defaultKb, apply], [], true);
    const calls: any[] = [];
    await runCapabilityWizard(mock.ctx, id, async (action, options, extra) => {
      calls.push([action, options, extra]); return { ...report(id, action), planId: 'b'.repeat(64), actions: ['Create missing config'] };
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], 'apply');
    assert.deepEqual(calls[1][2], ['--yes', '--expected-plan', 'b'.repeat(64)]);
    assert.deepEqual(calls[0][1], calls[1][1]);
    assert.match(mock.confirmations[0], /Existing files will not be overwritten/);
    assert.match(mock.confirmations[0], /no project or verification trust is granted/);
  }
});

test('MCP migration requires exact approval and describes settings changes and restart', async () => {
  for (const approved of [true, false]) {
    const mock = ui(['Preview migration from the existing MCP adapter', 'Review and migrate this profile to official MCP'], [], approved);
    const calls: any[] = [];
    await runCapabilityWizard(mock.ctx, 'mcp', async (action, options, extra) => {
      calls.push([action, options, extra]); return {...report('mcp', action), planId: 'c'.repeat(64)};
    });
    assert.equal(calls.length, approved ? 2 : 1);
    assert.deepEqual(calls[0][1], {mode: 'migrate'});
    if (approved) assert.deepEqual(calls[1], ['apply', {mode: 'migrate'}, ['--yes', '--expected-plan', 'c'.repeat(64)]]);
    assert.match(mock.confirmations[0], /narrowly updates this profile/);
    assert.match(mock.confirmations[0], /private backups/);
    assert.match(mock.confirmations[0], /restart this profile/);
  }
  const calls: any[] = [];
  await runCapabilityWizard(ui(['Preview migration from the existing MCP adapter', check]).ctx, 'mcp', async (action, options) => {
    calls.push([action, options]); return report('mcp', action);
  });
  assert.deepEqual(calls, [['plan', {mode: 'migrate'}], ['check', {}]]);
});

test('declined approval, shutdown and lost project trust cannot create files', async () => {
  for (const variant of ['declined', 'aborted', 'trust-changed']) {
    const controller = new AbortController(); const mock = ui([codeIntel, apply]); let calls = 0;
    mock.ctx.ui.confirm = async () => {
      if (variant === 'aborted') controller.abort();
      if (variant === 'trust-changed') mock.ctx.isProjectTrusted = () => false;
      return variant !== 'declined';
    };
    const operation = runCapabilityWizard(mock.ctx, 'development', async action => { calls++; return { ...report('development', action), planId: 'a'.repeat(64) }; }, controller.signal);
    if (variant === 'trust-changed') await assert.rejects(operation, /trust changed/); else await operation;
    assert.equal(calls, 1);
  }
});

test('failed plans cannot offer apply, checks remain explicit and bounded by runner', async () => {
  const mock = ui([initKb, defaultKb, check]); const calls: string[] = [];
  await runCapabilityWizard(mock.ctx, 'knowledge', async action => { calls.push(action); return { ...report('knowledge', action), ok: false, planId: 'a'.repeat(64) }; });
  assert.deepEqual(calls, ['plan', 'check']);
  assert.ok(!mock.menus.at(-1)!.includes(apply));
});

test('terminal handoffs never execute or enter the Pi shell, Pi handoffs need explicit draft approval', async () => {
  const command = "pi-shared setup --with-browser";
  const terminal = ui(['1. Show terminal command: Provision browser']); let calls = 0;
  await runCapabilityWizard(terminal.ctx, 'documents', async action => { calls++; return { ...report('documents', action), handoffs: [{ label: 'Provision browser', command, kind: 'terminal' }] }; });
  assert.equal(calls, 1); assert.deepEqual(terminal.drafts, []);
  assert.ok(terminal.notices.some(text => text.includes(command) && text.includes('Nothing was executed')));
  for (const approved of [true, false]) {
    const mock = ui(['Inspect official MCP configuration', '1. Prepare Pi command: Onboard MCP'], [], approved);
    await runCapabilityWizard(mock.ctx, 'mcp', async action => ({ ...report('mcp', action), handoffs: [{ label: 'Onboard MCP', command: '/mcp', kind: 'pi' }] }));
    assert.deepEqual(mock.drafts, approved ? ['/mcp'] : []);
    assert.match(mock.confirmations[0], /replaces your current editor draft/);
  }
});

test('capability runner keeps context/options in exact argv and handles old backends, errors, cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-cap-runner-'));
  const backend = join(dir, 'backend');
  const context = { project: '/project with spaces', agentDir: '/profile with spaces', sharedRoot: '/shared', nodeExecutable: process.execPath };
  const fixture = (body: string) => writeFileSync(backend, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  try {
    fixture(`const r=${JSON.stringify(report('search'))};r.evidence=[{label:'argv',value:JSON.stringify(process.argv.slice(2))}];console.log(JSON.stringify(r));`);
    const result = await runCapabilityBackend(backend, 'search', 'plan', { mode: 'local', keyFile: '/private/a b' }, context, signal());
    assert.deepEqual(JSON.parse(result.evidence[0].value), ['capability', 'search', 'plan', '--json', '--project', context.project,
      '--agent-dir', context.agentDir, '--shared-root', context.sharedRoot, '--node-executable', process.execPath, '--options', '{"mode":"local","keyFile":"/private/a b"}']);
    fixture(`console.log(${JSON.stringify(JSON.stringify(report('search')))});process.exitCode=1;`);
    await assert.rejects(runCapabilityBackend(backend, 'search', 'plan', {}, context, signal()), /contradicted/);
    fixture(`console.log('Unknown command: capability');process.exitCode=2;`);
    await assert.rejects(runCapabilityBackend(backend, 'search', 'plan', {}, context, signal()), /newer owning/);
    await assert.rejects(runCapabilityBackend(backend, 'search', 'plan', {}, { ...context, project: 'relative' }, signal()), /absolute/);
    fixture(`process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);`);
    await assert.rejects(runCapabilityBackend(backend, 'search', 'plan', {}, context, signal()), /output_limit/);
    fixture(`setInterval(()=>{},1000);`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(runCapabilityBackend(backend, 'search', 'check', {}, context, controller.signal), /aborted/); }
    finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
