import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface PrivateDocument {
	file: string;
	source_id: string;
	status: "indexed" | "missing" | "error" | "needs_ocr" | "stale";
	page_count: number;
	pages: Array<{ page: number; text: string }>;
	sha256?: string;
	bytes?: number;
	method?: string;
	note?: string;
	error?: string;
	warning?: string | null;
	completeness: "unverified";
	redistribution_rights: "unverified";
}

export interface PrivateCorpus {
	state: "ready" | "missing" | "invalid" | "stale";
	warning?: string;
	documents: PrivateDocument[];
}

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;

function readRegular(path: string, limit: number): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > limit) throw new Error("Expected a bounded regular file");
	const data = readFileSync(path);
	if (data.length > limit) throw new Error("File exceeds size limit");
	return data;
}

/** Reload on each tool call. Missing/changed originals never leave stale passages searchable. */
export function loadPrivateCorpus(kbRoot: string): PrivateCorpus {
	const directory = join(kbRoot, "private");
	const indexPath = join(directory, "index.json");
	if (!existsSync(directory)) return { state: "missing", documents: [] };
	try {
		if (!lstatSync(directory).isDirectory()) throw new Error("Private directory must not be a symlink");
		if (!existsSync(indexPath)) return { state: "missing", documents: [] };
		const index = JSON.parse(readRegular(indexPath, 64 * 1024 * 1024).toString("utf8"));
		if (index.version !== 1 || !Array.isArray(index.documents) || index.documents.length > 200) {
			throw new Error("Unsupported private index format");
		}
		const catalog = readRegular(join(kbRoot, "sources.json"), 1024 * 1024);
		const mappings = readRegular(join(kbRoot, "documents.json"), 1024 * 1024);
		if (hash(catalog) !== index.catalog_sha256 || hash(mappings) !== index.documents_sha256) {
			return { state: "stale", warning: "Private index catalog/mappings changed; rerun ingestion.", documents: [] };
		}
		const sources = new Set(JSON.parse(catalog.toString("utf8")).sources.map((s: { id: string }) => s.id));
		const expected = new Map<string, string>(JSON.parse(mappings.toString("utf8")).documents.map((d: { file: string; source_id: string }) => [d.file, d.source_id]));
		if (index.documents.length !== expected.size) throw new Error("Incomplete private index inventory");
		const seen = new Set<string>();
		const documents: PrivateDocument[] = [];
		let totalBytes = 0;
		for (const doc of index.documents) {
			if (typeof doc.file !== "string" || basename(doc.file) !== doc.file || !doc.file.endsWith(".pdf") ||
				seen.has(doc.file) || expected.get(doc.file) !== doc.source_id || !sources.has(doc.source_id) ||
				!["indexed", "missing", "error", "needs_ocr"].includes(doc.status) ||
				!Number.isInteger(doc.page_count) || doc.page_count < 0 || doc.page_count > 10000 ||
				!Array.isArray(doc.pages) || doc.pages.length > doc.page_count ||
				doc.completeness !== "unverified" || doc.redistribution_rights !== "unverified" ||
				(doc.status !== "indexed" && doc.pages.length !== 0) ||
				(doc.status === "indexed" && (doc.pages.length === 0 || !["pdftotext", "apple-vision-ocr"].includes(doc.method))) ||
				(doc.sha256 !== undefined && (typeof doc.sha256 !== "string" || !sha256.test(doc.sha256)))) {
				throw new Error("Invalid private document record");
			}
			for (const field of ["note", "error", "warning"]) {
				if (doc[field] != null && (typeof doc[field] !== "string" || doc[field].length > 2000)) throw new Error("Invalid document note");
			}
			let previous = 0;
			for (const page of doc.pages) {
				if (!Number.isInteger(page.page) || page.page <= previous || page.page > doc.page_count ||
					typeof page.text !== "string" || !page.text.trim() || page.text.length > 1024 * 1024) {
					throw new Error("Invalid private page record");
				}
				previous = page.page;
			}
			seen.add(doc.file);
			const originalDirectory = join(kbRoot, "corpus", "pdf-downloads");
			try {
				if (!lstatSync(originalDirectory).isDirectory()) throw new Error("Original directory must not be a symlink");
				const originalPath = join(originalDirectory, doc.file);
				totalBytes += lstatSync(originalPath).size;
				if (totalBytes > 512 * 1024 * 1024) throw new Error("Originals exceed 512 MiB verification budget");
				const original = readRegular(originalPath, 128 * 1024 * 1024);
				if (hash(original) !== doc.sha256) throw new Error("Original PDF changed");
			} catch {
				if (doc.status !== "missing" || existsSync(join(originalDirectory, doc.file))) {
					doc.status = "stale";
					doc.pages = [];
					doc.error = "Original PDF missing, changed, unsafe, or too large; rerun ingestion.";
				}
			}
			documents.push(doc);
		}
		return { state: "ready", documents };
	} catch {
		return { state: "invalid", warning: "Private index invalid or unreadable; rerun ingestion. No private passages were loaded.", documents: [] };
	}
}
