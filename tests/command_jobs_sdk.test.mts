import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

function installedSdk(): string | undefined {
	try {
		let dir = process.env.PI_INSTALL_DIR || path.dirname(fs.realpathSync(execFileSync("which",["pi"],{encoding:"utf8",timeout:2000}).trim()));
		for (let i=0;i<6;i++) {
			const manifest=path.join(dir,"package.json");
			if (fs.existsSync(manifest)) {
				const p=JSON.parse(fs.readFileSync(manifest,"utf8"));
				if (["@earendil-works/pi-coding-agent","@mariozechner/pi-coding-agent"].includes(p.name)) return path.join(dir,p.main||"dist/index.js");
			}
			dir=path.dirname(dir);
		}
	} catch {}
}

test("installed Pi finalizes failed waits/subagents as errors, and safe_edit uses actual SDK APIs", { timeout: 30000 }, async t => {
	const sdkPath=installedSdk();
	if (!sdkPath) { t.skip("Installed Pi SDK unavailable; set PI_INSTALL_DIR to run compatibility smoke"); return; }
	const sdk=await import(pathToFileURL(sdkPath).href);
	function dependency(name:string) {
		let parent=path.dirname(sdkPath!);
		for(let i=0;i<8;i++) {
			const root=path.join(parent,"node_modules",name), file=path.join(root,"package.json");
			if(fs.existsSync(file)) { const p=JSON.parse(fs.readFileSync(file,"utf8")); return pathToFileURL(path.join(root,p.exports?.["."]?.import||p.main)).href; }
			parent=path.dirname(parent);
		}
		throw new Error(`Installed SDK dependency missing: ${name}`);
	}
	const ai=await import(dependency("@earendil-works/pi-ai"));
	const core=await import(dependency("@earendil-works/pi-agent-core"));
	const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"pi-command-sdk-")));
	const agentDir=path.join(dir,"profile"); fs.mkdirSync(agentDir);
	const envNames=["PI_COMMAND_STATE_DIR","PI_SUBAGENT_STATE_DIR","PI_SUBAGENT_DEPTH","PI_SUBAGENT_MAX_DEPTH"];
	const previousEnv=new Map(envNames.map(name=>[name,process.env[name]]));
	process.env.PI_COMMAND_STATE_DIR=path.join(dir,"jobs");
	process.env.PI_SUBAGENT_STATE_DIR=path.join(dir,"subagents");
	process.env.PI_SUBAGENT_DEPTH="0"; process.env.PI_SUBAGENT_MAX_DEPTH="1";
	// This fixture performs only validation failures, never child/model execution.
	const ctx={cwd:dir,isProjectTrusted:()=>true};
	let extensions: any[]=[];
	t.after(async()=>{
		for (const e of extensions) for (const handler of e.handlers.get("session_shutdown")||[]) await handler({reason:"quit"},ctx);
		for(const [name,value] of previousEnv) { if(value===undefined) delete process.env[name]; else process.env[name]=value; }
		fs.rmSync(dir,{recursive:true,force:true});
	});
	fs.writeFileSync(path.join(agentDir,"settings.json"),JSON.stringify({packages:[],extensions:["command-jobs","wait-for","safe-edit","spawn-subagent"].map(n=>path.resolve("extensions",n,"index.ts"))}));
	const settingsManager=sdk.SettingsManager.create(dir,agentDir,{projectTrusted:false});
	const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir,settingsManager,noContextFiles:true});
	await loader.reload(); const loaded=loader.getExtensions();
	assert.deepEqual(loaded.errors,[]); extensions=loaded.extensions;
	const definitions=new Map<string,any>(); for(const e of extensions) for(const [name,tool] of e.tools) definitions.set(name,tool.definition);
	const invoke=(name:string,args:any)=>definitions.get(name).execute("fixture",args,undefined,undefined,ctx);
	assert.ok(definitions.get("wait_for"));
	const model={id:"fixture",name:"fixture",provider:"test",api:"openai-responses",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1024};
	async function finalized(args:any,toolName="wait_for") {
		const definition=definitions.get(toolName); assert.ok(definition);
		const tool={...definition,execute:(id:any,input:any,signal:any,update:any)=>definition.execute(id,input,signal,update,ctx)};
		const streamFn=()=>{
			const stream=new ai.AssistantMessageEventStream();
			const message={role:"assistant",content:[{type:"toolCall",id:"fixture_call",name:toolName,arguments:args}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:Date.now()};
			stream.push({type:"done",reason:"toolUse",message}); return stream;
		};
		const messages=await core.runAgentLoop([{role:"user",content:"local fixture",timestamp:Date.now()}],{systemPrompt:"test",messages:[],tools:[tool]}, {model,convertToLlm:(m:any)=>m,shouldStopAfterTurn:()=>true},()=>{},undefined,streamFn);
		return messages.find((m:any)=>m.role==="toolResult");
	}
	const missing=await finalized({jobs:["cmd_00000000-0000-0000-0000-000000000000"],timeout:2});
	assert.equal(missing?.isError,true); assert.match(missing.content[0].text,/Unknown/);
	const failed=await invoke("command_job",{action:"start",command:process.execPath,args:["-e","process.exit(7)"],timeout_seconds:2});
	await invoke("wait_for",{jobs:[failed.details.id],timeout:3,poll_interval:1});
	assert.equal((await finalized({jobs:[failed.details.id],job_mode:"any_success",timeout:2}))?.isError,true);
	assert.equal((await finalized({jobs:[failed.details.id],readiness:true,timeout:2}))?.isError,true);
	assert.equal((await finalized({condition:"sleep 3",timeout:1}))?.isError,true);
	const rejectedWorktree=await finalized({agent:"reviewer",task:"fixture",isolation:"worktree"},"spawn_subagent");
	assert.equal(rejectedWorktree?.isError,true);
	const failedWorktree=await finalized({agent:"worker",task:"fixture",isolation:"worktree",baseRevision:"missing-fixture"},"spawn_subagent");
	assert.equal(failedWorktree?.isError,true); // Non-Git disposable cwd fails before any child/model execution.
	const invalidNormal=await finalized({agent:"worker"},"spawn_subagent");
	assert.equal(invalidNormal?.isError,true);
	fs.writeFileSync(path.join(dir,"text.txt"),"before\n");
	const preview=await invoke("safe_edit",{action:"preview",path:"text.txt",edits:[{oldText:"before",newText:"after"}]});
	assert.match(preview.details.patch,/-before/);
	const applied=await invoke("safe_edit",{action:"apply",preview_id:preview.details.preview_id,expected_sha256:preview.details.expected_sha256});
	assert.equal(applied.details.applied,true); assert.equal(fs.readFileSync(path.join(dir,"text.txt"),"utf8"),"after\n");
});
