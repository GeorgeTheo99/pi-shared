import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SafeEditState, replaceExactly, digest, type MutationQueue } from "../extensions/safe-edit/state.ts";

test("FIFO without a writer is rejected without blocking", {skip:process.platform==='win32'}, async t=>{
	const f=await setup(t);
	execFileSync('mkfifo',[path.join(f.dir,'pipe')]);
	const moduleUrl=pathToFileURL(path.resolve('extensions/safe-edit/state.ts')).href;
	const code=`import {SafeEditState} from ${JSON.stringify(moduleUrl)}; try {await new SafeEditState().preview(${JSON.stringify(f.dir)},'pipe',[{oldText:'x',newText:'y'}]);process.exitCode=1;} catch(e) {if(!/regular/.test(e.message))throw e;console.log('rejected');}`;
	assert.match(execFileSync(process.execPath,['--no-warnings','--input-type=module','-e',code],{encoding:'utf8',timeout:2000}),/rejected/);
});

const queue: MutationQueue = async (_file, op) => op();
async function setup(t: any, content = "alpha\r\nbeta\r\n") {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-safe-edit-test-")));
	const file = path.join(dir, "code.txt"); await fs.writeFile(file, content, { mode: 0o640 });
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return { dir, file, state: new SafeEditState() };
}
test("exact replacements target original disjoint spans; ambiguous/fuzzy/overlapping edits fail", () => {
	assert.equal(replaceExactly("abc def", [{oldText:"abc",newText:"def"},{oldText:"def",newText:"xyz"}]), "def xyz");
	assert.throws(() => replaceExactly("abc abc", [{oldText:"abc",newText:"d"}]), /exactly once/);
	assert.throws(() => replaceExactly("abc ", [{oldText:"abc\t",newText:"d"}]), /exactly once/);
	assert.throws(() => replaceExactly("abc def", [{oldText:"abc",newText:"d"},{oldText:"bc d",newText:"e"}]), /overlap/);
	assert.throws(() => replaceExactly("abc", [{oldText:"",newText:"d"}]), /Invalid/);
});
test("preview is read-only; apply preserves exact line endings/BOM and permissions", async t => {
	const f = await setup(t, "\ufeffalpha\r\nbeta\r\n");
	const original = await fs.readFile(f.file);
	const p = await f.state.preview(f.dir, "code.txt", [{oldText:"alpha",newText:"日本語"}]);
	assert.deepEqual(await fs.readFile(f.file), original);
	const result = await f.state.apply(f.dir, p.id, p.hash, queue);
	assert.equal(result.applied, true);
	assert.equal(await fs.readFile(f.file,"utf8"), "\ufeff日本語\r\nbeta\r\n");
	assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
	assert.equal(result.sha256, digest(await fs.readFile(f.file)));
	assert.deepEqual(await fs.readdir(f.dir), ["code.txt"]);
	await assert.rejects(f.state.apply(f.dir,p.id,p.hash,queue),/Unknown/);
});
test("stale content, permissions, expected hash, and changed inode reject without writes", async t => {
	const f = await setup(t);
	await assert.rejects(f.state.preview(f.dir,"code.txt",[{oldText:"alpha",newText:"A"}],"0".repeat(64)),/Stale/);
	const p = await f.state.preview(f.dir,"code.txt",[{oldText:"alpha",newText:"A"}]);
	await assert.rejects(f.state.apply(f.dir,p.id,"0".repeat(64),queue),/SHA-256/);
	await fs.writeFile(f.file,"changed");
	await assert.rejects(f.state.apply(f.dir,p.id,p.hash,queue),/Stale/);
	assert.equal(await fs.readFile(f.file,"utf8"),"changed");
	const next = await f.state.preview(f.dir,"code.txt",[{oldText:"changed",newText:"A"}]);
	await fs.chmod(f.file,0o600);
	await assert.rejects(f.state.apply(f.dir,next.id,next.hash,queue),/Stale/);
});
test("symlink aliases, workspace escapes, hardlinks and binary inputs", async t => {
	const f = await setup(t);
	await fs.symlink("code.txt",path.join(f.dir,"alias"));
	const p=await f.state.preview(f.dir,"alias",[{oldText:"alpha",newText:"A"}]);
	await fs.writeFile(path.join(f.dir,"other.txt"),"alpha");
	await fs.unlink(path.join(f.dir,"alias")); await fs.symlink("other.txt",path.join(f.dir,"alias"));
	await assert.rejects(f.state.apply(f.dir,p.id,p.hash,queue),/symlink/);
	await fs.symlink(os.tmpdir(),path.join(f.dir,"outside"));
	await assert.rejects(f.state.preview(f.dir,"outside",[{oldText:"a",newText:"b"}]),/workspace/);
	await fs.link(f.file,path.join(f.dir,"hard"));
	await assert.rejects(f.state.preview(f.dir,"code.txt",[{oldText:"alpha",newText:"A"}]),/single-link/);
	await fs.writeFile(path.join(f.dir,"binary"),Buffer.from([255,1,0]));
	await assert.rejects(f.state.preview(f.dir,"binary",[{oldText:"a",newText:"b"}]),/binary/);
});
test("queue-bound late checks catch cooperating edits; abort and expiry do not write", async t => {
	const f=await setup(t);
	const p=await f.state.preview(f.dir,"code.txt",[{oldText:"alpha",newText:"A"}]);
	const otherWriter: MutationQueue = async (_file,op) => { await fs.writeFile(f.file,"external"); return op(); };
	await assert.rejects(f.state.apply(f.dir,p.id,p.hash,otherWriter),/Stale/);
	const next=await f.state.preview(f.dir,"code.txt",[{oldText:"external",newText:"A"}]);
	const abort=new AbortController(); abort.abort();
	await assert.rejects(f.state.apply(f.dir,next.id,next.hash,queue,abort.signal),/aborted/);
	f.state.clear();
	await assert.rejects(f.state.apply(f.dir,next.id,next.hash,queue),/Unknown/);
	assert.equal(await fs.readFile(f.file,"utf8"),"external");
});
