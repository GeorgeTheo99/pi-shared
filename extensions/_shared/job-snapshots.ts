import fs from "node:fs";
import { readJobSnapshots, type JobSnapshot } from "./job-store.ts";
import { CommandJobStore, COMMAND_TERMINAL, type CommandRecord } from "./command-job-store.ts";

export interface UnifiedJobSnapshot extends JobSnapshot {
	kind?: "command" | "subagent";
	command?: CommandRecord;
}
/** Normalize for existing wait modes; retain exact command outcome alongside it. */
export function readUnifiedJobSnapshots(ids: string[], cwd: string): Map<string, UnifiedJobSnapshot> {
	const snapshots = ids.some(id => !id.startsWith("cmd_")) ? new Map<string, UnifiedJobSnapshot>(readJobSnapshots()) : new Map<string, UnifiedJobSnapshot>();
	const store = new CommandJobStore();
	const project = fs.realpathSync(cwd);
	for (const id of ids.filter(id => id.startsWith("cmd_"))) {
		const record = store.read(id);
		if (!record || record.project !== project) continue;
		snapshots.set(id, { id, kind: "command", command: record, label: record.label,
			status: record.status === "succeeded" ? "completed" : COMMAND_TERMINAL.has(record.status) ? "failed" : record.status === "canceling" ? "canceling" : "running" });
	}
	return snapshots;
}
