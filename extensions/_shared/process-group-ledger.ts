import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Child-only: path the child Bash override appends each command's process group to. */
export const PROCESS_GROUP_LEDGER_ENV = "PI_SUBAGENT_PGID_LEDGER";
/** Roughly 100k commands per run; past this, cleanup is reported unconfirmed rather than guessed. */
export const MAX_PROCESS_GROUP_LEDGER_BYTES = 1024 * 1024;

export interface OwnedProcessGroups {
	/** Recorded groups that still exist and were never observed dead. */
	groups: number[];
	/** Set when ledger evidence is missing, oversized, or malformed; cleanup cannot be confirmed. */
	error?: string;
}

let parentProcessGroup: number | null | undefined;

function currentProcessGroup(): number | null {
	if (parentProcessGroup !== undefined) return parentProcessGroup;
	const result = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 });
	const value = Number.parseInt(result.stdout?.trim() ?? "", 10);
	parentProcessGroup = Number.isInteger(value) && value > 1 ? value : null;
	return parentProcessGroup;
}

/** Existence probe only: a live group may still belong to a reused number, so callers must retire dead groups early. */
function groupState(group: number): "alive" | "dead" {
	try {
		process.kill(-group, 0);
		return "alive";
	} catch (error: any) {
		return error?.code === "ESRCH" ? "dead" : "alive";
	}
}

/**
 * Run-scoped record of the process groups a subagent's Bash commands created.
 *
 * Pi starts every Bash command as its own session/process-group leader, so
 * background jobs outlive the child Pi process under that group. Groups
 * observed dead are retired permanently so a later reuse of the same number is
 * never signaled; periodic pruning keeps that reuse window short.
 */
export class ProcessGroupLedger {
	readonly filePath: string;
	private readonly dir: string;
	private readonly excluded: Set<number>;
	private readonly retired = new Set<number>();
	private pruneTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	private constructor(dir: string, excluded: number[]) {
		this.dir = dir;
		this.filePath = path.join(dir, "process-groups");
		this.excluded = new Set(excluded);
		fs.writeFileSync(this.filePath, "", { flag: "wx", mode: 0o600 });
	}

	/** Returns undefined where POSIX process groups are unavailable. */
	static create(excluded: number[] = []): ProcessGroupLedger | undefined {
		if (process.platform === "win32") return undefined;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-pgids-"));
		const parentGroup = currentProcessGroup();
		return new ProcessGroupLedger(dir, [0, 1, process.pid, ...(parentGroup ? [parentGroup] : []), ...excluded]);
	}

	env(): Record<string, string> {
		return { [PROCESS_GROUP_LEDGER_ENV]: this.filePath };
	}

	read(): OwnedProcessGroups {
		let text: string;
		try {
			const size = fs.statSync(this.filePath).size;
			if (size > MAX_PROCESS_GROUP_LEDGER_BYTES) {
				return { groups: [], error: `Process-group ledger exceeded ${MAX_PROCESS_GROUP_LEDGER_BYTES} bytes.` };
			}
			text = fs.readFileSync(this.filePath, "utf8");
		} catch (error) {
			return { groups: [], error: `Process-group ledger unreadable: ${error instanceof Error ? error.message : String(error)}` };
		}
		const groups = new Set<number>();
		let error: string | undefined;
		for (const line of text.split("\n")) {
			if (!line) continue;
			const group = /^[1-9]\d{0,9}$/.test(line) ? Number(line) : Number.NaN;
			if (!Number.isSafeInteger(group) || this.excluded.has(group)) {
				error ??= `Process-group ledger contains an invalid entry: ${JSON.stringify(line.slice(0, 32))}.`;
				continue;
			}
			if (this.retired.has(group) || groups.has(group)) continue;
			if (groupState(group) === "dead") this.retired.add(group);
			else groups.add(group);
		}
		return { groups: [...groups], error };
	}

	startPruning(intervalMs = 1000): void {
		if (this.pruneTimer || this.disposed) return;
		this.pruneTimer = setInterval(() => this.read(), intervalMs);
		this.pruneTimer.unref();
	}

	/** Reject new registrations; commands that cannot register refuse to run. */
	seal(): void {
		this.stopPruning();
		try {
			fs.chmodSync(this.filePath, 0o400);
			fs.chmodSync(this.dir, 0o500);
		} catch {
			// A missing ledger is reported by read().
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopPruning();
		try {
			fs.chmodSync(this.dir, 0o700);
		} catch {
			// Already removed.
		}
		fs.rmSync(this.dir, { recursive: true, force: true });
	}

	private stopPruning(): void {
		if (this.pruneTimer) clearInterval(this.pruneTimer);
		this.pruneTimer = undefined;
	}
}

/**
 * Shell prefix that records the command's process group before running it, or refuses to run.
 * `$$` is the group only because Pi starts the shell as a group leader; a custom
 * shellPath must therefore be (or exec) the shell itself.
 */
export function processGroupRegistrationPrefix(ledgerPath: string): string {
	const quoted = `'${ledgerPath.replace(/'/g, `'\\''`)}'`;
	return `printf '%s\\n' "$$" >> ${quoted} 2>/dev/null || { printf '%s\\n' 'pi-subagent: could not register this command for process cleanup; it was not run.' >&2; exit 125; }`;
}
