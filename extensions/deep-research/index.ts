import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

interface ResearchOptions {
  mode: "general" | "data" | "sources";
  depth: "quick" | "normal" | "deep";
  maxSources?: number;
  fetchCount?: number;
  save: boolean;
  synthesize: boolean;
  question: string;
}

interface SearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine?: string;
  query: string;
}

interface SourceRecord extends SearchResult {
  fetched: boolean;
  contentType?: string;
  excerpt?: string;
  dataProfile?: DataProfile;
}

interface DataProfile {
  likelyDataSource: boolean;
  accessMethod: string;
  formats: string[];
  authRequired: "yes" | "no" | "unknown";
  license: string;
  freshness: string;
  notes: string[];
}

interface ResearchBundle {
  id: string;
  createdAt: string;
  question: string;
  mode: ResearchOptions["mode"];
  depth: ResearchOptions["depth"];
  searchProvider: "mcp";
  searchEndpoint: string;
  queries: string[];
  sources: SourceRecord[];
}

interface McpToolCallResult {
  endpointUrl?: string;
  checked: string[];
  text?: string;
  result?: unknown;
  error?: string;
}

const RESEARCH_ROOT = join(homedir(), ".pi", "research");
const CONFIG_PATH = join(RESEARCH_ROOT, "config.json");
const DEFAULT_LOCAL_MCP = ["http://127.0.0.1:8889/mcp", "http://localhost:8889/mcp"];
const MAX_EXCERPT_CHARS = 5000;
const MAX_SYNTHESIS_CHARS = 60_000;

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "deep-research", content, display: true });
}

function usage() {
  return [
    "Usage:",
    "  /research [options] <question>",
    "",
    "Modes:",
    "  --data                 Find datasets, APIs, catalogs, downloads, specs, benchmarks",
    "  --sources              Find authoritative sources with minimal synthesis",
    "  --mode <general|data|sources>",
    "",
    "Options:",
    "  --depth <quick|normal|deep>     Default: normal",
    "  --max-sources <N>              Final source count cap",
    "  --fetch <N>                    Number of source pages to fetch/excerpt",
    "  --no-save                     Do not save bundle under ~/.pi/research",
    "  --no-synthesize               Gather and save only; do not prompt pi to synthesize",
    "",
    "Examples:",
    "  /research best local-first smart home architectures for Mac mini hubs",
    "  /research --data residential electricity price datasets by ZIP code",
    "  /research --sources SwitchBot BLE protocol documentation",
    "",
    "MCP broker config priority:",
    "  PI_WEBSEARCH_MCP_URL, SEARCH_MCP_URL, WEBSEARCH_MCP_URL,",
    `  ${CONFIG_PATH} { \"websearchMcpUrl\": \"http://127.0.0.1:8889/mcp\" },`,
    "  then local-only defaults http://127.0.0.1:8889/mcp and http://localhost:8889/mcp if reachable.",
    "  Direct SearXNG is not used by this client; the broker owns backend strategy.",
  ].join("\n");
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseArgs(raw: string): ResearchOptions {
  const tokens = tokenize(raw.trim());
  const questionParts: string[] = [];
  const options: ResearchOptions = {
    mode: "general",
    depth: "normal",
    save: true,
    synthesize: true,
    question: "",
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const readValue = (flag: string) => {
      const value = tokens[++i];
      if (!value) throw new Error(`Missing value for ${flag}`);
      return value;
    };

    if (token === "--data") options.mode = "data";
    else if (token === "--sources") options.mode = "sources";
    else if (token === "--mode") options.mode = parseMode(readValue(token));
    else if (token.startsWith("--mode=")) options.mode = parseMode(token.slice("--mode=".length));
    else if (token === "--depth") options.depth = parseDepth(readValue(token));
    else if (token.startsWith("--depth=")) options.depth = parseDepth(token.slice("--depth=".length));
    else if (token === "--max-sources") options.maxSources = parsePositiveInt(readValue(token), token, 50);
    else if (token.startsWith("--max-sources=")) options.maxSources = parsePositiveInt(token.slice("--max-sources=".length), "--max-sources", 50);
    else if (token === "--fetch") options.fetchCount = parsePositiveInt(readValue(token), token, 30, true);
    else if (token.startsWith("--fetch=")) options.fetchCount = parsePositiveInt(token.slice("--fetch=".length), "--fetch", 30, true);
    else if (token === "--no-save") options.save = false;
    else if (token === "--save") options.save = true;
    else if (token === "--no-synthesize" || token === "--no-synthesis") options.synthesize = false;
    else questionParts.push(token);
  }

  options.question = questionParts.join(" ").trim();
  return applyDepthDefaults(options);
}

function parseMode(value: string): ResearchOptions["mode"] {
  if (value === "general" || value === "data" || value === "sources") return value;
  throw new Error(`Invalid mode '${value}'. Use general, data, or sources.`);
}

function parseDepth(value: string): ResearchOptions["depth"] {
  if (value === "quick" || value === "normal" || value === "deep") return value;
  throw new Error(`Invalid depth '${value}'. Use quick, normal, or deep.`);
}

function parsePositiveInt(value: string, flag: string, max: number, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`Invalid value for ${flag}: ${value}`);
  return Math.min(max, parsed);
}

function applyDepthDefaults(options: ResearchOptions): ResearchOptions {
  const defaults = {
    quick: { maxSources: 8, fetchCount: 3 },
    normal: { maxSources: 14, fetchCount: 6 },
    deep: { maxSources: 24, fetchCount: 10 },
  }[options.depth];
  return {
    ...options,
    maxSources: options.maxSources ?? defaults.maxSources,
    fetchCount: options.fetchCount ?? defaults.fetchCount,
  };
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function readSearchConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readConfiguredMcpUrls(): string[] {
  const envValues = [
    process.env.PI_WEBSEARCH_MCP_URL,
    process.env.SEARCH_MCP_URL,
    process.env.WEBSEARCH_MCP_URL,
  ].filter(Boolean) as string[];

  const config = readSearchConfig();
  const configValues = [config.websearchMcpUrl, config.mcpUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return [...new Set([...envValues, ...configValues, ...DEFAULT_LOCAL_MCP].map(normalizeBaseUrl))];
}

function readMcpApiKey(): string | undefined {
  return [
    process.env.PI_WEBSEARCH_MCP_API_KEY,
    process.env.SEARCH_MCP_API_KEY,
    process.env.TAVILY_API_KEY,
  ]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim();
}

function mcpResultText(result: unknown): string | undefined {
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((item) =>
          item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
            ? (item as { text: string }).text
            : undefined,
        )
        .filter((part): part is string => Boolean(part));
      if (parts.length) return parts.join("\n");
    }

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object") return JSON.stringify(structured);
  }
  return result === undefined ? undefined : JSON.stringify(result);
}

async function mcpToolCall(endpointUrl: string, toolName: string, args: Record<string, unknown>, timeout = 25_000): Promise<McpToolCallResult> {
  const apiKey = readMcpApiKey();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["X-Tavily-Key"] = apiKey;
  }

  const payload = {
    jsonrpc: "2.0",
    id: "pi-deep-research",
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      return { checked: [endpointUrl], error: `HTTP ${response.status} ${response.statusText}` };
    }
    const data = (await response.json()) as { result?: unknown; error?: unknown };
    if (data.error !== undefined) {
      return { checked: [endpointUrl], error: typeof data.error === "string" ? data.error : JSON.stringify(data.error) };
    }
    if (!("result" in data)) return { checked: [endpointUrl], error: "Malformed MCP response: missing result" };
    const text = mcpResultText(data.result);
    if (!text) return { checked: [endpointUrl], error: "Malformed MCP response: empty result content" };
    return { endpointUrl, checked: [endpointUrl], result: data.result, text };
  } catch (error) {
    return { checked: [endpointUrl], error: error instanceof Error ? error.message : String(error) };
  }
}

async function mcpSearch(endpointUrl: string, query: string, limit: number): Promise<SearchResult[]> {
  const result = await mcpToolCall(endpointUrl, "web_search", { query, num_results: limit });
  if (!result.text) throw new Error(result.error ?? "MCP search returned no text");
  const data = JSON.parse(result.text) as { results?: Array<Record<string, unknown>>; error?: string };
  if (data.error) throw new Error(data.error);
  const raw = data.results ?? [];
  return raw.slice(0, limit).map((item) => {
    const url = String(item.url ?? "");
    return {
      title: String(item.title ?? "Untitled"),
      url,
      domain: String(item.domain ?? domainOf(url)),
      snippet: String(item.snippet ?? item.content ?? "").trim(),
      engine: typeof item.engine === "string" ? item.engine : undefined,
      query,
    };
  }).filter((result) => result.url.startsWith("http://") || result.url.startsWith("https://"));
}

async function resolveMcpEndpoint(): Promise<{ endpointUrl?: string; checked: string[]; error?: string }> {
  const candidates = readConfiguredMcpUrls();
  const checked: string[] = [];
  for (const candidate of candidates) {
    checked.push(candidate);
    try {
      await mcpSearch(candidate, "pi deep research health check", 1);
      return { endpointUrl: candidate, checked };
    } catch {
      // Try next candidate.
    }
  }
  return {
    checked,
    error: [
      "Could not reach the local-search MCP broker.",
      "Configure one of:",
      "- PI_WEBSEARCH_MCP_URL=http://127.0.0.1:8889/mcp",
      "- SEARCH_MCP_URL=http://127.0.0.1:8889/mcp",
      "- WEBSEARCH_MCP_URL=http://127.0.0.1:8889/mcp",
      `- ${CONFIG_PATH} with { "websearchMcpUrl": "http://127.0.0.1:8889/mcp" }`,
      "",
      `Checked: ${checked.join(", ")}`,
      "Direct SearXNG is not used by this client; fix broker availability instead of bypassing it.",
    ].join("\n"),
  };
}

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildQueries(options: ResearchOptions): string[] {
  const q = options.question;
  if (options.mode === "data") {
    const queries = [
      `${q} dataset OR database OR catalog`,
      `${q} API OR developer documentation`,
      `${q} CSV OR JSON OR parquet OR download`,
      `${q} open data OR government data OR benchmark`,
      `${q} license terms data source`,
    ];
    return queries.slice(0, options.depth === "quick" ? 2 : options.depth === "normal" ? 4 : 5);
  }
  if (options.mode === "sources") {
    const queries = [
      `${q} official documentation OR specification OR standard`,
      `${q} authoritative source OR primary source`,
      `${q} site:gov OR site:edu OR site:org`,
      `${q} GitHub documentation reference`,
    ];
    return queries.slice(0, options.depth === "quick" ? 1 : options.depth === "normal" ? 3 : 4);
  }
  const queries = [
    q,
    `${q} official documentation`,
    `${q} analysis comparison`,
    `${q} recent updates`,
  ];
  return queries.slice(0, options.depth === "quick" ? 1 : options.depth === "normal" ? 2 : 4);
}

function dedupeResults(results: SearchResult[], maxSources: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrl(result.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= maxSources) break;
  }
  return out;
}

function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

async function fetchSource(endpointUrl: string, result: SearchResult, includeDataProfile: boolean): Promise<SourceRecord> {
  try {
    const response = await mcpToolCall(
      endpointUrl,
      "web_fetch",
      { url: result.url, max_chars: Math.max(MAX_EXCERPT_CHARS * 2, 20_000) },
      30_000,
    );
    const contentType = "text/plain; source=local-search-mcp";
    if (!response.text || response.text.startsWith("Fetch error:")) {
      return { ...result, fetched: false, contentType, excerpt: response.text ?? `Fetch failed: ${response.error ?? "MCP fetch returned no text"}` };
    }
    const excerpt = compactWhitespace(response.text).slice(0, MAX_EXCERPT_CHARS);
    return {
      ...result,
      fetched: true,
      contentType,
      excerpt,
      dataProfile: includeDataProfile ? inferDataProfile({ ...result, contentType, text: excerpt }) : undefined,
    };
  } catch (error) {
    return { ...result, fetched: false, excerpt: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function compactWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function inferDataProfile(input: { title: string; url: string; snippet: string; contentType?: string; text?: string }): DataProfile {
  const haystack = `${input.title}\n${input.url}\n${input.snippet}\n${input.contentType ?? ""}\n${input.text ?? ""}`.toLowerCase();
  const formats = [
    ["CSV", /\bcsv\b|text\/csv|\.csv(\?|$)/],
    ["JSON", /\bjson\b|application\/json|\.json(\?|$)/],
    ["Parquet", /\bparquet\b|\.parquet(\?|$)/],
    ["XLS/XLSX", /\bxlsx?\b|spreadsheet|\.xlsx?(\?|$)/],
    ["API", /\bapi\b|openapi|swagger|graphql|rest api/],
    ["PDF", /\bpdf\b|application\/pdf|\.pdf(\?|$)/],
    ["HTML table/catalog", /data catalog|open data|table|portal/],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(haystack))
    .map(([format]) => String(format));

  const notes: string[] = [];
  if (/download|bulk|dump|export/.test(haystack)) notes.push("mentions downloadable/bulk access");
  if (/api key|token|oauth|authentication|login required|sign in/.test(haystack)) notes.push("may require credentials");
  if (/license|terms|cc-by|creative commons|public domain|open license/.test(haystack)) notes.push("license/terms text detected");
  if (/updated|last modified|version|release|published|issued/.test(haystack)) notes.push("freshness/version text detected");

  return {
    likelyDataSource: formats.length > 0 || /dataset|database|catalog|open data|benchmark|download|api/.test(haystack),
    accessMethod: /\bapi\b|openapi|swagger|graphql|rest api/.test(haystack)
      ? "API"
      : /download|bulk|dump|\.csv|\.json|\.parquet|\.xlsx?/.test(haystack)
        ? "download"
        : /catalog|portal|table/.test(haystack)
          ? "catalog/web table"
          : "unknown",
    formats: [...new Set(formats)],
    authRequired: /api key|token|oauth|authentication|login required|sign in/.test(haystack) ? "yes" : "unknown",
    license: /public domain/.test(haystack)
      ? "public domain mentioned"
      : /cc-by|creative commons/.test(haystack)
        ? "Creative Commons mentioned"
        : /license|terms/.test(haystack)
          ? "license/terms mentioned"
          : "unknown",
    freshness: /updated|last modified|version|release|published|issued/.test(haystack) ? "freshness/version text detected" : "unknown",
    notes,
  };
}

function slugify(value: string, maxLength = 70) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
  return slug || "research";
}

function stamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function saveBundle(bundle: ResearchBundle): string {
  const dir = join(RESEARCH_ROOT, `${stamp()}-${slugify(bundle.question)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sources.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "excerpts.md"), formatSourcesMarkdown(bundle), "utf8");
  writeFileSync(join(dir, "prompt.md"), buildSynthesisPrompt(bundle, dir), "utf8");
  return dir;
}

function formatSourcesMarkdown(bundle: ResearchBundle) {
  const lines = [
    `# Research bundle: ${bundle.question}`,
    "",
    `- Created: ${bundle.createdAt}`,
    `- Mode: ${bundle.mode}`,
    `- Depth: ${bundle.depth}`,
    `- Search provider: ${bundle.searchProvider}`,
    `- Search endpoint: ${bundle.searchEndpoint}`,
    "",
    "## Queries",
    ...bundle.queries.map((query) => `- ${query}`),
    "",
    "## Sources",
  ];

  bundle.sources.forEach((source, index) => {
    lines.push("", `### [${index + 1}] ${source.title}`, "", `URL: ${source.url}`, `Domain: ${source.domain}`, `Query: ${source.query}`);
    if (source.snippet) lines.push("", `Snippet: ${source.snippet}`);
    if (source.dataProfile) lines.push("", "Data profile:", "", fenced(JSON.stringify(source.dataProfile, null, 2), "json"));
    if (source.excerpt) lines.push("", "Excerpt:", "", source.excerpt);
  });

  return `${lines.join("\n")}\n`;
}

function fenced(value: string, lang = "") {
  return `\`\`\`${lang}\n${value}\n\`\`\``;
}

function buildSynthesisPrompt(bundle: ResearchBundle, bundleDir?: string) {
  const body = formatSourcesMarkdown(bundle);
  const clipped = body.length > MAX_SYNTHESIS_CHARS ? `${body.slice(0, MAX_SYNTHESIS_CHARS)}\n\n...[truncated for context]...` : body;
  const modeInstructions = {
    general: [
      "Synthesize the answer from the gathered sources.",
      "Prioritize current, authoritative, primary sources.",
      "Cite sources inline as [1], [2], etc. using the source numbering below.",
      "Call out uncertainty, conflicts, and gaps.",
    ],
    sources: [
      "Do not over-synthesize. Rank the best authoritative sources and explain why each matters.",
      "Separate primary/official sources from secondary commentary.",
      "Cite sources inline as [1], [2], etc. using the source numbering below.",
    ],
    data: [
      "Identify usable datasets, APIs, catalogs, downloads, specs, and benchmarks.",
      "For each promising data source, extract: owner/publisher, URL, access method, format, freshness/version, license/terms, auth/API-key requirement, reliability, and suggested use.",
      "Prefer machine-readable sources and official catalogs over articles about data.",
      "Cite sources inline as [1], [2], etc. using the source numbering below.",
    ],
  }[bundle.mode];

  return [
    `Research question: ${bundle.question}`,
    "",
    "Instructions:",
    ...modeInstructions.map((line) => `- ${line}`),
    bundleDir ? `- If file tools are available, write the final report to: ${join(bundleDir, "report.md")}` : undefined,
    "- Do not invent facts beyond the evidence. If a source was not fetched, rely only on its title/snippet.",
    "",
    clipped,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runResearch(options: ResearchOptions, endpointUrl: string): Promise<ResearchBundle> {
  const queries = buildQueries(options);
  const perQueryLimit = Math.max(8, Math.ceil((options.maxSources ?? 14) / queries.length) + 4);
  const batches = await Promise.all(queries.map((query) => mcpSearch(endpointUrl, query, perQueryLimit).catch(() => [])));
  const results = dedupeResults(batches.flat(), options.maxSources ?? 14);
  const fetchCount = Math.min(options.fetchCount ?? 0, results.length);
  const includeDataProfile = options.mode === "data";
  const fetched = await Promise.all(results.slice(0, fetchCount).map((result) => fetchSource(endpointUrl, result, includeDataProfile)));
  const unfetched = results.slice(fetchCount).map((result) => ({
    ...result,
    fetched: false,
    dataProfile: includeDataProfile ? inferDataProfile(result) : undefined,
  }));
  return {
    id: `${stamp()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    searchProvider: "mcp",
    searchEndpoint: endpointUrl,
    queries,
    sources: [...fetched, ...unfetched],
  };
}

function summary(bundle: ResearchBundle, bundleDir?: string) {
  const fetched = bundle.sources.filter((source) => source.fetched).length;
  const likelyData = bundle.sources.filter((source) => source.dataProfile?.likelyDataSource).length;
  return [
    "Research gathered.",
    `question: ${bundle.question}`,
    `mode: ${bundle.mode}`,
    `depth: ${bundle.depth}`,
    `queries: ${bundle.queries.length}`,
    `sources: ${bundle.sources.length}`,
    `fetched: ${fetched}`,
    bundle.mode === "data" ? `likely data sources: ${likelyData}` : undefined,
    bundleDir ? `bundle: ${bundleDir}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export default function deepResearchExtension(pi: ExtensionAPI) {
  pi.registerCommand("research", {
    description: "Deep research via the local-search MCP broker; supports general, source, and data-source discovery modes.",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const trimmed = rawArgs.trim();
      if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
        send(pi, usage());
        return;
      }

      let options: ResearchOptions;
      try {
        options = parseArgs(trimmed);
      } catch (error) {
        send(pi, `Research argument error: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
        return;
      }

      if (!options.question) {
        send(pi, `Missing research question.\n\n${usage()}`);
        return;
      }

      send(pi, `Research started. Resolving local-search MCP broker...\nquestion: ${options.question}\nmode: ${options.mode}\ndepth: ${options.depth}`);

      const resolved = await resolveMcpEndpoint();
      if (!resolved.endpointUrl) {
        send(pi, resolved.error ?? "Could not resolve local-search MCP endpoint.");
        return;
      }

      send(pi, `MCP broker resolved: ${resolved.endpointUrl}\nGathering sources...`);

      try {
        const bundle = await runResearch(options, resolved.endpointUrl);
        let bundleDir: string | undefined;
        if (options.save) bundleDir = saveBundle(bundle);
        send(pi, summary(bundle, bundleDir));

        if (!bundle.sources.length) {
          send(pi, "No sources were found. Try a broader question or different mode/depth.");
          return;
        }

        if (options.synthesize) {
          pi.sendUserMessage(buildSynthesisPrompt(bundle, bundleDir));
        }
      } catch (error) {
        send(pi, `Research failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  // --- deep_research tool (LLM-callable, returns gathered sources for synthesis) ---

  const MAX_TOOL_RESULT_CHARS = 24_000;

  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description:
      "Multi-source web research via the local-search MCP broker. Gathers, fetches, and excerpts sources for deep questions, dataset discovery, or authoritative source finding. Returns gathered sources with excerpts for the agent to synthesize. Use when web_search is insufficient — when you need multiple sources, cross-referencing, cited synthesis, or dataset/API discovery.",
    promptSnippet: "deep_research for multi-source web research with cited synthesis",
    promptGuidelines: [
      "Use deep_research when a question requires multiple sources, cross-referencing, cited synthesis, or dataset/API discovery — not when a single web_search would suffice.",
      "Use deep_research mode 'data' for datasets/APIs/catalogs/benchmarks, 'sources' for authoritative documentation, 'general' for broad research questions.",
      "deep_research costs more than web_search (multiple queries + fetches). Prefer web_search for quick single-fact lookups.",
      "Use deep_research instead of making 3+ sequential web_search + web_fetch calls for the same topic — one deep_research call is more effective.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Research question to investigate" }),
      mode: Type.Optional(
        StringEnum(["general", "data", "sources"] as const, {
          description: "general=web/docs research, data=datasets/APIs/catalogs, sources=authoritative source discovery. Default: general",
          default: "general",
        }),
      ),
      depth: Type.Optional(
        StringEnum(["quick", "normal", "deep"] as const, {
          description: "quick=8 sources/3 fetches, normal=14/6, deep=24/10. Default: normal",
          default: "normal",
        }),
      ),
      max_sources: Type.Optional(Type.Number({ description: "Max sources to gather", default: 14 })),
      fetch_count: Type.Optional(Type.Number({ description: "Number of source pages to fetch and excerpt", default: 6 })),
    }),

    async execute(_id, params, _signal, onUpdate, _ctx) {
      const options: ResearchOptions = {
        question: params.question,
        mode: (params.mode as ResearchOptions["mode"]) ?? "general",
        depth: (params.depth as ResearchOptions["depth"]) ?? "normal",
        maxSources: params.max_sources,
        fetchCount: params.fetch_count,
        save: true,
        synthesize: false,
      };
      const applied = applyDepthDefaults(options);

      onUpdate?.({ content: [{ type: "text", text: "Resolving local-search MCP broker..." }] });

      const resolved = await resolveMcpEndpoint();
      if (!resolved.endpointUrl) {
        return {
          content: [{ type: "text" as const, text: resolved.error ?? "Could not resolve local-search MCP endpoint." }],
          details: { error: true, checked: resolved.checked },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Searching through MCP broker at ${resolved.endpointUrl}...` }] });

      try {
        const bundle = await runResearch(applied, resolved.endpointUrl);
        onUpdate?.({ content: [{ type: "text", text: `Gathered ${bundle.sources.length} sources. Saving bundle...` }] });
        const bundleDir = saveBundle(bundle);

        // Format results for the LLM — include excerpts up to the char budget
        const sourceLines: string[] = [];
        let charsUsed = 0;
        for (let i = 0; i < bundle.sources.length; i++) {
          const source = bundle.sources[i];
          const fetched = source.fetched ? "✓" : "✗";
          const snippet = source.snippet ? `\n   Snippet: ${source.snippet}` : "";
          const excerpt = source.excerpt && source.fetched ? `\n   Excerpt: ${source.excerpt.slice(0, 800)}` : "";
          const dataInfo =
            source.dataProfile?.likelyDataSource
              ? `\n   Data: ${source.dataProfile.accessMethod}, formats: ${source.dataProfile.formats.join("/")}, auth: ${source.dataProfile.authRequired}`
              : "";
          const line = `[${i + 1}] ${fetched} ${source.title} — ${source.url}${snippet}${excerpt}${dataInfo}`;
          if (charsUsed + line.length > MAX_TOOL_RESULT_CHARS) {
            sourceLines.push(`\n... ${bundle.sources.length - i} more sources in bundle: ${bundleDir}`);
            break;
          }
          sourceLines.push(line);
          charsUsed += line.length;
        }

        const text = [
          `Research: ${bundle.sources.length} sources (${bundle.sources.filter((s) => s.fetched).length} fetched)`,
          `Mode: ${bundle.mode}, Depth: ${bundle.depth}`,
          `Bundle: ${bundleDir}`,
          "",
          "## Sources",
          ...sourceLines,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { question: params.question, bundleDir, sourceCount: bundle.sources.length, fetchedCount: bundle.sources.filter((s) => s.fetched).length },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Research failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  });
}
