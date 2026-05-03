// Zod schemas for tool inputs. Single source of truth for both runtime
// validation and the JSON schema we hand to the MCP client.
//
// Each .describe() string becomes part of the schema the LLM sees. Treat
// these as agent-facing copy: terse but specific, and oriented toward the
// agent's decision ("when do I reach for this knob?").

import { z } from "zod";

const pageno = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "1-indexed starting page number. Default 1. Each engine paginates independently; page 2 returns the next ~10 results from each.",
  );

const pages = z
  .number()
  .int()
  .min(1)
  .max(5)
  .optional()
  .describe(
    "Multi-page fanout: fetch this many consecutive pages and merge results with URL-based dedup. Default 1 (single page). Use pages=3 to roughly triple the result set in one call. Capped at 5 to bound token cost.",
  );

const timeRange = z
  .enum(["day", "week", "month", "year"])
  .optional()
  .describe(
    "Filter to results published within this time window. Useful for news-flavored queries where freshness matters; ignored by engines that don't support it.",
  );

const language = z
  .string()
  .optional()
  .describe(
    "BCP 47 language code (e.g. 'en', 'fr', 'de') or 'all'. Default 'auto' (let SearXNG pick from the query).",
  );

const safeSearch = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .optional()
  .describe("0 = off, 1 = moderate, 2 = strict. Default 0.");

const format = z
  .enum(["full", "compact"])
  .optional()
  .describe(
    "'compact' (default) trims each result to url/title/content/engine — uses ~80% fewer tokens, recommended for ranking and triage. 'full' returns SearXNG's complete result objects (extra metadata, scores, links). Switch to 'full' only when you need fields beyond the basics.",
  );

const query = z
  .string()
  .min(1)
  .describe(
    "Plain-language search query. Forwarded to each engine's native parser; engine-specific operators (e.g. site:, filetype:) are passed through.",
  );

export const SearchInput = z.object({
  query,
  pageno,
  pages,
  time_range: timeRange,
  language,
  safe_search: safeSearch,
  format,
});

export const SearchOnEnginesInput = z.object({
  query,
  engines: z
    .array(z.string())
    .min(1)
    .describe(
      "Engine names to use (must match this instance's enabled list — see this tool's description for the live list). Multiple engines run in parallel and results are merged.",
    ),
  pageno,
  pages,
  time_range: timeRange,
  language,
  safe_search: safeSearch,
  format,
});

export const SearchByCategoryInput = z.object({
  query,
  categories: z
    .array(z.string())
    .min(1)
    .describe(
      "Category names to constrain the search. SearXNG runs every engine tagged with these categories. See this tool's description for the available list and which engines belong to each.",
    ),
  pageno,
  pages,
  time_range: timeRange,
  language,
  safe_search: safeSearch,
  format,
});

export type SearchInputT = z.infer<typeof SearchInput>;
export type SearchOnEnginesInputT = z.infer<typeof SearchOnEnginesInput>;
export type SearchByCategoryInputT = z.infer<typeof SearchByCategoryInput>;
