import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface InterprocessLockOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
}

interface LockOwner {
	token: string;
	pid: number;
	createdAt: string;
}

function abortError(message = "Operation aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			cleanup();
			resolve();
		}
		function onAbort() {
			cleanup();
			reject(abortError());
		}
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

// Every acquisition publishes a unique filename, with the PID readable even if
// the process crashes partway through writing its JSON. Never recursively remove
// or rename a lock directory: a stale observer could thereby remove a new owner.
const ownerNamePattern = /^owner-(\d+)-[0-9a-f-]+\.json$/;

async function removeEmptyLock(lockPath: string): Promise<boolean> {
	try {
		await fs.promises.rmdir(lockPath);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
		throw error;
	}
}

async function breakStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(lockPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
	if (Date.now() - stat.mtimeMs <= staleMs) return false;

	try {
		for (const name of await fs.promises.readdir(lockPath)) {
			const match = ownerNamePattern.exec(name);
			if (match) {
				if (isProcessAlive(Number(match[1]))) continue;
			} else if (name === "owner.json") {
				// Migrate abandoned legacy locks. Old writers MUST be drained before
				// upgrade: their fixed filenames and blind renames are incompatible
				// with safe concurrent reclamation, regardless of our protocol.
				try {
					const owner = JSON.parse(await fs.promises.readFile(path.join(lockPath, name), "utf8")) as Partial<LockOwner>;
					if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) continue;
				} catch (error: any) {
					if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") return false;
				}
			} else {
				continue; // Unknown files fail closed; never delete arbitrary contents.
			}
			await fs.promises.unlink(path.join(lockPath, name)).catch((error) => {
				if (error?.code !== "ENOENT") throw error;
			});
		}
		// A concurrent reclaimer may have installed a new generation. Its live
		// marker has a different name, so unlink above cannot touch it, and this
		// atomic rmdir can only remove an EMPTY directory.
		return await removeEmptyLock(lockPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
}

async function releaseLock(lockPath: string, ownerName: string): Promise<void> {
	await fs.promises.unlink(path.join(lockPath, ownerName)).catch((error) => {
		if (error?.code !== "ENOENT") throw error;
	});
	await removeEmptyLock(lockPath);
}

async function tryAcquireLock(lockPath: string, ownerName: string, owner: LockOwner): Promise<boolean> {
	try {
		await fs.promises.mkdir(lockPath, { mode: 0o700 });
	} catch (error: any) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}

	let directory: fs.promises.FileHandle | undefined;
	let acquired = false;
	try {
		// Pin the inode while publishing: empty directories can be reclaimed
		// before publication, and keeping the handle open prevents inode reuse.
		directory = await fs.promises.open(lockPath, "r");
		const before = await directory.stat({ bigint: true });
		await fs.promises.writeFile(path.join(lockPath, ownerName), `${JSON.stringify(owner)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		const after = await fs.promises.stat(lockPath, { bigint: true });
		const names = await fs.promises.readdir(lockPath);
		// mkdir may have succeeded on a now-removed directory, or open may have
		// reached a replacement. Require the pinned generation AND sole ownership.
		// Once published, our live marker prevents rmdir until release. A late
		// publisher sees our marker and cannot enter alongside us.
		acquired = before.dev === after.dev && before.ino === after.ino
			&& names.length === 1 && names[0] === ownerName;
		return acquired;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		// macOS/APFS can report EINVAL (rather than ENOENT) when open(O_CREAT)
		// races rmdir of its parent. This is another lost publication attempt.
		if (error?.code === "EINVAL" && error?.syscall === "open" && error?.path === path.join(lockPath, ownerName)) return false;
		throw error;
	} finally {
		try {
			await directory?.close();
		} finally {
			if (!acquired) await releaseLock(lockPath, ownerName);
		}
	}
}

export async function withInterprocessLock<T>(
	lockPath: string,
	fn: () => Promise<T> | T,
	options: InterprocessLockOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const staleMs = options.staleMs ?? 30_000;
	const retryMs = options.retryMs ?? 25;
	const startedAt = Date.now();
	let ownerName: string;

	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	while (true) {
		if (options.signal?.aborted) throw abortError();
		const token = crypto.randomUUID();
		ownerName = `owner-${process.pid}-${token}.json`;
		const owner: LockOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
		if (await tryAcquireLock(lockPath, ownerName, owner)) break;
		await breakStaleLock(lockPath, staleMs);
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out acquiring interprocess lock: ${lockPath}`);
		}
		await delay(retryMs, options.signal);
	}

	try {
		if (options.signal?.aborted) throw abortError();
		return await fn();
	} finally {
		await releaseLock(lockPath, ownerName);
	}
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		await fs.promises.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.promises.rename(tmpPath, filePath);
	} finally {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
	}
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}
