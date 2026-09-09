import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_GIT_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_INLINE_FILES = 100;

export interface SubagentWorktree {
	readonly version: 1;
	readonly path: string;
	readonly parentPath: string;
	readonly base: string;
	readonly parentDirty: boolean;
	readonly artifactDirectory: string;
}

export interface WorktreeReport extends SubagentWorktree {
	head?: string;
	retained: true;
	retentionReason: string;
	inventory: {
		status: "complete" | "incomplete";
		scope: string;
		tracked: string[];
		untracked: string[];
		ignored: string[];
		binaryTracked: string[];
		inlineTruncated: boolean;
		artifact?: string;
	};
	patch: { status: "available" | "empty" | "omitted"; path?: string; bytes?: number; scope: string };
}

// Identity is a live capability, not a caller-supplied path or editable manifest.
const owned = new WeakMap<SubagentWorktree, { commonDir: string; gitDir: string }>();

async function git(cwd: string, args: string[], maxBuffer = MAX_GIT_BYTES, signal?: AbortSignal): Promise<string> {
	const env = { ...process.env };
	// A parent shell's GIT_DIR/INDEX_FILE/WORK_TREE must not redirect this operation.
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	return new Promise((resolve, reject) => {
		execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
			cwd, env, encoding: "buffer", maxBuffer, timeout: 30_000, killSignal: "SIGKILL", signal,
		}, (error, stdout) => {
			// Never relay stderr, patches, config values, or arbitrary file contents in errors.
			if (error || !isUtf8(stdout)) reject(new Error("Git operation failed, was canceled, exceeded the 30s/size bound, or returned non-UTF-8 data."));
			else resolve(stdout.toString("utf8"));
		});
	});
}

export function validateWorktreeRequest(params: {
	isolation?: string; baseRevision?: string; agent?: string; task?: string;
	interactive?: boolean; background?: boolean; tasks?: unknown[]; chain?: unknown[]; jobAction?: string;
}): void {
	if (params.isolation === undefined) {
		if (params.baseRevision !== undefined) throw new Error("baseRevision requires isolation=worktree.");
		return;
	}
	if (params.isolation !== "worktree") throw new Error("Unsupported isolation; use worktree or omit isolation.");
	if (params.agent !== "worker" || !params.task || params.interactive || params.background ||
		params.tasks !== undefined || params.chain !== undefined || params.jobAction !== undefined) {
		throw new Error("isolation=worktree supports only a foreground, one-shot {agent:'worker', task} run; interactive, background, parallel, chain, and job actions are not supported.");
	}
	if (params.baseRevision !== undefined && (!params.baseRevision.trim() || params.baseRevision.length > 1024 || params.baseRevision.includes("\0"))) {
		throw new Error("baseRevision must name a committed Git revision (1..1024 characters).");
	}
}

export async function createSubagentWorktree(options: {
	cwd: string; baseRevision?: string; signal?: AbortSignal;
}): Promise<SubagentWorktree> {
	options.signal?.throwIfAborted();
	// The existing Pi runner inherits its environment. Refuse hidden Git redirection
	// rather than let a child's git commands mutate another checkout despite its cwd.
	if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some((key) => process.env[key] !== undefined)) {
		throw new Error("Unset Git repository/index/config override environment variables before requesting worktree isolation; the child inherits its environment.");
	}
	const parentPath = await fs.realpath((await git(options.cwd, ["rev-parse", "--show-toplevel"], undefined, options.signal)).trim());
	const parentDirty = Boolean(await git(parentPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], undefined, options.signal));
	if (parentDirty && options.baseRevision === undefined) {
		throw new Error("Parent checkout is dirty. Set baseRevision explicitly to a committed revision (for example HEAD); uncommitted and untracked changes will not be copied.");
	}
	const revision = options.baseRevision ?? "HEAD";
	if (!revision.trim() || revision.length > 1024 || revision.includes("\0")) throw new Error("Invalid baseRevision.");
	const base = (await git(parentPath, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], undefined, options.signal)).trim();
	const commonDir = await fs.realpath((await git(parentPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], undefined, options.signal)).trim());
	// Private durable container under Git's common dir, never a temporary-directory lease.
	const artifactDirectory = await fs.mkdtemp(path.join(commonDir, "pi-subagent-worktree-"));
	const worktreePath = path.join(artifactDirectory, "workspace");
	try {
		await git(parentPath, ["worktree", "add", "--detach", worktreePath, base], undefined, options.signal);
		const gitDir = await fs.realpath((await git(worktreePath, ["rev-parse", "--absolute-git-dir"])).trim());
		const handle: SubagentWorktree = Object.freeze({ version: 1, path: worktreePath, parentPath, base, parentDirty, artifactDirectory });
		owned.set(handle, { commonDir, gitDir });
		await fs.writeFile(path.join(artifactDirectory, "ownership.json"), JSON.stringify(handle), { mode: 0o600, flag: "wx" });
		return handle;
	} catch {
		// Even failed/aborted add can have registered or populated a worktree. Never discard it.
		throw new Error(`Worktree setup failed; any partial workspace is retained at ${worktreePath}. Inspect git worktree list before manual recovery.`);
	}
}

const splitPaths = (text: string) => text.split("\0").filter(Boolean);
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none"];

/** Snapshot only. No deletion, merge, ref rewriting, or cleanup, even for clean HEADs. */
export async function finishSubagentWorktree(handle: SubagentWorktree): Promise<WorktreeReport> {
	const identity = owned.get(handle);
	if (!identity) throw new Error("Refusing unowned worktree: inspection/cleanup requires the original live ownership handle.");
	const report: WorktreeReport = {
		...handle, retained: true,
		retentionReason: "Automatic cleanup is disabled: preserve dirty/ignored files, detached commits, and reflogs for explicit human recovery.",
		inventory: { status: "incomplete", scope: "Superproject paths only; submodule contents are not traversed. Binary detection uses Git classification for tracked diffs only. Non-atomic post-run snapshot.", tracked: [], untracked: [], ignored: [], binaryTracked: [], inlineTruncated: false },
		patch: { status: "omitted", scope: "Tracked net base-to-working-tree text diff only; excludes untracked/ignored contents, binary payloads, and index-only differences. Local sensitive artifact; never inline or upload automatically." },
	};
	try {
		if (await fs.realpath(handle.path) !== handle.path || await fs.realpath(handle.artifactDirectory) !== handle.artifactDirectory ||
			await fs.realpath((await git(handle.path, ["rev-parse", "--absolute-git-dir"])).trim()) !== identity.gitDir ||
			await fs.realpath((await git(handle.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()) !== identity.commonDir ||
			await fs.realpath((await git(handle.path, ["rev-parse", "--show-toplevel"])).trim()) !== handle.path) {
			throw new Error("Workspace identity changed");
		}
		report.head = (await git(handle.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
		const tracked = new Set<string>();
		const binaryTracked = new Set<string>();
		// Include committed changes, index-only changes, and working changes, even if net base diff is empty.
		for (const revisions of [[handle.base, "HEAD"], ["--cached", "HEAD"], ["HEAD"], [handle.base]]) {
			for (const name of splitPaths(await git(handle.path, ["diff", ...diffOptions, "--name-only", "-z", ...revisions, "--"]))) tracked.add(name);
			for (const row of splitPaths(await git(handle.path, ["diff", ...diffOptions, "--numstat", "-z", ...revisions, "--"]))) {
				if (row.startsWith("-\t-\t")) binaryTracked.add(row.slice(4));
			}
		}
		const inventory = {
			tracked: [...tracked].sort(),
			untracked: splitPaths(await git(handle.path, ["ls-files", "--others", "--exclude-standard", "-z"])),
			ignored: splitPaths(await git(handle.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])),
			binaryTracked: [...binaryTracked].sort(),
		};
		const serialized = JSON.stringify({ version: 1, base: handle.base, head: report.head, ...inventory });
		if (Buffer.byteLength(serialized) > MAX_GIT_BYTES) throw new Error("Inventory exceeds artifact limit");
		const artifact = path.join(handle.artifactDirectory, "inventory.json");
		await fs.writeFile(artifact, serialized, { mode: 0o600, flag: "wx" });
		let inlineBudget = 16 * 1024;
		let inlineTruncated = false;
		const inline = (items: string[]) => {
			const retained: string[] = [];
			for (const item of items) {
				const bytes = Buffer.byteLength(JSON.stringify(item));
				if (retained.length >= MAX_INLINE_FILES || bytes > inlineBudget) { inlineTruncated = true; continue; }
				retained.push(item);
				inlineBudget -= bytes;
			}
			return retained;
		};
		report.inventory = {
			status: "complete", scope: report.inventory.scope, artifact,
			tracked: inline(inventory.tracked), untracked: inline(inventory.untracked),
			ignored: inline(inventory.ignored), binaryTracked: inline(inventory.binaryTracked), inlineTruncated,
		};
		try {
			const patch = await git(handle.path, ["diff", ...diffOptions, "--no-color", handle.base, "--"], MAX_PATCH_BYTES);
			if (patch.includes("\0")) throw new Error("Binary content forced into text diff");
			if (patch) {
				const artifact = path.join(handle.artifactDirectory, "tracked.patch");
				await fs.writeFile(artifact, patch, { mode: 0o600, flag: "wx" });
				report.patch = { ...report.patch, status: "available", path: artifact, bytes: Buffer.byteLength(patch) };
			} else report.patch.status = "empty";
		} catch { /* Oversized/failed patches remain explicitly omitted; workspace is the recovery source. */ }
	} catch {
		report.retentionReason += " Inspection failed, identity changed, or inventory exceeded bounds; evidence is incomplete.";
	}
	return report;
}
