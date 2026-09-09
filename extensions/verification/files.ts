import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LIMITS, type Fingerprint, type InputScope } from "./types.ts";

export function relativePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 1024 || path.isAbsolute(value) || /[\x00-\x1f\\*?\[\]]/.test(value) || value.split("/").some(p => p === ".." || p === "")) throw new Error("Expected a bounded literal project-relative path (no globs/traversal)");
	return path.posix.normalize(value);
}
/** Reject symlinks at every component, including intermediate directories. Not an OS sandbox. */
export function projectPath(root: string, relative: string, allowMissing = false): string {
	const rel = relativePath(relative);
	let current = root;
	for (const part of rel.split("/")) {
		current = path.join(current, part);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink inputs/cwd/reports are unsupported"); }
		catch (e: any) { if (!(allowMissing && e.code === "ENOENT")) throw e; }
	}
	return current;
}
export function boundedRead(file: string, max: number): Buffer {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.size > max) throw new Error("Evidence is not a regular file or exceeds byte limit");
		const buffer = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const read = fs.readSync(fd, buffer, used, buffer.length - used, used);
			if (!read) break;
			used += read;
		}
		const after = fs.fstatSync(fd);
		if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Evidence changed while reading");
		return buffer.subarray(0, used);
	} finally { fs.closeSync(fd); }
}
export function decode(buffer: Buffer): string { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
export async function fingerprint(root: string, scope?: InputScope): Promise<Fingerprint> {
	let files = 0, bytes = 0, entries = 0;
	const deadline = performance.now() + LIMITS.fingerprintMs;
	if (!scope) return { status: "unknown", files, bytes, reason: "No declared input scope" };
	const hashes = new Map<string, string>();
	const seen = new Set<string>();
	const excluded = (rel: string) => scope.exclude.some(p => rel === p || p === "." || rel.startsWith(`${p}/`));
	const budget = () => { if (++entries > LIMITS.entries || performance.now() > deadline) throw new Error("Input enumeration/time limit exceeded"); };
	async function visit(rel: string, depth: number): Promise<void> {
		budget();
		if (depth > 64) throw new Error("Input directory depth limit exceeded");
		if (excluded(rel) || seen.has(rel)) return;
		seen.add(rel);
		const file = projectPath(root, rel);
		const stat = fs.lstatSync(file);
		if (stat.isDirectory()) {
			// Streaming enumeration bounds even a single huge directory.
			const dir = await fs.promises.opendir(file);
			for await (const entry of dir) await visit(rel === "." ? entry.name : `${rel}/${entry.name}`, depth + 1);
		} else {
			if (!stat.isFile() || ++files > LIMITS.files || stat.size > LIMITS.fileBytes || bytes + stat.size > LIMITS.sourceBytes) throw new Error("Unsupported input or source size/file limit exceeded");
			const data = boundedRead(file, LIMITS.fileBytes);
			bytes += data.length;
			if (bytes > LIMITS.sourceBytes) throw new Error("Source byte limit exceeded");
			hashes.set(rel, `${stat.mode & 0o111}:${createHash("sha256").update(data).digest("hex")}`);
		}
	}
	try {
		for (const rel of scope.paths) await visit(rel, 0);
		if (!files) throw new Error("Input scope contains no files");
		budget();
		const hash = createHash("sha256");
		for (const key of [...hashes.keys()].sort()) hash.update(JSON.stringify([key, hashes.get(key)]) + "\n");
		return { status: "known", sha256: hash.digest("hex"), files, bytes };
	} catch (e) { return { status: "unknown", files, bytes, reason: e instanceof Error ? e.message.slice(0, 300) : "Fingerprint failed" }; }
}
