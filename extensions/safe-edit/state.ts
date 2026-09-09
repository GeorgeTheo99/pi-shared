import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BYTES = 1024 * 1024;
const TTL = 10 * 60 * 1000;
export type Replacement = { oldText: string; newText: string };
export type MutationQueue = <T>(file: string, operation: () => Promise<T>) => Promise<T>;
export const digest = (value: Uint8Array | string) => crypto.createHash("sha256").update(value).digest("hex");
interface Preview {
	id: string; workspace: string; requestedPath: string; file: string;
	before: string; after: string; hash: string; afterHash: string; mode: number;
	dev: number; ino: number; createdAt: number;
}
async function scopedFile(workspace: string, requested: string) {
	const root = await fs.realpath(workspace);
	const file = await fs.realpath(path.resolve(root, requested));
	if (file !== root && !file.startsWith(root + path.sep)) throw new Error("safe_edit only edits files within the caller workspace");
	return { root, file };
}
async function readText(file: string) {
	const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1) throw new Error("Require a regular single-link text file at most 1 MiB");
		if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o7000)) throw new Error("Require caller-owned files without special permission bits");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const bytes = buffer.subarray(0, length);
		if (bytes.length > MAX_BYTES || bytes.includes(0)) throw new Error("Oversized or binary file");
		const text = bytes.toString("utf8");
		if (!Buffer.from(text).equals(bytes)) throw new Error("File is not valid UTF-8");
		return { stat, bytes, text };
	} finally { await handle.close(); }
}
export function replaceExactly(text: string, edits: Replacement[]): string {
	if (!Array.isArray(edits) || edits.length === 0 || edits.length > 100) throw new Error("Require 1–100 exact replacements");
	if (Buffer.byteLength(JSON.stringify(edits)) > MAX_BYTES) throw new Error("Replacement input exceeds 1 MiB");
	const spans = edits.map(edit => {
		if (typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string" || edit.newText.includes("\0")) throw new Error("Invalid exact replacement");
		const at = text.indexOf(edit.oldText);
		if (at < 0 || text.indexOf(edit.oldText, at + 1) >= 0) throw new Error("oldText must match exactly once in the original file (no fuzzy/newline normalization)");
		return { start: at, end: at + edit.oldText.length, text: edit.newText };
	}).sort((a,b) => a.start-b.start);
	for (let i=1; i<spans.length; i++) if (spans[i].start < spans[i-1].end) throw new Error("Replacements overlap");
	let result = text;
	for (const span of spans.reverse()) result = result.slice(0, span.start) + span.text + result.slice(span.end);
	if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Result exceeds 1 MiB");
	if (Buffer.from(result).toString("utf8") !== result) throw new Error("Replacement contains invalid Unicode");
	return result;
}
/** Session-only previews, never a recovery journal or a cross-process lock. */
export class SafeEditState {
	private previews = new Map<string, Preview>();
	private prune() { for (const [id,p] of this.previews) if (Date.now()-p.createdAt > TTL) this.previews.delete(id); }
	clear() { this.previews.clear(); }
	async preview(workspace: string, requested: string, edits: Replacement[], expectedHash?: string) {
		this.prune();
		const { root, file } = await scopedFile(workspace, requested);
		const { stat, bytes, text } = await readText(file);
		const hash = digest(bytes);
		if (expectedHash !== undefined && expectedHash !== hash) throw new Error("Stale input: expected SHA-256 does not match");
		const after = replaceExactly(text, edits);
		if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
		const p: Preview = { id: `edit_${crypto.randomUUID()}`, workspace: root, requestedPath: requested, file, before: text, after, hash, afterHash: digest(after), mode: stat.mode, dev: stat.dev, ino: stat.ino, createdAt: Date.now() };
		this.previews.set(p.id, p);
		return { ...p };
	}
	async apply(workspace: string, id: string, expectedHash: string, queue: MutationQueue, signal?: AbortSignal) {
		this.prune();
		const p = this.previews.get(id);
		if (!p || p.workspace !== await fs.realpath(workspace)) throw new Error("Unknown or expired preview in this workspace");
		if (expectedHash !== p.hash) throw new Error("Expected SHA-256 must match the preview");
		return queue(p.file, async () => {
			const check = async () => {
				if (signal?.aborted) throw new Error("Edit aborted before application");
				const currentPath = await scopedFile(workspace, p.requestedPath);
				if (currentPath.file !== p.file) throw new Error("Stale input: symlink target changed");
				const current = await readText(p.file);
				if (current.stat.dev !== p.dev || current.stat.ino !== p.ino || current.stat.mode !== p.mode || digest(current.bytes) !== p.hash) throw new Error("Stale input: file or permissions changed since preview");
			};
			await check();
			if (p.hash === p.afterHash) { this.previews.delete(id); return { applied: false, unchanged: true, path: p.file, sha256: p.hash }; }
			await fs.access(p.file, fs.constants.W_OK);
			const tmp = path.join(path.dirname(p.file), `.pi-safe-edit-${crypto.randomUUID()}.tmp`);
			try {
				const handle = await fs.open(tmp, "wx", 0o600);
				try { await handle.writeFile(p.after, "utf8"); await handle.chmod(p.mode & 0o777); await handle.sync(); }
				finally { await handle.close(); }
				await check();
				if (signal?.aborted) throw new Error("Edit aborted before application");
				// A cooperating Pi queue protects the check/rename, not other processes.
				await fs.rename(tmp, p.file);
				this.previews.delete(id);
				return { applied: true, path: p.file, before_sha256: p.hash, sha256: p.afterHash };
			} finally { await fs.unlink(tmp).catch((error: any) => { if (error?.code !== "ENOENT") throw error; }); }
		});
	}
}
