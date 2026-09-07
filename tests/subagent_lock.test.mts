import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { withInterprocessLock } from "../extensions/_shared/file-lock.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function ageLock(lockPath: string) {
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
}

function lockWorker(t: TestContext, lockPath: string, source: string) {
	const moduleUrl = new URL("../extensions/_shared/file-lock.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
		import fs from "node:fs";
		import { withInterprocessLock } from ${JSON.stringify(moduleUrl)};
		const lockPath = ${JSON.stringify(lockPath)};
		const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
		${source}
	`], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let output = "";
	child.stdout.on("data", (data) => { output += data; });
	child.stderr.on("data", (data) => { output += data; });
	const exited = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	return { child, exited, output: () => output };
}

function tempLock(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-lock-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "state.lock");
}

test("a live lock holder cannot be stolen after the stale-age threshold", async (t) => {
	const lockPath = tempLock(t);
	let releaseStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		releaseStarted = resolve;
	});
	let holderFinishedAt = 0;
	let contenderEnteredAt = 0;

	const holder = withInterprocessLock(
		lockPath,
		async () => {
			releaseStarted();
			await delay(250);
			holderFinishedAt = Date.now();
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);
	await started;
	await delay(80);
	const contender = withInterprocessLock(
		lockPath,
		() => {
			contenderEnteredAt = Date.now();
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);

	await Promise.all([holder, contender]);
	assert.ok(holderFinishedAt > 0);
	assert.ok(contenderEnteredAt >= holderFinishedAt, "contender entered while the live holder still owned the lock");
});

test("a legacy stale lock owned by a dead process is reclaimed", async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath, { recursive: true });
	fs.writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify({ token: "dead", pid: 99_999_999, createdAt: new Date(0).toISOString() }),
	);
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
	let entered = false;
	await withInterprocessLock(
		lockPath,
		() => {
			entered = true;
		},
		{ staleMs: 50, timeoutMs: 1000, retryMs: 10 },
	);
	assert.equal(entered, true);
});

for (const legacy of [false, true]) {
	test(`two stale reclaimers cannot delete a replacement live lock (${legacy ? "legacy" : "generational"})`, { timeout: 5000 }, async (t) => {
		const lockPath = tempLock(t);
		const deadName = legacy ? "owner.json" : "owner-99999999-00000000-0000-0000-0000-000000000000.json";
		const deadPath = path.join(lockPath, deadName);
		fs.mkdirSync(lockPath);
		fs.writeFileSync(deadPath, JSON.stringify({ token: "dead", pid: 99_999_999 }));
		ageLock(lockPath);

		const snapshots = [deferred(), deferred()];
		const resume = [deferred(), deferred()];
		const entered = deferred();
		const finishHolder = deferred();
		const unlink = fs.promises.unlink;
		let reclaimers = 0;
		t.mock.method(fs.promises, "unlink", async (file: fs.PathLike) => {
			if (String(file) === deadPath && reclaimers < 2) {
				const index = reclaimers++;
				snapshots[index].resolve();
				await resume[index].promise;
			}
			return unlink(file);
		});

		const holder = withInterprocessLock(lockPath, async () => {
			entered.resolve();
			await finishHolder.promise;
		}, { staleMs: 0, timeoutMs: 2000, retryMs: 1 });
		await snapshots[0].promise;
		let stolen = false;
		const contender = assert.rejects(withInterprocessLock(lockPath, () => {
			stolen = true;
		}, { staleMs: 0, timeoutMs: 150, retryMs: 1 }), /Timed out acquiring/);
		try {
			await snapshots[1].promise;
			resume[0].resolve();
			await entered.promise;
			const liveNames = fs.readdirSync(lockPath);
			resume[1].resolve();
			await contender;
			assert.equal(stolen, false);
			assert.deepEqual(fs.readdirSync(lockPath), liveNames);
		} finally {
			resume.forEach((gate) => gate.resolve());
			finishHolder.resolve();
			await holder;
		}
		assert.equal(fs.existsSync(lockPath), false);
	});
}

// Force the empty-directory publication window, including replacement BEFORE
// open (sole-owner validation) and AFTER open (pinned-directory validation).
for (const pauseAt of ["open", "writeFile"] as const) {
	test(`a delayed publisher cannot join a replacement generation (paused at ${pauseAt})`, { timeout: 5000 }, async (t) => {
		const lockPath = tempLock(t);
		const paused = deferred();
		const resume = deferred();
		const holderEntered = deferred();
		const releaseHolder = deferred();
		const abort = new AbortController();
		let intercepted = false;
		const original = fs.promises[pauseAt];
		t.mock.method(fs.promises, pauseAt, async (...args: any[]) => {
			if (!intercepted && (String(args[0]) === lockPath || path.dirname(String(args[0])) === lockPath)) {
				intercepted = true;
				ageLock(lockPath);
				paused.resolve();
				await resume.promise;
			}
			return (original as Function)(...args);
		});
		let stolen = false;
		const publisher = assert.rejects(withInterprocessLock(lockPath, () => {
			stolen = true;
		}, { staleMs: 0, timeoutMs: 150, retryMs: 1, signal: abort.signal }), /Timed out acquiring|Operation aborted/);
		await paused.promise;
		const holder = withInterprocessLock(lockPath, async () => {
			holderEntered.resolve();
			await releaseHolder.promise;
		}, { staleMs: 0, timeoutMs: 2000, retryMs: 1 });
		try {
			await holderEntered.promise;
			const names = fs.readdirSync(lockPath);
			resume.resolve();
			await publisher;
			assert.equal(stolen, false);
			assert.deepEqual(fs.readdirSync(lockPath), names);
		} finally {
			abort.abort();
			resume.resolve();
			releaseHolder.resolve();
			await holder;
		}
	});
}

test("an unpublished owner cannot acquire a different empty directory generation", { timeout: 5000 }, async (t) => {
	const lockPath = tempLock(t);
	const paused = deferred();
	const resume = deferred();
	const writeFile = fs.promises.writeFile;
	let intercepted = false;
	const abort = new AbortController();
	t.mock.method(fs.promises, "writeFile", async (...args: any[]) => {
		if (!intercepted && path.dirname(String(args[0])) === lockPath) {
			intercepted = true;
			paused.resolve();
			await resume.promise;
		}
		return (writeFile as Function)(...args);
	});
	let entered = false;
	const attempt = assert.rejects(withInterprocessLock(lockPath, () => {
		entered = true;
	}, { staleMs: 0, retryMs: 1, signal: abort.signal }), { name: "AbortError" });
	await paused.promise;
	// Simulate a reclaimer followed by another mkdir winner which has not yet
	// published. The first attempt has an open handle to the removed inode.
	fs.rmdirSync(lockPath);
	fs.mkdirSync(lockPath);
	const unlink = fs.promises.unlink;
	t.mock.method(fs.promises, "unlink", async (file: fs.PathLike) => {
		await unlink(file);
		abort.abort(); // Stop retries only AFTER failed-publication cleanup.
	});
	resume.resolve();
	await attempt;
	assert.equal(entered, false);
	assert.equal(fs.existsSync(lockPath), false);
});

test("live PID filenames protect partially written ownership metadata", async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath);
	const name = `owner-${process.pid}-00000000-0000-0000-0000-000000000000.json`;
	fs.writeFileSync(path.join(lockPath, name), "{");
	ageLock(lockPath);
	await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("stole live partial owner"), {
		staleMs: 0, timeoutMs: 50, retryMs: 1,
	}), /Timed out acquiring/);
	assert.deepEqual(fs.readdirSync(lockPath), [name]);
});

test("empty and malformed abandoned legacy locks recover; unknown contents fail closed", async (t) => {
	for (const contents of ["empty", "malformed", "unknown"]) {
		const lockPath = tempLock(t);
		fs.mkdirSync(lockPath);
		if (contents !== "empty") fs.writeFileSync(path.join(lockPath, contents === "malformed" ? "owner.json" : "unknown"), "{");
		ageLock(lockPath);
		const attempt = withInterprocessLock(lockPath, () => "entered", { staleMs: 0, timeoutMs: 50, retryMs: 1 });
		if (contents === "unknown") {
			await assert.rejects(attempt, /Timed out acquiring/);
			assert.deepEqual(fs.readdirSync(lockPath), ["unknown"]);
		} else {
			assert.equal(await attempt, "entered");
			assert.equal(fs.existsSync(lockPath), false);
		}
	}
});

test("abort and callback failures do not leak or release another owner's lock", async (t) => {
	const lockPath = tempLock(t);
	await assert.rejects(withInterprocessLock(lockPath, () => { throw new Error("callback failed"); }), /callback failed/);
	assert.equal(fs.existsSync(lockPath), false);
	await withInterprocessLock(lockPath, async () => {
		const names = fs.readdirSync(lockPath);
		const abort = new AbortController();
		const attempt = withInterprocessLock(lockPath, () => assert.fail("entered while held"), { signal: abort.signal, retryMs: 1 });
		await delay(10);
		abort.abort();
		await assert.rejects(attempt, { name: "AbortError" });
		assert.deepEqual(fs.readdirSync(lockPath), names);
	});
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("entered after abort"), { signal: abort.signal }), { name: "AbortError" });
	assert.equal(fs.existsSync(lockPath), false);
});

test("publication retries macOS removed-parent EINVAL but propagates other I/O failures", async (t) => {
	for (const code of ["EINVAL", "EACCES"]) {
		const lockPath = tempLock(t);
		const writeFile = fs.promises.writeFile;
		let injected = false;
		const mock = t.mock.method(fs.promises, "writeFile", async (...args: any[]) => {
			if (!injected && path.dirname(String(args[0])) === lockPath) {
				injected = true;
				throw Object.assign(new Error(code), { code, syscall: "open", path: args[0] });
			}
			return (writeFile as Function)(...args);
		});
		try {
			const attempt = withInterprocessLock(lockPath, () => "entered", { staleMs: 0, retryMs: 1 });
			if (code === "EINVAL") assert.equal(await attempt, "entered");
			else await assert.rejects(attempt, { code });
			assert.equal(injected, true);
			assert.equal(fs.existsSync(lockPath), false);
		} finally {
			mock.mock.restore();
		}
	}
});

test("cross-process reclamation and contention serialize read-modify-write operations", { timeout: 15000 }, async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath);
	// A dead process can leave incomplete JSON; the unique PID filename is
	// sufficient to recover it without depending on a successful metadata write.
	fs.writeFileSync(path.join(lockPath, "owner-99999999-00000000-0000-0000-0000-000000000000.json"), "{");
	ageLock(lockPath);
	fs.writeFileSync(`${lockPath}.counter`, "0");
	const workers = Array.from({ length: 4 }, () => lockWorker(t, lockPath, `
		for (let i = 0; i < 20; i++) {
			await withInterprocessLock(lockPath, async () => {
				fs.mkdirSync(lockPath + ".critical");
				const n = Number(fs.readFileSync(lockPath + ".counter", "utf8"));
				await delay(2);
				fs.writeFileSync(lockPath + ".counter", String(n + 1));
				fs.rmdirSync(lockPath + ".critical");
			}, { staleMs: 0, retryMs: 1, timeoutMs: 10000 });
		}
		process.disconnect();
	`));
	for (const worker of workers) {
		const [code, signal] = await worker.exited;
		assert.equal(code, 0, `${signal ?? ""} ${worker.output()}`);
	}
	assert.equal(fs.readFileSync(`${lockPath}.counter`, "utf8"), "80");
	assert.equal(fs.existsSync(lockPath), false);
});

test("a live child is protected and its lock recovers after SIGKILL", { timeout: 10000 }, async (t) => {
	const lockPath = tempLock(t);
	const worker = lockWorker(t, lockPath, `
		await withInterprocessLock(lockPath, async () => {
			process.send("held");
			await new Promise(() => { setInterval(() => {}, 1000); });
		});
	`);
	assert.deepEqual(await once(worker.child, "message"), ["held", undefined]);
	ageLock(lockPath);
	await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("stole child lock"), {
		staleMs: 0, timeoutMs: 75, retryMs: 1,
	}), /Timed out acquiring/);
	worker.child.kill("SIGKILL");
	assert.equal((await worker.exited)[1], "SIGKILL");
	assert.equal(await withInterprocessLock(lockPath, () => "recovered", {
		staleMs: 0, timeoutMs: 1000, retryMs: 1,
	}), "recovered");
	assert.equal(fs.existsSync(lockPath), false);
});

function seedDeadLock(lockPath: string): string {
	fs.mkdirSync(lockPath);
	const ownerFile = `owner-99999999-${crypto.randomUUID()}.json`;
	fs.writeFileSync(path.join(lockPath, ownerFile), "{}");
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
	return ownerFile;
}

test("competing stale reclaimers cannot remove a fresh owner's lock", { timeout: 5_000 }, async (t) => {
	const lockPath = tempLock(t);
	const ownerFile = seedDeadLock(lockPath);
	const bothRead = deferred();
	const firstEntered = deferred();
	const staleAttemptFinished = deferred();
	let reads = 0;
	let removals = 0;
	let entries = 0;
	let active = 0;
	let maxActive = 0;
	const readdir = fs.promises.readdir.bind(fs.promises);
	const unlink = fs.promises.unlink.bind(fs.promises);
	t.mock.method(fs.promises, "readdir", async (...args: any[]) => {
		const value = await (readdir as any)(...args);
		if (args[0] === lockPath && value.includes(ownerFile)) {
			if (++reads === 2) bothRead.resolve();
			await bothRead.promise;
		}
		return value;
	});
	t.mock.method(fs.promises, "unlink", async (file: string) => {
		if (file === path.join(lockPath, ownerFile) && ++removals === 2) {
			await firstEntered.promise;
			try { return await unlink(file); }
			finally { staleAttemptFinished.resolve(); }
		}
		return unlink(file);
	});
	const critical = async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		try {
			if (++entries === 1) {
				firstEntered.resolve();
				await staleAttemptFinished.promise;
				await delay(30);
			}
		} finally { active--; }
	};
	await Promise.all([
		withInterprocessLock(lockPath, critical, { staleMs: 1, retryMs: 2 }),
		withInterprocessLock(lockPath, critical, { staleMs: 1, retryMs: 2 }),
	]);
	assert.equal(reads, 2);
	assert.equal(entries, 2);
	assert.equal(maxActive, 1, "a delayed reclaimer must not admit a second critical section");
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("delayed release rmdir cannot remove a non-empty successor", { timeout: 5_000 }, async (t) => {
	const lockPath = tempLock(t);
	const releaseReady = deferred();
	const successorEntered = deferred();
	const releaseFinished = deferred();
	const rmdir = fs.promises.rmdir.bind(fs.promises);
	let removals = 0;
	t.mock.method(fs.promises, "rmdir", async (...args: any[]) => {
		if (args[0] === lockPath && ++removals === 1) {
			releaseReady.resolve();
			await successorEntered.promise;
			try { return await (rmdir as any)(...args); }
			finally { releaseFinished.resolve(); }
		}
		return (rmdir as any)(...args);
	});
	const first = withInterprocessLock(lockPath, () => undefined);
	await releaseReady.promise;
	const second = withInterprocessLock(lockPath, async () => {
		successorEntered.resolve();
		await releaseFinished.promise;
		assert.equal(fs.readdirSync(lockPath).length, 1, "successor ownership must survive delayed cleanup");
	}, { staleMs: 0, retryMs: 2 });
	await Promise.all([first, second]);
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("a fresh empty legacy lock is not replaced during initialization", async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath);
	await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("must not replace an initializing legacy holder"), {
		staleMs: 60_000, timeoutMs: 20, retryMs: 2,
	}), /Timed out/);
	assert.deepEqual(fs.readdirSync(lockPath), []);
});

test("stale partial legacy ownership is recoverable", async (t) => {
	const lockPath = tempLock(t);
	fs.mkdirSync(lockPath);
	fs.writeFileSync(path.join(lockPath, "owner.json"), '{"pid":');
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
	await withInterprocessLock(lockPath, () => undefined, { staleMs: 1, timeoutMs: 100, retryMs: 2 });
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("an initializer displaced by delayed empty-directory cleanup cannot share a successor's lock", { timeout: 5_000 }, async (t) => {
	const lockPath = tempLock(t);
	const firstWriting = deferred();
	const resumeFirstWrite = deferred();
	const secondEntered = deferred();
	const firstAttemptRemoved = deferred();
	let firstOwnerFile: string | undefined;
	let active = 0;
	let maxActive = 0;
	const writeFile = fs.promises.writeFile.bind(fs.promises);
	const unlink = fs.promises.unlink.bind(fs.promises);
	t.mock.method(fs.promises, "writeFile", async (...args: any[]) => {
		if (typeof args[0] === "string" && path.dirname(args[0]) === lockPath && !firstOwnerFile) {
			firstOwnerFile = args[0];
			firstWriting.resolve();
			await resumeFirstWrite.promise;
		}
		return (writeFile as any)(...args);
	});
	t.mock.method(fs.promises, "unlink", async (file: string) => {
		const result = await unlink(file);
		if (file === firstOwnerFile) firstAttemptRemoved.resolve();
		return result;
	});
	const first = withInterprocessLock(lockPath, async () => {
		active++; maxActive = Math.max(maxActive, active);
		await delay(2);
		active--;
	}, { retryMs: 2 });
	await firstWriting.promise;
	// This is the exact filesystem operation a delayed empty-lock reclaimer can perform.
	fs.rmdirSync(lockPath);
	const second = withInterprocessLock(lockPath, async () => {
		active++; maxActive = Math.max(maxActive, active);
		secondEntered.resolve();
		await firstAttemptRemoved.promise;
		await delay(20);
		active--;
	}, { retryMs: 2 });
	await secondEntered.promise;
	resumeFirstWrite.resolve();
	await Promise.all([first, second]);
	assert.equal(maxActive, 1);
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("abandoned colliding initialization claims are recovered without removing live claims", async (t) => {
	const lockPath = tempLock(t);
	const dead = seedDeadLock(lockPath);
	const secondDead = `owner-99999998-${crypto.randomUUID()}.json`;
	fs.writeFileSync(path.join(lockPath, secondDead), "{}");
	const live = `owner-${process.pid}-${crypto.randomUUID()}.json`;
	fs.writeFileSync(path.join(lockPath, live), "{}");
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(lockPath, old, old);
	await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("live initializer must stay protected"), {
		staleMs: 1, timeoutMs: 30, retryMs: 2,
	}), /Timed out/);
	assert.deepEqual(fs.readdirSync(lockPath), [live], "dead claims are cleaned individually; live claim survives");
	fs.unlinkSync(path.join(lockPath, live));
	fs.writeFileSync(path.join(lockPath, dead), "{}");
	fs.writeFileSync(path.join(lockPath, secondDead), "{}");
	fs.utimesSync(lockPath, old, old);
	await withInterprocessLock(lockPath, () => undefined, { staleMs: 1, timeoutMs: 100, retryMs: 2 });
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("timeout, abort, and callback failure clean up only the caller's lock files", async (t) => {
	const lockPath = tempLock(t);
	const started = deferred();
	const finish = deferred();
	const holder = withInterprocessLock(lockPath, async () => { started.resolve(); await finish.promise; });
	await started.promise;
	try {
		await assert.rejects(withInterprocessLock(lockPath, () => assert.fail("must not enter"), {
			timeoutMs: 20, staleMs: 0, retryMs: 2,
		}), /Timed out/);
		const controller = new AbortController();
		const waiting = withInterprocessLock(lockPath, () => assert.fail("must not enter"), {
			signal: controller.signal, retryMs: 2,
		});
		controller.abort();
		await assert.rejects(waiting, { name: "AbortError" });
		assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
	} finally { finish.resolve(); await holder; }
	await assert.rejects(withInterprocessLock(lockPath, () => { throw new Error("callback failed"); }), /callback failed/);
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
});

test("independent processes serialize writes while competing to recover a dead lock", { timeout: 15_000 }, async (t) => {
	const lockPath = tempLock(t);
	seedDeadLock(lockPath);
	const counterPath = path.join(path.dirname(lockPath), "counter");
	fs.writeFileSync(counterPath, "0");
	const fixture = path.join(import.meta.dirname, "fixtures", "file_lock_writer.mjs");
	await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--no-warnings", fixture, lockPath, counterPath, "10"], { stdio: ["ignore", "ignore", "pipe"] });
		t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
	})));
	assert.equal(fs.readFileSync(counterPath, "utf8"), "60");
	assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["counter"]);
});
