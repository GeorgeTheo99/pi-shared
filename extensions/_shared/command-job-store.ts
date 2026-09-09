import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, withInterprocessLock } from "./file-lock.ts";

export type CommandStatus = "starting" | "running" | "canceling" | "succeeded" | "failed" | "canceled" | "timed_out" | "lost";
export const COMMAND_TERMINAL = new Set<CommandStatus>(["succeeded", "failed", "canceled", "timed_out", "lost"]);
export interface CommandRecord {
	version: 1;
	id: string;
	owner: string;
	ownerPid: number;
	project: string;
	label: string;
	createdAt: number;
	updatedAt: number;
	status: CommandStatus;
	pid?: number;
	cancelRequested?: boolean;
	finishedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	reason?: string;
	cleanup?: "confirmed" | "unconfirmed";
	readiness: "not_requested" | "pending" | "ready" | "failed";
	stdoutBytes: number;
	stderrBytes: number;
	stdoutOmitted: number;
	stderrOmitted: number;
}
export function commandStateDir(): string {
	return path.resolve(process.env.PI_COMMAND_STATE_DIR || path.join(os.homedir(), ".pi", "command-jobs"));
}
export function assertCommandId(id: string): void {
	if (!/^cmd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid command job ID");
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error: any) { return error?.code === "EPERM"; }
}
export class CommandJobStore {
	readonly dir: string;
	constructor(dir = commandStateDir()) { this.dir = path.resolve(dir); }
	jobDir(id: string): string { assertCommandId(id); return path.join(this.dir, id); }
	read(id: string, reconcile = true): CommandRecord | undefined {
		const dir = this.jobDir(id);
		try {
			if (!fs.lstatSync(dir).isDirectory()) throw new Error("Job directory is not a directory");
			const file = path.join(dir, "job.json");
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid command job record");
			const r = JSON.parse(fs.readFileSync(file, "utf8")) as CommandRecord;
			if (r.version !== 1 || r.id !== id || typeof r.owner !== "string" || !Number.isInteger(r.ownerPid) || r.ownerPid <= 0 || typeof r.project !== "string" || !Number.isFinite(r.updatedAt) || !["starting", "running", "canceling", ...COMMAND_TERMINAL].includes(r.status)) throw new Error("Invalid command job record");
			if (reconcile && !COMMAND_TERMINAL.has(r.status) && (!alive(r.ownerPid) || Date.now() - r.updatedAt > 30_000)) {
				return { ...r, status: "lost", cleanup: "unconfirmed", reason: "Owner absent or lease expired; execution cannot be resumed and descendants may remain" };
			}
			return r;
		} catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
	}
	list(project?: string): CommandRecord[] {
		let names: string[];
		try { names = fs.readdirSync(this.dir); } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
		return names.filter(n => /^cmd_[0-9a-f-]{36}$/.test(n)).map(n => this.read(n)).filter((r): r is CommandRecord => !!r && (!project || r.project === project)).sort((a, b) => b.createdAt - a.createdAt);
	}
	async reserve(record: CommandRecord, maxActive = 8, maxRecords = 100, signal?: AbortSignal): Promise<void> {
		await withInterprocessLock(path.join(this.dir, ".lock"), async () => {
			await fs.promises.chmod(this.dir, 0o700);
			const records = this.list();
			if (records.filter(r => !COMMAND_TERMINAL.has(r.status)).length >= maxActive) throw new Error(`Command capacity reached (${maxActive} active jobs)`);
			// Lost owners can still have live children: retain their evidence and do not
			// recycle their slots while their owner PID is alive (possible stalled loop).
			if (records.filter(r => r.status === "lost" && alive(r.ownerPid)).length + records.filter(r => !COMMAND_TERMINAL.has(r.status)).length >= maxActive) throw new Error("Command capacity unavailable: live owners have expired leases");
			const removable = records.filter(r => COMMAND_TERMINAL.has(r.status) && r.status !== "lost").sort((a,b) => a.createdAt-b.createdAt);
			let count = records.length;
			for (const old of removable) {
				if (count < maxRecords) break;
				const dir = this.jobDir(old.id);
				for (const file of ["stdout.log", "stderr.log", "job.json"]) await fs.promises.unlink(path.join(dir, file)).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
				await fs.promises.rmdir(dir); // Refuse unknown contents, never recursively delete.
				count--;
			}
			if (count >= maxRecords) throw new Error("Command history full; retained lost jobs need inspection");
			await fs.promises.mkdir(this.jobDir(record.id), { mode: 0o700 });
			try { await atomicWriteJson(path.join(this.jobDir(record.id), "job.json"), record); }
			catch (error) { await fs.promises.rmdir(this.jobDir(record.id)).catch(() => undefined); throw error; }
		}, { signal });
	}
	async update(id: string, owner: string | undefined, mutate: (record: CommandRecord) => CommandRecord): Promise<CommandRecord> {
		return withInterprocessLock(path.join(this.dir, ".lock"), async () => {
			const current = this.read(id, false);
			if (!current) throw new Error("Unknown command job");
			if (owner && current.owner !== owner) throw new Error("Command owner mismatch");
			const next = mutate(current);
			await atomicWriteJson(path.join(this.jobDir(id), "job.json"), next);
			return next;
		});
	}
	async cancel(id: string, project: string): Promise<CommandRecord> {
		return this.update(id, undefined, r => {
			if (r.project !== project) throw new Error("Command job belongs to another project");
			if (COMMAND_TERMINAL.has(r.status)) return r;
			return { ...r, cancelRequested: true };
		});
	}
}
