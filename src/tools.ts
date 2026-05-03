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

async function doSearch(
  client: SearxngClient,
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
      handler: (input) => doSearch(client, input as SearchInputT),
    },
    {
      name: "search_on_engines",
      description: searchOnEnginesDescription(config),
      inputSchema: zodToJsonSchema(SearchOnEnginesInput),
      zodSchema: SearchOnEnginesInput as ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchOnEnginesInputT;
        return doSearch(client, { ...i, engines: i.engines });
      },
    },
    {
      name: "search_by_category",
      description: searchByCategoryDescription(config),
      inputSchema: zodToJsonSchema(SearchByCategoryInput),
      zodSchema: SearchByCategoryInput as ZodType<unknown>,
      handler: (input) => {
        const i = input as SearchByCategoryInputT;
        return doSearch(client, { ...i, categories: i.categories });
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
