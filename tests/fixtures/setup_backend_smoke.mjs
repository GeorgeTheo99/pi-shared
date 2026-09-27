// Explicit cross-repository smoke: node tests/fixtures/setup_backend_smoke.mjs /trusted/pi-setup/bin/pi-shared [/trusted/python3]
// Optional interpreter models the owning Homebrew wrapper, without relying on source shebang PATH.
// Only synthetic metadata and disposable project/profile/HOME paths. No installs, real credentials or private books.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITIES, runCapabilityBackend } from '../../extensions/setup/capabilities.ts';
let backend = fs.realpathSync(process.argv[2]);
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-integration-')));
const prior = { HOME: process.env.HOME, PI_SOFTWARE_KB_ROOT: process.env.PI_SOFTWARE_KB_ROOT };
try {
  if (process.argv[3]) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const wrapper = path.join(dir, 'owning-cli');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(fs.realpathSync(process.argv[3]))} ${quote(backend)} "$@"\n`, { mode:0o700 });
    backend = wrapper;
  }
  const home = path.join(dir, 'home');
  const context = { project: path.join(dir, 'project'), agentDir: path.join(dir, 'profile'), sharedRoot: path.join(dir, 'shared'), nodeExecutable: fs.realpathSync(process.execPath) };
  for (const p of [home, context.project, context.agentDir, context.sharedRoot]) fs.mkdirSync(p, { mode: 0o700 });
  process.env.HOME = home;
  delete process.env.PI_SOFTWARE_KB_ROOT;
  const write = (relative, data) => { const p = path.join(context.sharedRoot, relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  write('knowledge/software-engineering/sources.json', '{"sources":[]}\n');
  write('knowledge/software-engineering/documents.json', '{"documents":[]}\n');
  write('knowledge/software-engineering/corpus/source-cards.md', '# Synthetic public metadata\n');
  const packages = { '': { dependencies: { typescript:'5.9.3', 'typescript-language-server':'5.0.0' } } };
  for (const [name, version, cli] of [['typescript','5.9.3','tsserver.js'],['typescript-language-server','5.0.0','cli.mjs']]) {
    packages[`node_modules/${name}`] = { version };
    write(`extensions/code-intel/node_modules/${name}/package.json`, JSON.stringify({ version }));
    write(`extensions/code-intel/node_modules/${name}/lib/${cli}`, 'throw new Error("must not run");\n');
  }
  write('extensions/code-intel/package-lock.json', JSON.stringify({ packages }));
  fs.mkdirSync(path.join(context.project, 'src'));
  fs.writeFileSync(path.join(context.project, 'src/example.ts'), 'export const fixture = true;\n');
  const run = (id, action, options = {}, extra = []) => runCapabilityBackend(backend, id, action, options, context, new AbortController().signal, extra);
  for (const { id } of CAPABILITIES) {
    const report = await run(id, 'plan');
    assert.equal(report.ok, true, `${id}: ${JSON.stringify(report.errors)}`);
    assert.equal(fs.existsSync(path.join(context.project, '.pi')), false, 'plans never write');
  }
  const code = await run('development', 'plan');
  assert.ok(code.evidence.some(row => row.label.startsWith('Proposed JSON') && row.value.includes('typescript-language-server')));
  const applied = await run('development', 'apply', {}, ['--yes', '--expected-plan', code.planId]);
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  const config = JSON.parse(fs.readFileSync(path.join(context.project, '.pi/code-intel.json')));
  assert.equal(config.executable, context.nodeExecutable);
  const again = await run('development', 'apply', {}, ['--yes', '--expected-plan', code.planId]);
  assert.equal(again.ok, false, 'existing configuration cannot be overwritten');
  const options = { mode: 'verification', command: 'node', args: ['--version'], inputs: ['src'] };
  const verification = await run('development', 'plan', options);
  assert.equal((await run('development', 'apply', options, ['--yes', '--expected-plan', verification.planId])).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(context.project, '.pi/verification.json'))).checks[0].report.format, 'exit');
  const kb = await run('knowledge', 'plan');
  assert.equal((await run('knowledge', 'apply', {}, ['--yes', '--expected-plan', kb.planId])).ok, true);
  const kbRoot = path.join(home, '.pi/knowledge/software-engineering');
  assert.equal(fs.statSync(kbRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(kbRoot, 'sources.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(kbRoot, 'private/index.json')), false);
  assert.equal(fs.existsSync(path.join(context.agentDir, 'trust.json')), false);
  for (const [id, options] of [['search', { mode:'local', keyFile:path.join(home, 'private key') }],
    ['search', { mode:'existing', url:'https://search.example/mcp' }], ['browser', { mode:'app' }],
    ['models', { mode:'gateway' }], ['models', { mode:'omlx' }], ['knowledge', { mode:'ingest' }]]) {
    assert.equal((await run(id, 'plan', options)).ok, true, id);
  }
  console.log('PASS: actual CLI/frontend contract for all nine entries; approved code-intel, verification and private metadata scaffolds; no overwrite/trust/indexing; literal handoffs only.');
} finally {
  for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(dir, { recursive:true, force:true });
}
