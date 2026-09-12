import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadPrivateCorpus } from "../extensions/software-kb/corpus.ts";

// Opt-in only: CI must not depend on or print private book content.
test("local recovered corpus: every indexed document is searchable and page-readable through installed SDK", {
  skip: process.env.PI_KB_LIVE_SMOKE !== "1", timeout: 120000,
}, async t => {
  const root = resolve("knowledge/software-engineering");
  const corpus = loadPrivateCorpus(root);
  assert.equal(corpus.state, "ready");
  const indexed = corpus.documents.filter(d => d.status === "indexed");
  assert.ok(indexed.length > 0);
  const profile = mkdtempSync(join(tmpdir(), "kb-live-sdk-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const agentDir = join(profile, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [resolve("extensions/software-kb/index.ts")] }));
  const loader = new DefaultResourceLoader({ cwd: profile, agentDir, noContextFiles: true,
    settingsManager: SettingsManager.create(profile, agentDir, { projectTrusted: false }) });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const tools = new Map(loader.getExtensions().extensions.flatMap(e => [...e.tools.values()]).map(t => [t.definition.name, t.definition]));
  const call = async (name: string, args: any) => tools.get(name)!.execute("live", args, undefined, undefined, { cwd: profile } as any) as Promise<any>;
  const statuses = await call("kb_sources", {});
  assert.equal(statuses.details.private_index, "ready");
  for (const doc of indexed) {
    const pages = doc.pages.filter(p => p.text.length > 400);
    assert.ok(pages.length, `${doc.source_id} has substantive pages`);
    const page = pages[Math.floor(pages.length / 2)];
    const normalized = page.text.replace(/\s+/g, " ").trim();
    const phrases = normalized.match(/[A-Za-z][A-Za-z ,'-]{70,150}/g);
    assert.ok(phrases?.length, `${doc.source_id} has a searchable phrase`);
    const query = phrases[Math.floor(phrases.length / 2)].trim();
    const search = await call("kb_search", { query, source_id: doc.source_id, content_only: true, mode: "exact", limit: 20 });
    assert.ok(search.details.results.some((r: any) => r.page === page.page && r.kind === "document_page"), `${doc.source_id}: exact phrase locates its PDF page`);
    const read = await call("kb_read", { source_id: doc.source_id, page: page.page, file: doc.file, max_chars: 12000 });
    assert.equal(read.details.text, page.text.slice(0, 12000));
    assert.equal(read.details.method, doc.method);
    assert.ok(statuses.details.sources.find((s: any) => s.id === doc.source_id).local_documents.some((d: any) => d.file === doc.file && d.indexed_pages === doc.pages.length));
    t.diagnostic(`${doc.source_id}: ${doc.pages.length}/${doc.page_count} pages, ${doc.method}; search/read passed`);
  }
  const recovery = JSON.parse(readFileSync(join(root, "corpus/pdf-downloads/recovery.json"), "utf8"));
  const { createHash } = await import("node:crypto");
  for (const file of recovery.files) {
    const data = readFileSync(join(root, "corpus/pdf-downloads", file.file));
    assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256);
  }
  t.diagnostic(`${indexed.length} indexed documents verified; ${recovery.files.length} recovered originals still hash-match.`);
});
