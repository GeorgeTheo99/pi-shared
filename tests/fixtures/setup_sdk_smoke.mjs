// Explicit offline smoke: node tests/fixtures/setup_sdk_smoke.mjs /path/to/pi/dist/bundle/index.js
// Uses a private fake setup backend, no installs, model calls, real permissions, or desktop actions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sdkPath = process.argv[2];
if (!sdkPath) throw new Error('Pass the installed Pi SDK path explicitly');
const sdk = await import(pathToFileURL(path.resolve(sdkPath)).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-sdk-'));
const marker = path.join(dir, 'calls.jsonl');
const backend = path.join(dir, 'backend');
const prior = process.env.PI_SHARED_SETUP_BIN;
let session;
try {
  const report = { schemaVersion:2, component:'peekaboo', action:'plan', ok:true, summary:'Offline fixture only', actions:['Configure MCP'], warnings:[],errors:[],nextSteps:[],planId:'a'.repeat(64),
    evidence:{mode:'bridge',bridgeSocketPath:'/fixture/bridge.sock',bridgeSocketState:'present',permissionSource:null,binaryPath:'/fixture/peekaboo',binaryPresent:true,configuration:'missing',runnable:'not-tested',permissions:{screenRecording:'unknown',accessibility:'unknown',eventSynthesizing:'unknown'},mcp:'not-tested',toolCount:null,desktop:'not-tested'} };
  const capabilityReport = { schemaVersion:1, component:'documents', action:'plan', ok:true, summary:'Offline capability fixture',
    status:'needs-configuration', evidence:[], actions:[], warnings:[], errors:[], nextSteps:[], handoffs:[] };
  fs.writeFileSync(backend, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify(process.argv[2]==='capability'?${JSON.stringify(capabilityReport)}:${JSON.stringify(report)}));\n`, { mode:0o700 });
  process.env.PI_SHARED_SETUP_BIN = backend;
  const settingsManager = sdk.SettingsManager.inMemory({ extensions:[path.join(root,'extensions/setup/index.ts')] });
  const loader = new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors,[]);
  const runtime = await sdk.ModelRuntime.create({authPath:path.join(dir,'auth.json'),modelsPath:path.join(dir,'models.json'),modelsStorePath:path.join(dir,'models-store.json'),allowModelNetwork:false});
  const model = runtime.getModel('openai','gpt-4o'); assert(model);
  ({session}=await sdk.createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager,sessionManager:sdk.SessionManager.inMemory(dir)}));
  const errors=[];
  await session.bindExtensions({onError:error=>errors.push(error)});
  const command=loader.getExtensions().extensions.flatMap(e=>[...e.commands.values()]).find(c=>c.name==='setup');
  assert(command);
  assert.equal(fs.existsSync(marker),false,'loading/startup must not execute setup');
  const notices=[];
  await command.handler('peekaboo',{mode:'print',ui:{notify:text=>notices.push(text)}});
  assert.equal(fs.existsSync(marker),false,'headless invocation must not execute setup');
  sdk.initTheme('dark', false);
  let confirmations=0;
  const ui={
    notify:text=>notices.push(text),
    select:async()=> 'Configure Peekaboo MCP',
    confirm:async()=>{ confirmations++; return false; },
    custom:factory=>new Promise(resolve=>{
      let component;
      const done=value=>{ component?.dispose(); resolve(value); };
      component=factory({requestRender(){}},{fg:(_key,text)=>text},{},done);
    }),
  };
  await command.handler('peekaboo',{mode:'tui',ui,isIdle:()=>true});
  assert.equal(confirmations,1,JSON.stringify(notices));
  assert.deepEqual(fs.readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse),[['peekaboo','plan','--json']]);
  assert.equal(command.getArgumentCompletions('').length,10);
  await command.handler('documents',{mode:'tui',cwd:dir,ui:{...ui,select:async()=> 'Done / cancel'},isIdle:()=>true});
  const calls=fs.readFileSync(marker,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].slice(0,4),['capability','documents','plan','--json']);
  assert.equal(calls[1][calls[1].indexOf('--project')+1],fs.realpathSync(dir));
  assert.ok(notices.some(text=>text.includes('Offline capability fixture')));
  assert.deepEqual(errors,[]);
  console.log('PASS: real SDK registration, 10 capabilities, no startup/headless effects, BorderedLoader, Peekaboo and capability backend plans, no unapproved apply.');
} finally {
  session?.dispose();
  if(prior===undefined) delete process.env.PI_SHARED_SETUP_BIN; else process.env.PI_SHARED_SETUP_BIN=prior;
  fs.rmSync(dir,{recursive:true,force:true});
}
