import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../extensions/integration-bundles/index.ts';

const routers = ['enterprise_load_bundle', 'enterprise_unload_bundle', 'enterprise_list_bundles'];
async function harness(t: any, bundles: any, defaults: any = {}, names = ['read', 'bash', 'a', 'b', 'c'], initial = [...names, ...routers]) {
  const dir = mkdtempSync(join(tmpdir(), 'integration-bundles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'master.yaml');
  writeFileSync(file, JSON.stringify({ version: 1, bundles, defaults }));
  const previous = process.env.PI_INTEGRATION_LIST;
  process.env.PI_INTEGRATION_LIST = file;
  const tools = new Map<string, any>(names.map(name => [name, { name, description: `Description of ${name}` }]));
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let active = [...initial];
  const writes: string[][] = [];
  const notifications: string[] = [];
  const ctx = { model: { id: 'test', provider: 'fixture' }, ui: { notify: (s: string) => notifications.push(s) } };
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => { active = [...new Set(next)].filter(n => tools.has(n)); writes.push(active); },
  };
  try { extension(pi); } finally {
    if (previous === undefined) delete process.env.PI_INTEGRATION_LIST; else process.env.PI_INTEGRATION_LIST = previous;
  }
  await handlers.get('session_start')?.({}, ctx);
  return {
    tools, pi, writes, notifications,
    active: () => active,
    manual: (next: string[]) => { active = next; },
    call: (name: string, params: any = {}) => tools.get(name).execute('id', params, undefined, undefined, ctx),
    load: (name: string) => tools.get(routers[0]).execute('id', { name }),
    unload: (name: string) => tools.get(routers[1]).execute('id', { name }),
    prompt: (prompt = '') => handlers.get('before_agent_start')?.({ prompt, systemPrompt: 'base' }, ctx),
    model: async (id: string) => { ctx.model.id = id; await handlers.get('model_select')?.({ model: ctx.model }, ctx); },
    command: (args: string) => commands.get('bundles').handler(args, ctx),
  };
}
const bundle = (tools: string[], extra = {}) => ({ description: 'Test capability', tools, ...extra });
const cap = (max_tools: number) => ({ model_overrides: { '*': { max_tools } } });

test('characterization: non-default hiding, load/unload/reload and enterprise router names', async t => {
  const h = await harness(t, { alpha: bundle(['a']) });
  assert(!h.active().includes('a'));
  await h.load('alpha'); assert(h.active().includes('a'));
  await h.unload('alpha'); assert(!h.active().includes('a'));
  await h.load('alpha'); assert(h.active().includes('a'));
  assert(routers.every(n => h.active().includes(n)));
});

test('initial exclusions apply to builtins, bundles and routers', async t => {
  const h = await harness(t, { alpha: bundle(['a']) }, {}, ['read', 'bash', 'a'], ['read']);
  assert(!h.active().includes('bash'));
  assert(!h.active().includes(routers[0]));
  await assert.rejects(h.load('alpha'), /excluded|unavailable/i);
  await h.model('other'); assert(!h.active().includes(routers[0]));
});

test('overlap eviction uses actual unique union including router overlaps', async t => {
  const h = await harness(t, { first: bundle(['a', 'b', routers[0]]), second: bundle(['b', 'c']), third: bundle(['d', 'e']) }, cap(7), ['read', 'a', 'b', 'c', 'd', 'e']);
  await h.load('first'); await h.load('second'); await h.load('third');
  assert(h.active().length <= 7);
  assert(h.active().includes('d') && h.active().includes('e'));
});

test('oversized request fails without evicting existing load', async t => {
  const h = await harness(t, { small: bundle(['a']), large: bundle(['b', 'c']) }, cap(5), ['read', 'a', 'b', 'c']);
  await h.load('small'); const before = h.active();
  await assert.rejects(h.load('large'), /budget|cap/i);
  assert.deepEqual(h.active(), before);
});

test('unavailable bundle never reports successful load', async t => {
  const h = await harness(t, { absent: bundle(['missing']), partial: bundle(['a', 'missing']) });
  await assert.rejects(h.load('absent'), /unavailable|registered/i);
  await assert.rejects(h.load('partial'), /unavailable|registered/i);
});

test('repeated loads refresh load-recency', async t => {
  const h = await harness(t, { alpha: bundle(['a']), beta: bundle(['b']), gamma: bundle(['c']) }, cap(6), ['read', 'a', 'b', 'c']);
  await h.load('alpha'); await h.load('beta'); await h.load('alpha'); await h.load('gamma');
  assert(h.active().includes('a')); assert(!h.active().includes('b'));
});

test('impossible pinned/base budget is explicit and preserves base selections', async t => {
  const h = await harness(t, { alpha: bundle(['a']) }, cap(2), ['read', 'bash', 'a']);
  const result = await h.call(routers[2]);
  assert.match(JSON.stringify(result), /budget.*(exceed|impossible)|pinned.*cap/i);
  assert(h.active().includes('read') && h.active().includes('bash'));
  await assert.rejects(h.load('alpha'), /budget|cap/i);
});

test('manual changes are preserved; ambiguous previously hidden tools fail closed', async t => {
  const h = await harness(t, { alpha: bundle(['a']), beta: bundle(['b']) });
  await h.load('alpha');
  h.manual([...h.active().filter(n => n !== 'bash'), 'b']);
  await h.prompt();
  assert(!h.active().includes('bash')); assert(h.active().includes('b'));
  await h.unload('beta'); assert(h.active().includes('b'), 'explicit manual addition stays pinned');
  h.manual(h.active().filter(n => n !== 'a'));
  await h.model('different');
  await assert.rejects(h.load('alpha'), /excluded/i);
  assert(!h.active().includes('a'));
});

test('external base selection revokes hidden eligibility; explicit re-enable permits it', async t => {
  const h = await harness(t, { alpha: bundle(['a']) });
  h.manual(h.active().filter(n => n !== 'bash'));
  await h.prompt();
  await assert.rejects(h.load('alpha'), /excluded/i);
  h.manual([...h.active(), 'a']);
  await h.load('alpha'); assert(h.active().includes('a'));
});

test('late registration, excluded late tools, same-count name replacements and removals', async t => {
  const h = await harness(t, { late: bundle(['late_*']) }, {}, ['read']);
  h.tools.set('late_one', { name: 'late_one', description: 'late' });
  h.manual([...h.active(), 'late_one']); // SDK auto-activates new allowed registrations.
  await h.prompt(); assert(!h.active().includes('late_one'));
  await h.load('late'); assert(h.active().includes('late_one'));
  h.tools.delete('late_one'); h.manual(h.active().filter(n => n !== 'late_one'));
  h.tools.set('late_two', { name: 'late_two', description: 'late replacement' });
  await assert.rejects(h.load('late'), /excluded/i);
  h.manual([...h.active(), 'late_two']);
  await h.load('late'); assert(h.active().includes('late_two'));
  h.tools.delete('late_two'); h.manual(h.active().filter(n => n !== 'late_two'));
  await assert.rejects(h.load('late'), /unavailable/i);
  const row = (await h.call(routers[2], { query: 'late' })).details.results.find((r: any) => r.kind === 'bundle');
  assert.equal(row.loaded, false); assert.equal(row.available, false);
});

test('model change applies specific defaults and caps without re-enabling excluded tools', async t => {
  const h = await harness(t, { alpha: bundle(['a']), beta: bundle(['b']) }, {
    model_always_load: { 'wide-*': ['alpha', 'beta'], 'wide-small*': ['alpha'] },
    model_overrides: { '*': { max_tools: 5 }, 'wide-*': { max_tools: null } },
  }, ['read', 'bash', 'a', 'b'], ['read', 'a', 'b', ...routers]);
  await h.model('wide-full'); assert(h.active().includes('a') && h.active().includes('b'));
  await h.model('wide-small-model'); assert(h.active().includes('a') && !h.active().includes('b'));
  await h.model('test'); assert(h.active().length <= 5); assert(!h.active().includes('bash'));
});

test('always-load and custom router overlaps are pinned and counted uniquely', async t => {
  const h = await harness(t, { alpha: bundle(['a', 'extra_router']), beta: bundle(['b']) }, {
    ...cap(6), always_load: ['alpha'], router_tools: ['extra_router'],
  }, ['read', 'a', 'b', 'extra_router']);
  assert.equal(h.active().length, 6);
  await assert.rejects(h.unload('alpha'), /pinned/i);
  await assert.rejects(h.load('beta'), /budget/i);
  assert.equal(h.active().length, 6);
});

test('trigger notes do not claim evicted or unavailable bundles loaded', async t => {
  const h = await harness(t, { alpha: bundle(['a'], { triggers: ['load'] }), beta: bundle(['b'], { triggers: ['load'] }), absent: bundle(['missing'], { triggers: ['load'] }) }, cap(5), ['read', 'a', 'b']);
  const result = await h.prompt('load');
  assert.match(result.systemPrompt, /auto-loaded by trigger: beta/);
  assert(!result.systemPrompt.includes('auto-loaded by trigger: alpha'));
  assert(!h.active().includes('a')); assert(h.active().includes('b'));
});

test('command load failure does not notify success; reset preserves exclusions', async t => {
  const h = await harness(t, { alpha: bundle(['a', 'b']) }, cap(5), ['read', 'a', 'b', 'bash'], ['read', 'a', 'b', ...routers]);
  await h.command('load alpha'); assert.match(h.notifications.at(-1)!, /cannot fit/i);
  await h.command('reset'); assert(!h.active().includes('bash'));
});

test('bounded literal name/description/group discovery is read-only', async t => {
  const names = ['read', 'command_job', 'verify', ...Array.from({ length: 100 }, (_, i) => `test_${i}`)];
  const h = await harness(t, { quality: bundle(['verify']) }, {}, names);
  h.tools.get('verify').description = 'Parse JUnit evidence';
  const before = h.writes.length;
  let result = await h.call(routers[2], { query: 'junit' });
  assert.equal(result.details.results[0].name, 'verify');
  assert.equal(result.details.results[0].active, false);
  result = await h.call(routers[2], { group: 'development' });
  assert(result.details.results.some((r: any) => r.name === 'command_job'));
  result = await h.call(routers[2], { query: 'test_', limit: 5 });
  assert.equal(result.details.returned, 5); assert.equal(result.details.total, 100); assert.equal(result.details.nextOffset, 5);
  const page = await h.call(routers[2], { query: 'test_', limit: 5, offset: 5 });
  assert(!page.details.results.some((r: any) => result.details.results.some((s: any) => r.name === s.name)));
  assert.equal((await h.call(routers[2], { query: '.*' })).details.total, 0);
  await assert.rejects(h.call(routers[2], { limit: 51 }), /limit/);
  await assert.rejects(h.call(routers[2], { query: 'x'.repeat(201) }), /200/);
  assert.equal(h.writes.length, before);
});

test('pinned bundle overflow is explicit, and late pinned registration is picked up', async t => {
  const h = await harness(t, { pinned: bundle(['a', 'b']), late: bundle(['late']) }, { ...cap(5), always_load: ['pinned', 'late'] }, ['read', 'a', 'b']);
  assert(h.active().includes('a') && h.active().includes('b'));
  assert.match((await h.call(routers[2])).details.budgetError, /pinned\/base.*exceed/i);
  h.tools.set('late', { name: 'late', description: 'Late pinned registration' });
  h.manual([...h.active(), 'late']);
  await h.prompt();
  const row = (await h.call(routers[2], { query: 'late' })).details.results.find((r: any) => r.kind === 'bundle');
  assert.equal(row.loaded, true);
});

test('observed SDK refusal cannot produce a successful load result', async t => {
  const h = await harness(t, { alpha: bundle(['a']) });
  const apply = h.pi.setActiveTools;
  h.pi.setActiveTools = (names: string[]) => apply(names.filter(n => n !== 'a'));
  await assert.rejects(h.load('alpha'), /unavailable/i);
});

test('large UTF-8 descriptions and memberships have bounded discovery output', async t => {
  const h = await harness(t, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`group_${i}`, bundle(['a'])])));
  for (const tool of h.tools.values()) tool.description = '🐱'.repeat(10000);
  const result = await h.call(routers[2], { query: '🐱', limit: 50 });
  assert(result.details.results.every((r: any) => r.description.length <= 300 && (r.groups?.length ?? 0) <= 20));
  assert(Buffer.byteLength(JSON.stringify(result.details.results)) < 16500);
  assert.equal(result.details.fieldsBounded, true);
});

test('no master is discovery-only and neither load nor unload claims success', async t => {
  const h = await harness(t, null);
  const before = h.active();
  const result = await h.call(routers[2]);
  assert.equal(result.details.activationManaged, false);
  assert.match(result.details.message, /No master.*disabled/);
  await assert.rejects(h.load('alpha'), /No master/);
  await assert.rejects(h.unload('alpha'), /No master/);
  assert.deepEqual(h.active(), before); assert.equal(h.writes.length, 0);
});
