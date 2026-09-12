import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { loadPrivateCorpus } from "../extensions/software-kb/corpus.ts";

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "software-kb-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kb = join(root, "knowledge/software-engineering");
  mkdirSync(join(kb, "corpus/pdf-downloads"), { recursive: true });
  mkdirSync(join(kb, "private"));
  const sources = JSON.stringify({ version: 1, sources: [{ id: "test-book", title: "Distinctive Engineering", tags: ["reliability"], access: "metadata_only", license_status: "copyrighted" }] });
  const mappings = JSON.stringify({ version: 1, documents: [{ file: "book.pdf", source_id: "test-book" }] });
  writeFileSync(join(kb, "sources.json"), sources);
  writeFileSync(join(kb, "documents.json"), mappings);
  const original = "%PDF-1.4 synthetic-original";
  writeFileSync(join(kb, "corpus/pdf-downloads/book.pdf"), original);
  writeFileSync(join(kb, "corpus/pdf-downloads/README.md"), "# DO NOT INDEX\n" + "recoverysecret ".repeat(30));
  writeFileSync(join(kb, "corpus/raw.pdf"), "# NOT MARKDOWN\n" + "binarysecret ".repeat(30));
  writeFileSync(join(kb, "corpus/source-cards.md"), "# Editorial card\n" + "Editorial overview of engineering books and testing. ".repeat(3));
  const index: any = { version: 1, catalog_sha256: digest(sources), documents_sha256: digest(mappings), documents: [{
    file: "book.pdf", source_id: "test-book", status: "indexed", sha256: digest(original), bytes: original.length,
    completeness: "unverified", redistribution_rights: "unverified", page_count: 4, method: "pdftotext",
    pages: [{ page: 1, text: "Quorum\nconsensus supports replicated writes and reads. " + "Synthetic fixture prose. ".repeat(20) }, { page: 3, text: "Short." }, { page: 4, text: "Third nonempty page." }],
  }] };
  const save = () => writeFileSync(join(kb, "private/index.json"), JSON.stringify(index));
  save();
  return { root, kb, index, save };
}

async function tools(root: string) {
  const extensionDir = join(root, "extensions/software-kb");
  cpSync(resolve("extensions/software-kb"), extensionDir, { recursive: true });
  const agentDir = join(root, "profile"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], extensions: [join(extensionDir, "index.ts")] }));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, noContextFiles: true,
    settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: false }) });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  return new Map(loader.getExtensions().extensions.flatMap(e => [...e.tools.values()]).map(t => [t.definition.name, t.definition]));
}

async function finalize(tool: any, args: any) {
  const model: any = { id: "fixture", name: "fixture", provider: "test", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1024 };
  const streamFn: any = () => {
    const stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", content: [{ type: "toolCall", id: "fixture", name: tool.name, arguments: args }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
    stream.push({ type: "done", reason: "toolUse", message }); return stream;
  };
  const messages = await runAgentLoop([{ role: "user", content: "fixture", timestamp: Date.now() }], { systemPrompt: "fixture", messages: [], tools: [{ ...tool,
    execute: (id: any, args: any, signal: any, update: any) => tool.execute(id, args, signal, update, {}) }] }, { model, convertToLlm: (m: any) => m, shouldStopAfterTurn: () => true }, () => {}, undefined, streamFn);
  return messages.find(m => m.role === "toolResult") as any;
}

test("SDK loads all KB tools; page citations, metadata distinction, read bounds, native schemas and errors", async t => {
  const f = fixture(t); const registered = await tools(f.root);
  assert.deepEqual([...registered.keys()].sort(), ["kb_read", "kb_search", "kb_sources"]);
  const search = (args: any) => finalize(registered.get("kb_search"), args);
  const result = await search({ query: "quorum consensus", content_only: true, mode: "exact" });
  assert.equal(result.isError, false); assert.equal(result.details.count, 1);
  assert.equal(result.details.results[0].page, 1);
  assert.equal(result.details.results[0].kind, "document_page");
  assert.equal(result.details.results[0].access, "private_local_text");
  assert.match(result.details.results[0].snippet, /Quorum consensus/);
  assert.match(result.content[0].text, /PDF page: 1/);
  const short = await search({ query: "Short.", content_only: true });
  assert.equal(short.details.results[0].page, 3);
  assert.equal((await search({ query: "reliability", content_only: true })).details.count, 0);
  assert.equal((await search({ query: "quorum", source_id: "unknown" })).details.count, 0);
  for (const query of ["recoverysecret", "binarysecret"]) assert.equal((await search({ query })).details.count, 0);
  const metadata = await search({ query: "Distinctive Engineering" });
  assert.equal(metadata.details.results[0].kind, "metadata");
  const cards = await search({ query: "Editorial overview", mode: "exact" });
  assert.equal(cards.details.results[0].kind, "source_card");
  const sources = await finalize(registered.get("kb_sources"), { access: "metadata_only" });
  assert.equal(sources.details.sources[0].access, "metadata_only");
  assert.equal(sources.details.sources[0].local_documents[0].indexed_pages, 3);
  const page = await finalize(registered.get("kb_read"), { source_id: "test-book", page: 1, max_chars: 200 });
  assert.equal(page.isError, false); assert.equal(page.details.truncated, true); assert.equal(page.details.text.length, 200);
  assert.equal((await finalize(registered.get("kb_read"), { source_id: "test-book", page: 2 })).isError, true);
  for (const args of [{ query: " " }, { query: "x", limit: 0 }, { query: "x", limit: 21 }, { query: "x".repeat(2001) }]) assert.equal((await search(args)).isError, true, `Expected invalid arguments: ${JSON.stringify(args).slice(0, 100)}`);
  assert.equal((await finalize(registered.get("kb_read"), { source_id: "test-book", page: 0 })).isError, true);
  // Same loaded extension must notice replacement and deletion immediately.
  f.index.documents[0].pages[0].text = "replacementtoken"; f.save();
  assert.equal((await search({ query: "replacementtoken", content_only: true })).details.count, 1);
  writeFileSync(join(f.kb, "corpus/pdf-downloads/book.pdf"), "changed");
  const stale = await search({ query: "replacementtoken", content_only: true });
  assert.equal(stale.details.count, 0); assert.match(stale.content[0].text, /stale/);
  assert.equal((await finalize(registered.get("kb_read"), { source_id: "test-book", page: 1 })).isError, true);
  rmSync(join(f.kb, "private/index.json"));
  assert.equal((await search({ query: "Distinctive Engineering" })).details.private_index, "missing");
});

test("private reader validates schema, mappings, physical page numbering and freshness", t => {
  const f = fixture(t);
  assert.equal(loadPrivateCorpus(f.kb).documents[0].pages.length, 3);
  const pristine = JSON.stringify(f.index);
  for (const mutate of [
    (x: any) => x.documents[0].pages[1].page = 1,
    (x: any) => x.documents[0].pages[1].page = 5,
    (x: any) => x.documents[0].pages[1].text = 12,
    (x: any) => x.documents[0].file = "../book.pdf",
    (x: any) => x.documents[0].source_id = "unknown",
    (x: any) => x.documents[0].status = "error",
    (x: any) => x.documents[0].method = "made-up",
    (x: any) => x.documents = [],
  ]) {
    const index = JSON.parse(pristine); mutate(index);
    writeFileSync(join(f.kb, "private/index.json"), JSON.stringify(index));
    assert.equal(loadPrivateCorpus(f.kb).state, "invalid");
  }
  f.save();
  writeFileSync(join(f.kb, "documents.json"), "{}");
  assert.equal(loadPrivateCorpus(f.kb).state, "stale");
  writeFileSync(join(f.kb, "private/index.json"), "{");
  assert.equal(loadPrivateCorpus(f.kb).state, "invalid");
});

test("missing originals, invalid recovered documents, OCR provenance, and symlinks are truthful", t => {
  const f = fixture(t);
  f.index.documents[0].method = "apple-vision-ocr"; f.save();
  assert.equal(loadPrivateCorpus(f.kb).documents[0].method, "apple-vision-ocr");
  rmSync(join(f.kb, "corpus/pdf-downloads/book.pdf"));
  assert.equal(loadPrivateCorpus(f.kb).documents[0].status, "stale");
  symlinkSync(join(f.kb, "sources.json"), join(f.kb, "corpus/pdf-downloads/book.pdf"));
  assert.equal(loadPrivateCorpus(f.kb).documents[0].status, "stale");
  rmSync(join(f.kb, "corpus/pdf-downloads/book.pdf"));
  f.index.documents[0].status = "missing"; f.index.documents[0].pages = []; f.save();
  assert.equal(loadPrivateCorpus(f.kb).documents[0].status, "missing");
  const original = "invalid historical PDF";
  writeFileSync(join(f.kb, "corpus/pdf-downloads/book.pdf"), original);
  Object.assign(f.index.documents[0], { status: "error", sha256: digest(original), error: "Not a PDF" }); f.save();
  const loaded = loadPrivateCorpus(f.kb);
  assert.equal(loaded.state, "ready"); assert.equal(loaded.documents[0].status, "error");
  rmSync(join(f.kb, "private/index.json"));
  symlinkSync(join(f.kb, "sources.json"), join(f.kb, "private/index.json"));
  assert.equal(loadPrivateCorpus(f.kb).state, "invalid");
});

test("distribution rules ignore private originals and index, but not integration code", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const path of ["knowledge/software-engineering/private/index.json", "knowledge/software-engineering/corpus/pdf-downloads/recovery.json", "knowledge/software-engineering/corpus/pdf-downloads/book.pdf"]) {
    execFileSync("git", ["check-ignore", "-q", path]);
  }
  assert.match(readFileSync(".gitignore", "utf8"), /knowledge\/software-engineering\/private\//);
});
