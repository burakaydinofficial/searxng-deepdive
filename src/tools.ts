// Tool registration. Three tools, all backed by a single doSearch() that
// applies the format=compact trim and (optionally) multi-page fanout.
//
// Most of the agent-ergonomics logic in this file (validation, hints,
// normalization, compact-trim) is exported separately so the test suite
// can exercise it without spinning up an MCP transport.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type SearchResult,
  type SearchResponse,
  type SearxngClient,
  type SearxngConfig,
} from "./searxng.js";
import {
  SearchInput,
  SearchOnEnginesInput,
  SearchByCategoryInput,
  WebUrlReadInput,
  type SearchInputT,
  type SearchOnEnginesInputT,
  type SearchByCategoryInputT,
  type WebUrlReadInputT,
} from "./schemas.js";
import {
  searchDescription,
  searchOnEnginesDescription,
  searchByCategoryDescription,
  webUrlReadDescription,
} from "./descriptions.js";
import { fetchAndConvertToMarkdown } from "./url-reader.js";

interface ToolDef<T> {
  name: string;
  description: string;
  // Zod 4's `z.toJSONSchema` is overloaded (single schema vs registry);
  // ReturnType<> picks the registry signature, which doesn't match the
  // schema-form payload we actually use. Type as a plain JSON-Schema-
  // shaped object — we only forward it to the MCP client verbatim, so
  // a permissive shape is correct here.
  inputSchema: Record<string, unknown>;
  zodSchema: z.ZodType<T>;
  handler: (input: T) => Promise<unknown>;
}

interface CompactResult {
  url: string;
  title: string;
  content: string;
  engine: string;
}

export interface CompactResponse {
  query: string;
  result_count: number;
  pages_fetched: number;
  unresponsive_engines: unknown[];
  results: CompactResult[];
  hint?: string;
}

export interface ZeroResultContext {
  time_range?: string;
  engines?: string[];
  categories?: string[];
}

// Normalize engine/category names so case-mismatched input from the model
// (e.g. "arXiv", "Semantic Scholar", "PubMed") matches our lowercase config.
// SearXNG itself is case-sensitive on these names; passing wrong case there
// silently no-ops. Cheap to be tolerant.
export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

// Cross-validate engine/category names against the live config. The most
// common LLM mistakes we've seen:
//   1. passing engine names where categories belong (e.g.
//      categories=["arxiv","pubmed"]) — caught by the cross-reference hint;
//   2. passing names in the wrong case ("arXiv", "PubMed") — caught by
//      lowercasing both sides of the comparison.
// Without validation, SearXNG silently ignores unknown values and falls back
// to defaults — the model sees "60 results" and assumes success even though
// the search ran on the wrong engines.
export function validateEngineSelection(
  engines: string[],
  config: SearxngConfig,
): void {
  const enabledLower = new Set(config.enabledEngines.map(normalizeName));
  const categoriesLower = new Set(config.enabledCategories.map(normalizeName));

  const invalid = engines.filter((e) => !enabledLower.has(normalizeName(e)));
  if (invalid.length === 0) return;

  const matchedCategories = invalid.filter((e) =>
    categoriesLower.has(normalizeName(e)),
  );
  const hint =
    matchedCategories.length > 0
      ? ` Note: ${matchedCategories.map((c) => `"${c}"`).join(", ")} ${matchedCategories.length === 1 ? "is a category" : "are categories"}, not engines. Use the \`search_by_category\` tool for those.`
      : "";

  const enginePreview = config.enabledEngines.slice(0, 25).join(", ");
  const more =
    config.enabledEngines.length > 25
      ? `, … (${config.enabledEngines.length - 25} more, see this tool's description)`
      : "";

  throw new Error(
    `Invalid engine name${invalid.length > 1 ? "s" : ""}: ${invalid.map((e) => `"${e}"`).join(", ")}.${hint} Available engines on this instance (${config.enabledEngines.length} total): ${enginePreview}${more}.`,
  );
}

export function validateCategorySelection(
  categories: string[],
  config: SearxngConfig,
): void {
  const enabledLower = new Set(config.enabledEngines.map(normalizeName));
  const categoriesLower = new Set(config.enabledCategories.map(normalizeName));

  const invalid = categories.filter(
    (c) => !categoriesLower.has(normalizeName(c)),
  );
  if (invalid.length === 0) return;

  const matchedEngines = invalid.filter((c) =>
    enabledLower.has(normalizeName(c)),
  );
  const hint =
    matchedEngines.length > 0
      ? ` Note: ${matchedEngines.map((e) => `"${e}"`).join(", ")} ${matchedEngines.length === 1 ? "is an engine" : "are engines"}, not categories. Use the \`search_on_engines\` tool for those.`
      : "";

  throw new Error(
    `Invalid categor${invalid.length > 1 ? "ies" : "y"}: ${invalid.map((c) => `"${c}"`).join(", ")}.${hint} Available categories on this instance: ${config.enabledCategories.join(", ")}.`,
  );
}

// When a search returns zero results, the model needs a signal about why.
// Without this, an empty `results: []` reads to the model as "no matches" and
// it'll waste turns rephrasing the query when the actual problem was a
// wrongly-set filter or rate-limited engines.
//
// Conditions that produce a hint (in evaluation order — multiple may stack):
//   1. time_range was set (some engines return empty when filter is set
//      instead of ignoring it)
//   2. all explicitly-requested engines were unresponsive
//   3. some engines were unresponsive AND no engine list was requested
//      (broad search blind spot — covered)
//   4. exactly one engine was queried and returned nothing
export function buildZeroResultHint(
  resp: SearchResponse,
  ctx: ZeroResultContext,
): string | undefined {
  if (resp.results.length > 0) return undefined;

  const hints: string[] = [];

  if (ctx.time_range) {
    hints.push(
      `time_range="${ctx.time_range}" was set. Not all engines implement time-range filtering — some return empty when it is specified instead of ignoring it. If you actually need recency, try the same query without time_range first to confirm there are matching results, then narrow down.`,
    );
  }

  // Count DISTINCT engines, not raw entries: SearXNG reports failures as
  // [engine, reason] tuples, and the same engine can fail with different
  // reasons across pages (timeout, then "too many requests"), producing
  // multiple entries for one engine. Counting entries would falsely claim
  // "all N requested engines were unresponsive" when only one actually failed.
  const unresponsiveList = Array.isArray(resp.unresponsive_engines)
    ? resp.unresponsive_engines
    : [];
  const unresponsiveCount = new Set(
    unresponsiveList.map((u) =>
      Array.isArray(u) ? String((u as unknown[])[0]) : JSON.stringify(u),
    ),
  ).size;

  if (
    unresponsiveCount > 0 &&
    ctx.engines &&
    ctx.engines.length > 0 &&
    unresponsiveCount >= ctx.engines.length
  ) {
    hints.push(
      `All ${ctx.engines.length} requested engine(s) were unresponsive (rate-limited or blocked at upstream).`,
    );
  } else if (
    unresponsiveCount > 0 &&
    (!ctx.engines || ctx.engines.length === 0)
  ) {
    // Broad-search blind spot: when no engines were specified and several
    // upstream engines failed, the empty result is likely upstream availability
    // rather than a bad query. Without this hint the model would retry with
    // rephrased queries forever.
    hints.push(
      `${unresponsiveCount} engine(s) were unresponsive (rate-limited or blocked upstream). The empty result may be due to upstream availability rather than the query — try again, or use search_on_engines to target a specific engine you know is working.`,
    );
  } else if (
    !ctx.time_range &&
    ctx.engines &&
    ctx.engines.length === 1 &&
    unresponsiveCount === 0
  ) {
    hints.push(
      `Only one engine ("${ctx.engines[0]}") was queried and returned nothing. Try the broad \`search\` tool, or list additional engines, for more coverage.`,
    );
  }

  return hints.length > 0 ? hints.join(" ") : undefined;
}

export function trimToCompact(
  resp: SearchResponse,
  pagesFetched: number,
  ctx: ZeroResultContext,
): CompactResponse {
  const out: CompactResponse = {
    query: resp.query,
    result_count: resp.results.length,
    pages_fetched: pagesFetched,
    unresponsive_engines: Array.isArray(resp.unresponsive_engines)
      ? resp.unresponsive_engines
      : [],
    results: resp.results.map((r: SearchResult) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      engine: r.engine,
    })),
  };
  const hint = buildZeroResultHint(resp, ctx);
  if (hint) out.hint = hint;
  return out;
}

async function doSearch(
  client: SearxngClient,
  config: SearxngConfig,
  input: {
    query: string;
    engines?: string[];
    categories?: string[];
    pageno?: number;
    pages?: number;
    time_range?: "day" | "week" | "month" | "year";
    language?: string;
    safe_search?: 0 | 1 | 2;
    format?: "full" | "compact";
  },
): Promise<unknown> {
  if (input.engines?.length) validateEngineSelection(input.engines, config);
  if (input.categories?.length)
    validateCategorySelection(input.categories, config);

  // Normalize for the actual SearXNG call. SearXNG is case-sensitive on
  // engine/category names; passing wrong case there silently no-ops.
  // Validation already ensured these all map to real entries, so lowercasing
  // is safe and idempotent.
  const normalizedEngines = input.engines?.map(normalizeName);
  const normalizedCategories = input.categories?.map(normalizeName);

  const pages = input.pages ?? 1;
  const format = input.format ?? "compact";
  const ctx: ZeroResultContext = {
    time_range: input.time_range,
    engines: normalizedEngines,
    categories: normalizedCategories,
  };

  if (pages > 1) {
    const resp = await client.searchMultiPage({
      query: input.query,
      engines: normalizedEngines,
      categories: normalizedCategories,
      pageno: input.pageno ?? 1,
      pages,
      time_range: input.time_range,
      language: input.language,
      safe_search: input.safe_search,
    });
    if (format === "full") {
      const hint = buildZeroResultHint(resp, ctx);
      return hint ? { ...resp, hint } : resp;
    }
    return trimToCompact(resp, resp.pages_fetched, ctx);
  }

  const resp = await client.search({
    query: input.query,
    engines: normalizedEngines,
    categories: normalizedCategories,
    pageno: input.pageno,
    time_range: input.time_range,
    language: input.language,
    safe_search: input.safe_search,
  });
  if (format === "full") {
    const hint = buildZeroResultHint(resp, ctx);
    return hint ? { ...resp, hint } : resp;
  }
  return trimToCompact(resp, 1, ctx);
}

// Bounds how many tool handlers run concurrently so parallel web_url_read
// calls can't multiply the per-fetch buffer toward heap exhaustion. Excess
// calls queue and run as slots free up.
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

const MAX_CONCURRENT_TOOL_CALLS = 4;

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
}

// Build the four tool definitions. Exported so the dispatch layer can be
// unit-tested without spinning up an MCP transport.
export function buildTools(
  client: SearxngClient,
  config: SearxngConfig,
): ToolDef<unknown>[] {
  return [
    {
      name: "search",
      description: searchDescription(config),
      inputSchema: z.toJSONSchema(SearchInput) as Record<string, unknown>,
      zodSchema: SearchInput as z.ZodType<unknown>,
      handler: (input) => doSearch(client, config, input as SearchInputT),
    },
    {
      name: "search_on_engines",
      description: searchOnEnginesDescription(config),
      inputSchema: z.toJSONSchema(SearchOnEnginesInput) as Record<string, unknown>,
      zodSchema: SearchOnEnginesInput as z.ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchOnEnginesInputT;
        return doSearch(client, config, { ...i, engines: i.engines });
      },
    },
    {
      name: "search_by_category",
      description: searchByCategoryDescription(config),
      inputSchema: z.toJSONSchema(SearchByCategoryInput) as Record<string, unknown>,
      zodSchema: SearchByCategoryInput as z.ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchByCategoryInputT;
        return doSearch(client, config, { ...i, categories: i.categories });
      },
    },
    {
      name: "web_url_read",
      description: webUrlReadDescription(),
      inputSchema: z.toJSONSchema(WebUrlReadInput) as Record<string, unknown>,
      zodSchema: WebUrlReadInput as z.ZodType<unknown>,
      handler: (input) => fetchAndConvertToMarkdown(
        (input as WebUrlReadInputT).url,
        input as WebUrlReadInputT,
      ),
    },
  ];
}

// Dispatch one tool call. ALL failures throw real errors: unknown-tool and
// schema-invalid arguments are protocol faults, and tool-execution failures
// (an invalid engine/category name with its corrective hint, an unreachable
// URL, SearXNG rate-limited or down) throw too. This project deliberately
// surfaces failures through the MCP JSON-RPC error envelope (-32603), not as
// { isError: true } results, because that envelope is what the target clients
// feed the model, so the hints reach it. See AGENTS.md (Anti-patterns).
export async function dispatchToolCall(
  tools: ToolDef<unknown>[],
  name: string,
  args: unknown,
  sem?: Semaphore,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  let parsed: unknown;
  try {
    parsed = tool.zodSchema.parse(args ?? {});
  } catch (e) {
    if (e instanceof z.ZodError) {
      // zod 4 renamed ZodError.errors → .issues; same shape per item.
      throw new Error(
        `Invalid arguments for ${tool.name}: ${e.issues
          .map((er) => `${er.path.join(".")} ${er.message}`)
          .join("; ")}`,
      );
    }
    throw e;
  }
  const exec = async (): Promise<ToolCallResult> => {
    const result = await tool.handler(parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  };
  // Handler errors propagate (through the Semaphore) and become a JSON-RPC
  // error response — the -32603 envelope the target clients feed the model.
  return sem ? sem.run(exec) : exec();
}

export async function registerTools(
  server: Server,
  client: SearxngClient,
  config: SearxngConfig,
): Promise<void> {
  // Config is passed in (rather than fetched here) so the entrypoint can probe
  // SearXNG once for both the startup log and the dynamic tool descriptions — a
  // second /config round-trip during MCP setup would also create a tiny window
  // where the descriptions could disagree with the engine count we printed.
  const tools = buildTools(client, config);
  const sem = new Semaphore(MAX_CONCURRENT_TOOL_CALLS);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await dispatchToolCall(
      tools,
      req.params.name,
      req.params.arguments,
      sem,
    );
    return { content: r.content };
  });
}
