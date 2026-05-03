// Tool registration. Three tools, all backed by a single doSearch() that
// applies the format=compact trim and (optionally) multi-page fanout.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
  type SearchInputT,
  type SearchOnEnginesInputT,
  type SearchByCategoryInputT,
} from "./schemas.js";
import {
  searchDescription,
  searchOnEnginesDescription,
  searchByCategoryDescription,
} from "./descriptions.js";

interface ToolDef<T> {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  zodSchema: ZodType<T>;
  handler: (input: T) => Promise<unknown>;
}

interface CompactResult {
  url: string;
  title: string;
  content: string;
  engine: string;
}

interface CompactResponse {
  query: string;
  result_count: number;
  pages_fetched: number;
  unresponsive_engines: unknown[];
  results: CompactResult[];
}

function trimToCompact(
  resp: SearchResponse,
  pagesFetched: number,
): CompactResponse {
  return {
    query: resp.query,
    result_count: resp.results.length,
    pages_fetched: pagesFetched,
    unresponsive_engines: resp.unresponsive_engines ?? [],
    results: resp.results.map((r: SearchResult) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      engine: r.engine,
    })),
  };
}

// Cross-validate engine/category names against the live config. The most
// common LLM mistake we've seen is passing engine names where categories
// belong (e.g. categories=["arxiv","pubmed"]). Without validation, SearXNG
// silently ignores unknown values and falls back to defaults — the model
// sees "60 results" and assumes success even though the search ran on the
// wrong engines. This converts that into a loud error with a "did you
// mean" hint.
function validateEngineSelection(
  engines: string[],
  config: SearxngConfig,
): void {
  const invalid = engines.filter((e) => !config.enabledEngines.includes(e));
  if (invalid.length === 0) return;

  const matchedCategories = invalid.filter((e) =>
    config.enabledCategories.includes(e),
  );
  const hint =
    matchedCategories.length > 0
      ? ` ${matchedCategories.length === 1 ? "Note" : "Note"}: ${matchedCategories
          .map((c) => `"${c}"`)
          .join(", ")} ${matchedCategories.length === 1 ? "is a category" : "are categories"}, not engines. Use the \`search_by_category\` tool with those.`
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

function validateCategorySelection(
  categories: string[],
  config: SearxngConfig,
): void {
  const invalid = categories.filter(
    (c) => !config.enabledCategories.includes(c),
  );
  if (invalid.length === 0) return;

  const matchedEngines = invalid.filter((c) =>
    config.enabledEngines.includes(c),
  );
  const hint =
    matchedEngines.length > 0
      ? ` ${matchedEngines.length === 1 ? "Note" : "Note"}: ${matchedEngines
          .map((e) => `"${e}"`)
          .join(", ")} ${matchedEngines.length === 1 ? "is an engine" : "are engines"}, not categories. Use the \`search_on_engines\` tool with those.`
      : "";

  throw new Error(
    `Invalid categor${invalid.length > 1 ? "ies" : "y"}: ${invalid.map((c) => `"${c}"`).join(", ")}.${hint} Available categories on this instance: ${config.enabledCategories.join(", ")}.`,
  );
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
  if (input.categories?.length) validateCategorySelection(input.categories, config);

  const pages = input.pages ?? 1;
  const format = input.format ?? "compact";

  if (pages > 1) {
    const resp = await client.searchMultiPage({
      query: input.query,
      engines: input.engines,
      categories: input.categories,
      pageno: input.pageno ?? 1,
      pages,
      time_range: input.time_range,
      language: input.language,
      safe_search: input.safe_search,
    });
    return format === "full" ? resp : trimToCompact(resp, resp.pages_fetched);
  }

  const resp = await client.search({
    query: input.query,
    engines: input.engines,
    categories: input.categories,
    pageno: input.pageno,
    time_range: input.time_range,
    language: input.language,
    safe_search: input.safe_search,
  });
  return format === "full" ? resp : trimToCompact(resp, 1);
}

export async function registerTools(
  server: Server,
  client: SearxngClient,
): Promise<void> {
  const config = await client.getConfig();

  const tools: ToolDef<unknown>[] = [
    {
      name: "search",
      description: searchDescription(config),
      inputSchema: zodToJsonSchema(SearchInput),
      zodSchema: SearchInput as ZodType<unknown>,
      handler: (input) => doSearch(client, config, input as SearchInputT),
    },
    {
      name: "search_on_engines",
      description: searchOnEnginesDescription(config),
      inputSchema: zodToJsonSchema(SearchOnEnginesInput),
      zodSchema: SearchOnEnginesInput as ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchOnEnginesInputT;
        return doSearch(client, config, { ...i, engines: i.engines });
      },
    },
    {
      name: "search_by_category",
      description: searchByCategoryDescription(config),
      inputSchema: zodToJsonSchema(SearchByCategoryInput),
      zodSchema: SearchByCategoryInput as ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchByCategoryInputT;
        return doSearch(client, config, { ...i, categories: i.categories });
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    let parsed: unknown;
    try {
      parsed = tool.zodSchema.parse(req.params.arguments ?? {});
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new Error(
          `Invalid arguments for ${tool.name}: ${e.errors
            .map((er) => `${er.path.join(".")} ${er.message}`)
            .join("; ")}`,
        );
      }
      throw e;
    }
    const result = await tool.handler(parsed);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  });
}
