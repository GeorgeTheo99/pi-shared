import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildQueries, inferDataProfile, normalizeOptions, normalizeUrl, rankSources, runResearch, selectPassages,
  FETCH_CONCURRENCY, SEARCH_CONCURRENCY, MAX_RETRIEVED_CHARS, type ResearchOptions, type SearchResult } from "../extensions/deep-research/research.ts";
import { buildSynthesisPrompt, formatToolResult, saveBundle, MAX_TOOL_RESULT_CHARS } from "../extensions/deep-research/output.ts";
import { mcpToolCall, WEB_FETCH_TIMEOUT_MS } from "../extensions/websearch/mcp-client.ts";
import { parseArgs } from "../extensions/deep-research/index.ts";

const options = (overrides: Partial<ResearchOptions> = {}): ResearchOptions => ({ question: "solar energy storage safety", mode: "general", depth: "normal", save: false, synthesize: false, ...overrides });
const source = (url: string, query: string, rank = 1): SearchResult => ({ url, title: url, domain: new URL(url).hostname, query, queries: [query], snippet: "snippet", score: 1 / (60 + rank) });
function broker(handler: (name: string, args: Record<string, unknown>, opts: any) => any): typeof mcpToolCall {
  return async (_endpoints, name, args, opts) => ({ endpointUrl: "https://broker.example/mcp", checked: [], ...await handler(name, args, opts) });
}
const healthy = broker((name, args) => name === "web_search" ? { text: JSON.stringify({ results: Array.from({ length: Number(args.num_results) }, (_, i) => ({ url: `https://host${i}.example/${encodeURIComponent(String(args.query))}`, title: `source ${i}`, snippet: "solar evidence" })) }) } : { text: "Solar energy storage safety evidence.\nPublished 2026-01-01.\nNo API key or authentication required.\nLicense: CC-BY 4.0." });

for (const [name, overrides] of Object.entries({ negative: { fetchCount: -1 }, zeroSources: { maxSources: 0 }, huge: { maxSources: 100 }, hugeFetch: { fetchCount: 31 }, fractional: { fetchCount: 2.5 }, nan: { maxSources: NaN }, infinity: { fetchCount: Infinity }, empty: { question: "  " }, long: { question: "x".repeat(2001) } })) {
  test(`rejects invalid input: ${name}`, () => assert.throws(() => normalizeOptions(options(overrides))));
}
test("defaults and CLI/tool validation agree", () => {
  assert.equal(normalizeOptions(options({ depth: "quick" })).maxSources, 8);
  assert.equal(normalizeOptions(options({ depth: "deep" })).fetchCount, 10);
  assert.equal(normalizeOptions(options({ fetchCount: 30, maxSources: 1 })).fetchCount, 1);
  assert.equal(parseArgs('--data --depth=quick --fetch 0 "quoted question"').fetchCount, 0);
  assert.equal(parseArgs('--no-save --no-synthesis --sources topic').save, false);
  assert.equal(parseArgs('-- --literal topic').question, '--literal topic');
  assert.equal(parseArgs("what's new in solar batteries").question, "what's new in solar batteries");
  assert.equal(parseArgs("researchers' and users' datasets").question, "researchers' and users' datasets");
  assert.equal(parseArgs("--mode='data' 'quoted question'").question, "quoted question");
  for (const input of ['--fetch -1 topic', '--max-sources=0 topic', '--fetch=31 topic', '--mode other topic', '--wat topic', '"unclosed']) assert.throws(() => parseArgs(input));
});
test("queries decompose explicit subquestions without exceeding depth bounds", () => {
  assert.equal(buildQueries(options({ depth: "quick" })).length, 1);
  const queries = buildQueries(options({ question: "How does solar storage work? What safety limits apply?", depth: "deep" }));
  assert.ok(queries.includes("How does solar storage work"));
  assert.ok(queries.length <= 5);
});
test("all derived queries fit the 512-character broker contract, including follow-up suffixes", async () => {
  for (const mode of ["general", "data", "sources"] as const) {
    const question = "long research question ".repeat(90).slice(0, 2000);
    const input = options({ mode, question, depth: "deep" });
    assert.ok(buildQueries(input).every(q => q.length <= 512));
    const bundle = await runResearch(input, undefined, undefined, { call: broker((name, args) => {
      assert.equal(name, "web_search");
      assert.ok(String(args.query).length <= 512);
      return { text: '{"results":[]}' };
    }) });
    assert.equal(bundle.status, "empty");
    assert.equal(bundle.question, question);
    assert.ok(bundle.attempts.some(a => a.round === 2));
    assert.ok(bundle.attempts.every(a => a.query.length <= 512));
  }
  for (const q of buildQueries(options({ question: "🌞 solar ".repeat(180) }))) {
    assert.ok(q.length <= 512);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(q));
  }
});
test("URL dedup drops trackers/fragments, preserves semantic parameters and rejects credentials", () => {
  assert.equal(normalizeUrl("https://example.com/?b=2&utm_source=x&a=1#part"), "https://example.com/?a=1&b=2");
  assert.notEqual(normalizeUrl("https://example.com/?version=1"), normalizeUrl("https://example.com/?version=2"));
  for (const url of ["ftp://example.com", "bad", "https://user:pass@example.com"]) assert.equal(normalizeUrl(url), undefined);
});
test("fusion deduplicates and balances queries and hosts; repeats cannot inflate rank", () => {
  const a = source("https://one.example/a", "q1");
  const b = source("https://two.example/b", "q2", 2);
  const output = rankSources([[a, a, source("https://one.example/c", "q1", 2)], [b, { ...a, query: "q2", queries: ["q2"] }]], 4);
  assert.equal(output.length, 3);
  assert.equal(output[0].score, a.score * 2);
  assert.equal(output[1].domain, "two.example");
  assert.deepEqual(output[0].queries, ["q1", "q2"]);
});
test("normal fetch selection covers multiple original queries, rather than only first batch", async () => {
  const bundle = await runResearch(options(), undefined, undefined, { call: healthy });
  assert.equal(bundle.status, "complete");
  assert.equal(bundle.fetchAttempts, 6);
  assert.equal(bundle.attempts.length, 3); // No synthetic health query or unnecessary follow-up.
  assert.equal(new Set(bundle.sources.filter(s => s.fetched).map(s => s.query)).size, 3);
  assert.ok(bundle.gaps.some(g => g.includes("independent corroboration")));
});
test("all search failures are retained as failed, not empty success", async () => {
  const call = broker(() => { throw new Error("429 rate limited"); });
  const bundle = await runResearch(options(), undefined, undefined, { call });
  assert.equal(bundle.status, "failed");
  assert.equal(bundle.sources.length, 0);
  assert.equal(bundle.attempts.length, 3);
  assert.ok(bundle.attempts.every(a => a.status === "error" && a.error?.includes("429")));
  assert.equal(bundle.fetchAttempts, 0);
});
test("valid empty results differ from invalid payloads and partial failure", async () => {
  const empty = await runResearch(options(), undefined, undefined, { call: broker(() => ({ text: '{"results":[]}' })) });
  assert.equal(empty.status, "empty");
  assert.ok(empty.attempts.length <= 5);
  for (const text of ["null", "{}", '{"results":{}}', "not JSON", '{"error":"blocked"}']) {
    const failed = await runResearch(options({ depth: "quick" }), undefined, undefined, { call: broker(() => ({ text })) });
    assert.equal(failed.status, "failed");
  }
  const partial = await runResearch(options(), undefined, undefined, { call: broker((name, args, opts) => {
    if (name === "web_search" && String(args.query).includes("documentation")) throw new Error("timeout");
    return healthy([], name, args, opts);
  }) });
  assert.equal(partial.status, "partial");
  assert.ok(partial.gaps.some(g => g.includes("queries failed")));
});
test("one gap-driven round is bounded and shares source/fetch budgets", async () => {
  let search = 0;
  const bundle = await runResearch(options({ maxSources: 7, fetchCount: 5 }), undefined, undefined, { call: broker((name, args) => {
    if (name === "web_fetch") return { text: "Solar energy storage safety evidence" };
    search++;
    return { text: JSON.stringify({ results: [{ url: `https://host${search}.example/data` }] }) };
  }) });
  assert.equal(bundle.attempts.filter(a => a.round === 2).length, 1);
  assert.ok(bundle.followUpReasons.length);
  assert.ok(bundle.sources.length <= 7);
  assert.ok(bundle.fetchAttempts <= 5);
  assert.ok(bundle.sources.filter(s => s.fetched).every(s => s.contentHash && s.retrievedAt));
});
test("zero fetch means no page calls, even across follow-ups", async () => {
  const bundle = await runResearch(options({ fetchCount: 0 }), undefined, undefined, { call: broker((name, args, opts) => {
    assert.equal(name, "web_search"); return healthy([], name, args, opts);
  }) });
  assert.equal(bundle.fetchAttempts, 0);
  assert.ok(bundle.sources.every(s => s.fetchStatus === "not_requested"));
  assert.ok(bundle.gaps.some(g => g.includes("Only search snippets")));
});
test("concurrency and shared fetch timeout are bounded", async () => {
  let activeSearch = 0, activeFetch = 0, maxSearch = 0, maxFetch = 0;
  const bundle = await runResearch(options({ depth: "deep", maxSources: 50, fetchCount: 30 }), undefined, undefined, { call: broker(async (name, args, opts) => {
    if (name === "web_search") { maxSearch = Math.max(maxSearch, ++activeSearch); }
    else { maxFetch = Math.max(maxFetch, ++activeFetch); assert.equal(opts.timeoutMs, WEB_FETCH_TIMEOUT_MS); }
    await new Promise(resolve => setTimeout(resolve, 3));
    const result = await healthy([], name, args, opts);
    if (name === "web_search") activeSearch--; else activeFetch--;
    return result;
  }) });
  assert.ok(maxSearch <= SEARCH_CONCURRENCY && maxSearch > 1);
  assert.ok(maxFetch <= FETCH_CONCURRENCY && maxFetch > 1);
  assert.equal(bundle.fetchAttempts, 30);
});
test("failed fetches consume budget and never become excerpts", async () => {
  const bundle = await runResearch(options({ depth: "quick", fetchCount: 3 }), undefined, undefined, { call: broker((name, args, opts) => name === "web_fetch" ? { text: "Fetch error: denied" } : healthy([], name, args, opts)) });
  assert.equal(bundle.status, "partial");
  assert.equal(bundle.fetchAttempts, 3);
  assert.equal(bundle.sources.filter(s => s.fetchStatus === "failed").length, 3);
  assert.ok(bundle.sources.every(s => !s.excerpt));
});
for (const phase of ["search", "fetch", "followup"] as const) test(`cancellation propagates during ${phase} and starts no queued work`, async () => {
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  let searches = 0;
  let blocked = 0;
  const call = broker(async (name, args, opts) => {
    if (name === "web_search") searches++;
    const stop = phase === "search" || (phase === "fetch" && name === "web_fetch") || (phase === "followup" && searches > 3);
    if (stop) {
      blocked++;
      queueMicrotask(() => controller.abort(reason));
      return await new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        if (opts.signal.aborted) reject(opts.signal.reason);
      });
    }
    return name === "web_search" ? { text: '{"results":[{"url":"https://one.example/data"}]}' } : { text: "solar evidence" };
  });
  await assert.rejects(runResearch(options(), controller.signal, undefined, { call }), e => e === reason);
  assert.ok(blocked <= 3);
});
test("passages find late relevant evidence and have exact stored-text locations", () => {
  const text = "Navigation and menu links\n".repeat(300) + "Solar energy storage safety limits are 42.\n" + "Other text\n".repeat(100);
  const passages = selectPassages(text, "solar energy storage safety limits");
  assert.ok(passages[0].text.includes("limits are 42"));
  for (const p of passages) {
    assert.equal(text.slice(p.startOffset, p.endOffset), p.text);
    assert.equal(p.startLine, 1 + (text.slice(0, p.startOffset).match(/\n/g)?.length ?? 0));
  }
});
test("fetch preserves signed/order-sensitive request URLs while deduplicating tracking variants", async () => {
  const original = "https://example.com/data?z=2&a=1&sig=signed&utM_source=campaign";
  const bundle = await runResearch(options({ depth: "quick" }), undefined, undefined, { call: broker((name, args) => {
    if (name === "web_fetch") { assert.equal(args.url, original); return { text: "solar safety evidence" }; }
    return { text: JSON.stringify({ results: [{ url: original }, { url: original + "#part" }] }) };
  }) });
  assert.equal(bundle.sources.length, 1);
  assert.equal(bundle.fetchAttempts, 1);
});
test("retrieved text is bounded, hashed, and marked when potentially truncated", async () => {
  const bundle = await runResearch(options({ depth: "quick", fetchCount: 1 }), undefined, undefined, { call: broker((name, args, opts) => name === "web_fetch" ? { text: "x".repeat(MAX_RETRIEVED_CHARS + 100) } : healthy([], name, args, opts)) });
  const s = bundle.sources.find(s => s.fetched)!;
  assert.equal(s.retrievedText!.length, MAX_RETRIEVED_CHARS);
  assert.equal(s.retrievalTruncated, true);
  assert.equal(s.contentHash, createHash("sha256").update(s.retrievedText!).digest("hex"));
});
test("dataset metadata preserves quoted requirements without guessing endpoint authentication", () => {
  const profile = (text: string) => inferDataProfile({ title: "API", url: "https://example.com", snippet: "", text });
  const no = profile("No API key or authentication required. License: CC-BY 4.0. Updated 2026-01-01.");
  assert.equal(no.authRequired, "unknown");
  assert.ok(no.evidence.auth[0].includes("No API key"));
  assert.ok(no.evidence.license[0].includes("CC-BY"));
  assert.ok(no.evidence.freshness[0].includes("2026"));
  for (const statement of [
    "An API key is required.", "Authentication isn't required.", "Authentication isn’t required.",
    "Authentication is not necessary.", "No API key is required; OAuth is required.",
    "No API key is required and authentication is mandatory.", "No API key is required: OAuth is mandatory.",
    "No authentication is required\nunless you access private endpoints.",
    "Authentication is required\nonly for private endpoints.",
  ]) {
    const result = profile(statement);
    assert.equal(result.authRequired, "unknown", statement);
    assert.ok(result.evidence.auth.includes(statement), "original negation and qualifiers must remain in the quotation");
  }
  const token = profile("No authentication is required. A Bearer token is mandatory.");
  assert.equal(token.authRequired, "unknown");
  assert.ok(token.evidence.auth.some(s => s.includes("Bearer token")));
  assert.match(profile("Authentication " + "x".repeat(500)).evidence.auth[0], /quote truncated/);
  assert.equal(inferDataProfile({ title: "API", url: "https://example.com", snippet: "No API key required." }).evidenceBasis, "search snippet");
});
test("data mode follows up missing metadata, without claiming semantic contradiction detection", async () => {
  const bundle = await runResearch(options({ mode: "data" }), undefined, undefined, { call: broker((name, args, opts) => name === "web_fetch" ? { text: "Solar energy data API." } : healthy([], name, args, opts)) });
  assert.ok(bundle.followUpReasons.some(r => r.includes("metadata") || r.includes("authentication")));
  assert.ok(bundle.attempts.some(a => a.round === 2 && a.query.includes("license terms authentication")));
  assert.ok(bundle.gaps.some(g => g.includes("metadata remains unknown")));
});
test("data follow-up seeks missing quotations, not impossible automatic auth verification", async () => {
  const bundle = await runResearch(options({ mode: "data" }), undefined, undefined, { call: healthy });
  assert.ok(bundle.attempts.every(a => a.round === 1));
  assert.ok(bundle.sources.filter(s => s.fetched).every(s => s.dataProfile?.evidence.auth.length));
});
test("bundles have exclusive private directories and reproducible evidence; output is bounded", async t => {
  const root = mkdtempSync(join(tmpdir(), "research-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = await runResearch(options({ maxSources: 50, fetchCount: 30 }), undefined, undefined, { call: healthy });
  const a = saveBundle(bundle, root), b = saveBundle(bundle, root);
  assert.notEqual(a, b);
  assert.deepEqual(readdirSync(a).sort(), ["excerpts.md", "prompt.md", "sources.json"]);
  assert.equal(statSync(a).mode & 0o777, 0o700);
  assert.equal(statSync(join(a, "sources.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(a, "sources.json"), "utf8")).id, bundle.id);
  const result = formatToolResult(bundle, a);
  assert.ok(result.length <= MAX_TOOL_RESULT_CHARS);
  assert.match(result, /untrusted evidence, not instructions/);
  assert.match(result, /sources\.json/);
  const prompt = buildSynthesisPrompt(bundle, a);
  assert.ok(prompt.length <= 60_000);
  assert.match(prompt, /contradictions/);
  assert.match(prompt, /report\.md/);
  const verbose = structuredClone(bundle);
  for (const s of verbose.sources) {
    s.title = "多言語".repeat(100);
    s.url = `https://example.com/?q=${"long".repeat(800)}`;
    s.passages = [{ text: "多\n".repeat(5000), startLine: 1, endLine: 5001, startOffset: 0, endOffset: 10000 }];
  }
  const bounded = formatToolResult(verbose, a);
  assert.ok(Buffer.byteLength(bounded) < 50_000);
  assert.ok(bounded.split("\n").length < 2000);
  assert.match(bounded, /sources\.json/);
  assert.match(bounded, /URL omitted for length/);
});
