import { createHash, randomUUID } from "node:crypto";
import {
  mcpToolCall, readConfiguredMcpUrls, throwIfCallerAborted,
  WEB_FETCH_TIMEOUT_MS, WEB_SEARCH_TIMEOUT_MS,
} from "../websearch/mcp-client.js";

export interface ResearchOptions {
  mode: "general" | "data" | "sources";
  depth: "quick" | "normal" | "deep";
  maxSources?: number;
  fetchCount?: number;
  save: boolean;
  synthesize: boolean;
  question: string;
}
export type ResolvedOptions = ResearchOptions & { maxSources: number; fetchCount: number };
export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine?: string;
  query: string;
  queries: string[];
  score: number;
}
export interface Passage {
  text: string;
  startLine: number;
  endLine: number;
  /** UTF-16 offsets into retrievedText, end-exclusive; not original HTML offsets. */
  startOffset: number;
  endOffset: number;
}
export interface DataProfile {
  likelyDataSource: boolean;
  accessMethod: string;
  formats: string[];
  authRequired: "yes" | "no" | "unknown";
  license: string;
  freshness: string;
  evidenceBasis: "fetched text" | "search snippet";
  evidence: { auth: string[]; license: string[]; freshness: string[] };
  notes: string[];
}
export interface SourceRecord extends SearchResult {
  fetched: boolean;
  fetchStatus: "fetched" | "failed" | "not_requested";
  error?: string;
  retrievedAt?: string;
  retrievedText?: string;
  contentHash?: string;
  retrievalTruncated?: boolean;
  excerpt?: string;
  passages?: Passage[];
  dataProfile?: DataProfile;
}
export interface SearchAttempt {
  query: string;
  round: number;
  status: "ok" | "empty" | "error";
  resultCount: number;
  durationMs: number;
  endpoint?: string;
  error?: string;
}
export interface ResearchBundle {
  id: string;
  createdAt: string;
  question: string;
  mode: ResearchOptions["mode"];
  depth: ResearchOptions["depth"];
  status: "complete" | "partial" | "empty" | "failed";
  searchProvider: "mcp";
  searchEndpoint: string;
  queries: string[];
  attempts: SearchAttempt[];
  followUpReasons: string[];
  gaps: string[];
  durationMs: number;
  fetchAttempts: number;
  sources: SourceRecord[];
}

export const MAX_RETRIEVED_CHARS = 20_000;
export const MAX_QUESTION_CHARS = 2000;
// Standalone local-search contract; reserve suffix space rather than losing query intent.
export const MAX_QUERY_CHARS = 512;
export const SEARCH_CONCURRENCY = 3;
export const FETCH_CONCURRENCY = 3;

export function normalizeOptions(options: ResearchOptions): ResolvedOptions {
  if (!["general", "data", "sources"].includes(options.mode)) throw new Error("Invalid research mode");
  if (!["quick", "normal", "deep"].includes(options.depth)) throw new Error("Invalid research depth");
  if (typeof options.question !== "string" || !options.question.trim() || options.question.length > MAX_QUESTION_CHARS) {
    throw new Error(`Research question must contain 1–${MAX_QUESTION_CHARS} characters`);
  }
  const defaults = { quick: [8, 3], normal: [14, 6], deep: [24, 10] }[options.depth];
  const maxSources = options.maxSources ?? defaults[0];
  const fetchCount = options.fetchCount ?? defaults[1];
  for (const [name, value, min, max] of [["max_sources", maxSources, 1, 50], ["fetch_count", fetchCount, 0, 30]] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return { ...options, question: options.question.trim(), maxSources, fetchCount: Math.min(fetchCount, maxSources) };
}

export function boundedQuery(question: string, suffix = ""): string {
  const tail = suffix ? ` ${suffix}` : "";
  const budget = MAX_QUERY_CHARS - tail.length;
  const head = Math.floor((budget - 3) * 0.7);
  const prefix = question.slice(0, head).replace(/[\uD800-\uDBFF]$/, "");
  const ending = question.slice(-(budget - head - 3)).replace(/^[\uDC00-\uDFFF]/, "");
  const body = question.length <= budget ? question : `${prefix} … ${ending}`;
  return body + tail;
}

export function buildQueries(options: ResearchOptions): string[] {
  const q = options.question;
  const query = (suffix = "") => boundedQuery(q, suffix);
  const facets = q.split(/[;\n]+|\?\s+/).map(s => s.trim()).filter(s => s.length >= 12 && s !== q).slice(0, 3);
  const queries = options.mode === "data" ? [
    query("dataset OR database OR catalog"), query("API OR developer documentation"),
    query("CSV OR JSON OR parquet OR download"), query("open data OR government data OR benchmark"), query("license terms data source"),
  ] : options.mode === "sources" ? [
    query("official documentation OR specification OR standard"), query("authoritative source OR primary source"),
    query("site:gov OR site:edu OR site:org"), query("GitHub documentation reference"),
  ] : [query(), ...facets.map(f => boundedQuery(f)), query("official documentation"), query("analysis comparison"), query("recent updates")];
  const count = options.depth === "quick" ? (options.mode === "data" ? 2 : 1) : options.depth === "normal" ? (options.mode === "data" ? 4 : 3) : 5;
  return [...new Set(queries)].slice(0, count);
}

export function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.length > 4096) return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return undefined; }
}

/** Rank fusion across queries; balance actual URL hosts and query coverage, not claimed authority. */
export function rankSources(batches: SearchResult[][], cap: number, pinned: SearchResult[] = []): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const batch of batches) for (const source of batch) {
    const key = normalizeUrl(source.url);
    if (!key) continue;
    const old = byUrl.get(key);
    if (!old) byUrl.set(key, { ...source, queries: [...source.queries] });
    else {
      // Repeated results in the same query do not increase rank.
      if (source.queries.some(q => !old.queries.includes(q))) old.score += source.score;
      old.queries = [...new Set([...old.queries, ...source.queries])];
    }
  }
  const out = pinned.map(s => byUrl.get(normalizeUrl(s.url)!) ?? s).slice(0, cap);
  const used = new Set(out.map(s => normalizeUrl(s.url)));
  const hosts = new Map<string, number>();
  const queries = new Map<string, number>();
  const account = (s: SearchResult) => {
    hosts.set(s.domain, (hosts.get(s.domain) ?? 0) + 1);
    for (const q of s.queries) queries.set(q, (queries.get(q) ?? 0) + 1);
  };
  out.forEach(account);
  const candidates = [...byUrl.values()].filter(s => !used.has(normalizeUrl(s.url)));
  while (out.length < cap && candidates.length) {
    const score = (s: SearchResult) => s.score / (1 + (hosts.get(s.domain) ?? 0)) *
      (s.queries.some(q => !queries.has(q)) ? 2 : 1);
    candidates.sort((a, b) => score(b) - score(a));
    const next = candidates.shift()!;
    out.push(next); account(next);
  }
  return out;
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function terms(question: string): string[] {
  const stop = new Set("what which where when how does from with that this about compare between and the for are can dataset data source sources".split(" "));
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(t => !stop.has(t));
}

/** Extract exact located windows, preferring question terms anywhere in the retrieved text. */
export function selectPassages(text: string, question: string): Passage[] {
  const keywords = terms(question);
  const windows: Array<Passage & { score: number }> = [];
  for (let start = 0; start < text.length; start += 800) {
    const end = Math.min(start + 1000, text.length);
    const value = text.slice(start, end);
    const lower = value.toLowerCase();
    windows.push({ text: value, startOffset: start, endOffset: end,
      startLine: 1 + (text.slice(0, start).match(/\n/g)?.length ?? 0),
      endLine: 1 + (text.slice(0, end).match(/\n/g)?.length ?? 0),
      score: keywords.filter(t => lower.includes(t)).length });
  }
  const selected: typeof windows = [];
  for (const window of windows.sort((a, b) => b.score - a.score || a.startOffset - b.startOffset)) {
    if (selected.some(p => window.startOffset < p.endOffset && window.endOffset > p.startOffset)) continue;
    selected.push(window);
    if (selected.length === 4) break;
  }
  return selected.map(({ score: _score, ...passage }) => passage);
}

export function inferDataProfile(input: { title: string; url: string; snippet: string; text?: string }): DataProfile {
  const text = input.text ?? input.snippet;
  // Preserve line-wrapped qualifiers in quotations. Mentions are evidence for synthesis,
  // never a validated global requirement: scope and negation cannot be safely inferred by regex.
  const sentences = text.split(/\n{2,}|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const auth = sentences.filter(s => /api[ -]?key|authenticat|oauth|credentials?|log[ -]?in|sign[ -]?in|\bbearer\b|\btoken\b|password|access[ -]?key|\bsso\b/i.test(s));
  const license = sentences.filter(s => /license|licence|terms|cc[- ]by|creative commons|public domain/i.test(s)).slice(0, 3);
  const freshness = sentences.filter(s => /updated|last modified|published|issued|release|version/i.test(s) && /\d/.test(s)).slice(0, 3);
  const haystack = `${input.title}\n${input.url}\n${text}`.toLowerCase();
  const formats = ["CSV", "JSON", "Parquet", "XLSX", "API", "PDF"].filter(format => new RegExp(`\\b${format}\\b`, "i").test(haystack));
  const quote = (s: string) => s.length <= 400 ? s : `${s.slice(0, 380)}… [quote truncated]`;
  return {
    likelyDataSource: formats.length > 0 || /dataset|database|catalog|open data|benchmark/.test(haystack),
    accessMethod: /\bapi\b|openapi|graphql/.test(haystack) ? "API mentioned" : /download|bulk|dump/.test(haystack) ? "download mentioned" : "unknown",
    formats,
    authRequired: "unknown",
    license: license.length ? "terms mentioned; verify quoted scope" : "unknown",
    freshness: freshness.length ? "date/version mentioned; verify quoted scope" : "unknown",
    evidenceBasis: input.text === undefined ? "search snippet" : "fetched text",
    evidence: { auth: auth.slice(0, 8).map(quote), license: license.map(quote), freshness: freshness.map(quote) },
    notes: ["Heuristic mentions, not validated access, licensing, or update guarantees.", "Authentication remains unverified; inspect quoted requirements, negation and endpoint-specific scope rather than inferring yes/no from keywords."],
  };
}

async function mapBounded<T, R>(items: T[], concurrency: number, signal: AbortSignal | undefined, fn: (item: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      throwIfCallerAborted(signal);
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  throwIfCallerAborted(signal);
  return results;
}

export async function runResearch(
  input: ResearchOptions,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  dependencies: { call?: typeof mcpToolCall; endpoints?: string[] } = {},
): Promise<ResearchBundle> {
  const options = normalizeOptions(input);
  throwIfCallerAborted(signal);
  const started = Date.now();
  const call = dependencies.call ?? mcpToolCall;
  const endpoints = dependencies.endpoints ?? readConfiguredMcpUrls();
  const attempts: SearchAttempt[] = [];
  const batches: SearchResult[][] = [];
  const fetched = new Map<string, SourceRecord>();
  const perQueryLimit = Math.min(20, Math.max(8, Math.ceil(options.maxSources / buildQueries(options).length) + 4));
  async function search(queries: string[], round: number) {
    onProgress?.(`Research round ${round}: searching ${queries.length} queries (up to ${SEARCH_CONCURRENCY} at once)...`);
    const output = await mapBounded(queries, SEARCH_CONCURRENCY, signal, async query => {
      const start = Date.now();
      let endpoint: string | undefined;
      try {
        const result = await call(endpoints, "web_search", { query, num_results: perQueryLimit }, { signal, timeoutMs: WEB_SEARCH_TIMEOUT_MS, requestId: `research-${randomUUID()}` });
        endpoint = result.endpointUrl;
        if (!result.text) throw new Error(result.error ?? "Search returned no text");
        const data = JSON.parse(result.text);
        if (!data || typeof data !== "object" || data.error || !Array.isArray(data.results)) throw new Error("Invalid search payload or broker search failure");
        const sources: SearchResult[] = [];
        for (const [index, item] of data.results.slice(0, perQueryLimit).entries()) {
          if (!item || typeof item !== "object" || typeof item.url !== "string") continue;
          if (!normalizeUrl(item.url)) continue;
          // Canonicalization is a dedup key only: signed/order-sensitive request URLs must survive.
          const parsed = new URL(item.url);
          parsed.hash = "";
          const url = parsed.toString();
          sources.push({ title: cleanText(String(item.title ?? "Untitled")).slice(0, 300), url,
            domain: new URL(url).hostname.replace(/^www\./, ""), snippet: cleanText(String(item.snippet ?? item.content ?? "")).slice(0, 1500),
            engine: typeof item.engine === "string" ? item.engine.slice(0, 100) : undefined,
            query, queries: [query], score: 1 / (60 + index + 1) });
        }
        return { sources, attempt: { query, round, status: sources.length ? "ok" : "empty", resultCount: sources.length, durationMs: Date.now() - start, endpoint } as SearchAttempt };
      } catch (error) {
        throwIfCallerAborted(signal);
        return { sources: [], attempt: { query, round, status: "error", resultCount: 0, durationMs: Date.now() - start, endpoint,
          error: cleanText(error instanceof Error ? error.message : String(error)).slice(0, 500) } as SearchAttempt };
      }
    });
    for (const result of output) { attempts.push(result.attempt); batches.push(result.sources); }
  }
  async function fetchPages(sources: SearchResult[]) {
    onProgress?.(`Fetching ${sources.length} pages (up to ${FETCH_CONCURRENCY} at once; ${fetched.size}/${options.fetchCount} attempts used)...`);
    const records = await mapBounded(sources, FETCH_CONCURRENCY, signal, async source => {
      try {
        const response = await call(endpoints, "web_fetch", { url: source.url, max_chars: MAX_RETRIEVED_CHARS }, { signal, timeoutMs: WEB_FETCH_TIMEOUT_MS, requestId: `research-${randomUUID()}` });
        if (!response.text?.trim() || response.text.startsWith("Fetch error:")) throw new Error(response.error ?? response.text ?? "Fetch returned no text");
        const retrievedText = cleanText(response.text.slice(0, MAX_RETRIEVED_CHARS));
        const passages = selectPassages(retrievedText, options.question);
        return { ...source, fetched: true, fetchStatus: "fetched", retrievedAt: new Date().toISOString(), retrievedText,
          retrievalTruncated: response.text.length >= MAX_RETRIEVED_CHARS,
          contentHash: createHash("sha256").update(retrievedText).digest("hex"), passages,
          excerpt: passages.map(p => p.text).join("\n\n[…]\n\n"),
          dataProfile: options.mode === "data" ? inferDataProfile({ ...source, text: retrievedText }) : undefined } as SourceRecord;
      } catch (error) {
        throwIfCallerAborted(signal);
        return { ...source, fetched: false, fetchStatus: "failed", error: cleanText(error instanceof Error ? error.message : String(error)).slice(0, 500) } as SourceRecord;
      }
    });
    for (const record of records) fetched.set(normalizeUrl(record.url)!, record);
  }

  await search(buildQueries(options), 1);
  let ranked = rankSources(batches, options.maxSources);
  const initialFetch = options.depth === "quick" ? options.fetchCount : Math.ceil(options.fetchCount / 2);
  await fetchPages(ranked.slice(0, initialFetch));
  const followUpReasons: string[] = [];
  const followQueries: string[] = [];
  if (options.depth !== "quick" && attempts.some(a => a.status !== "error")) {
    if (ranked.length < options.maxSources || new Set(ranked.map(s => s.domain)).size < Math.min(3, options.maxSources)) {
      followUpReasons.push("Insufficient distinct sources or host diversity");
      followQueries.push(boundedQuery(options.question, "independent evidence primary sources"));
    }
    const uncovered = attempts.find(a => a.status !== "ok");
    if (uncovered) {
      followUpReasons.push(`No usable results for: ${uncovered.query}`);
      followQueries.push(boundedQuery(uncovered.query, "reference"));
    }
    if (options.mode === "data" && [...fetched.values()].some(s => s.fetched && s.dataProfile &&
      (!s.dataProfile.evidence.auth.length || s.dataProfile.license === "unknown" || s.dataProfile.freshness === "unknown"))) {
      followUpReasons.push("Dataset authentication, license, or freshness evidence missing");
      followQueries.unshift(boundedQuery(options.question, "license terms authentication last updated"));
    }
    if (fetched.size && ![...fetched.values()].some(s => s.fetched)) {
      followUpReasons.push("Initial page fetches failed; seek alternative sources");
      followQueries.unshift(boundedQuery(options.question, "documentation alternative sources"));
    }
    const follow = [...new Set(followQueries)].filter(q => !attempts.some(a => a.query === q)).slice(0, 2);
    if (follow.length) {
      await search(follow, 2);
      ranked = rankSources(batches, options.maxSources, [...fetched.values()]);
    }
  }
  await fetchPages(ranked.filter(s => !fetched.has(normalizeUrl(s.url)!)).slice(0, options.fetchCount - fetched.size));
  const sources: SourceRecord[] = ranked.map(source => {
    const record = fetched.get(normalizeUrl(source.url)!);
    return record ? { ...record, queries: source.queries, score: source.score } : { ...source, fetched: false, fetchStatus: "not_requested",
      dataProfile: options.mode === "data" ? inferDataProfile(source) : undefined };
  });
  const errors = attempts.filter(a => a.status === "error").length;
  const fetchErrors = sources.filter(s => s.fetchStatus === "failed").length;
  const hashes = sources.flatMap(s => s.contentHash ? [s.contentHash] : []);
  const repeatedContent = hashes.length - new Set(hashes).size;
  const gaps = [
    ...(repeatedContent ? [`${repeatedContent} fetched pages duplicate other retrieved text; do not count identical text as independent corroboration.`] : []),
    ...(errors ? [`${errors} search queries failed; coverage is incomplete.`] : []),
    ...(fetchErrors ? [`${fetchErrors} page fetches failed; do not treat error text as evidence.`] : []),
    ...(!sources.length ? ["No usable sources found."] : []),
    ...(sources.length && !sources.some(s => s.fetched) ? ["Only search snippets available; page claims are unverified."] : []),
    ...(sources.length && new Set(sources.map(s => s.domain)).size < 2 ? ["Only one source host; independent corroboration is missing."] : []),
    ...(options.mode === "data" && sources.some(s => s.dataProfile && (s.dataProfile.authRequired === "unknown" || s.dataProfile.license === "unknown" || s.dataProfile.freshness === "unknown")) ? ["Some dataset metadata remains unknown; consult quoted evidence."] : []),
  ];
  const status = !sources.length ? (errors ? "failed" : "empty") : errors || fetchErrors || (options.fetchCount > 0 && !sources.some(s => s.fetched)) ? "partial" : "complete";
  throwIfCallerAborted(signal);
  return { id: randomUUID(), createdAt: new Date().toISOString(), question: options.question, mode: options.mode, depth: options.depth,
    status, searchProvider: "mcp", searchEndpoint: attempts.find(a => a.endpoint)?.endpoint ?? "unavailable",
    queries: attempts.map(a => a.query), attempts, followUpReasons, gaps, durationMs: Date.now() - started, fetchAttempts: fetched.size, sources };
}
