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
		const owner = JSON.parse(await fs.promises.readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
		if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) return false;
	} catch {
		// A stale lock without readable ownership metadata is safe to reclaim.
	}

	const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
	try {
		await fs.promises.rename(lockPath, stalePath);
		await fs.promises.rm(stalePath, { recursive: true, force: true });
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
	try {
		const owner = JSON.parse(await fs.promises.readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
		if (owner.token !== token) return;
	} catch {
		return;
	}
	await fs.promises.rm(lockPath, { recursive: true, force: true });
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
	const token = crypto.randomUUID();
	const owner: LockOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };

	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	while (true) {
		if (options.signal?.aborted) throw abortError();
		let created = false;
		try {
			await fs.promises.mkdir(lockPath, { mode: 0o700 });
			created = true;
			await fs.promises.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				if (created) await fs.promises.rm(lockPath, { recursive: true, force: true });
				else await releaseLock(lockPath, token);
				throw error;
			}
			if (await breakStaleLock(lockPath, staleMs)) continue;
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out acquiring interprocess lock: ${lockPath}`);
			}
			await delay(retryMs, options.signal);
		}
	}

	try {
		return await fn();
	} finally {
		await releaseLock(lockPath, token);
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
