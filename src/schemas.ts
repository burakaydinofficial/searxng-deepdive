// Zod schemas for tool inputs. Single source of truth for both runtime
// validation and the JSON schema we hand to the MCP client.
//
// Each .describe() string becomes part of the schema the LLM sees. Treat
// these as agent-facing copy: terse but specific, and oriented toward the
// agent's decision ("when do I reach for this knob?"). Critical rule:
// don't claim a default that the code doesn't actually apply — the model
// will assume the documented default holds when it omits the field, and
// silently get different behavior than expected.

import { z } from "zod";

const pageno = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "1-indexed starting page number. Default 1. Higher pages fetch additional results from each engine, deduplicated against earlier pages by URL. Per-page yield drops sharply after the first 1-2 pages as engines exhaust their result pools.",
  );

const pages = z
  .number()
  .int()
  .min(1)
  .max(5)
  .optional()
  .describe(
    "Multi-page fanout: fetch this many consecutive pages in parallel and merge with URL-based dedup. Default 1. Combines with pageno: pageno=3 + pages=2 fetches pages 3 and 4. Diminishing returns past page 2 (engines exhaust their result pools); going wide may also rate-limit upstream engines. Capped at 5 to bound token cost.",
  );

const timeRange = z
  .enum(["day", "week", "month", "year"])
  .optional()
  .describe(
    "Filter to results published within this time window. WARNING: not all engines implement time-range filtering — some (notably academic engines) return ZERO results when this is set instead of ignoring it. Set time_range only when freshness genuinely matters; if a query returns 0 results with time_range set, retry without it.",
  );

const language = z
  .string()
  .optional()
  .describe(
    "Language filter, e.g. 'en', 'fr', 'de', 'pt-BR', or 'all' to disable filtering. If omitted, the SearXNG instance's configured default applies (NOT autodetected from the query, despite what the name suggests).",
  );

const safeSearch = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .optional()
  .describe(
    "Safe-search level. 0 = off, 1 = moderate, 2 = strict. If omitted, the SearXNG instance's configured default applies (often 0 for self-hosted, but not guaranteed).",
  );

const format = z
  .enum(["full", "compact"])
  .optional()
  .describe(
    "'compact' (default) returns only url/title/content/engine for each result — typically much smaller, recommended for ranking and triage. 'full' adds: relevance score, publishedDate, the list of all engines that surfaced the result, and engine-specific metadata (authors, DOI, etc. for academic engines). Switch to 'full' only when you specifically need one of those fields.",
  );

// `.trim().min(1)` rejects whitespace-only queries before they hit SearXNG
// (which would otherwise just return empty silently).
const query = z
  .string()
  .trim()
  .min(1, "query cannot be empty or whitespace-only")
  .describe(
    "Plain-language search query. Forwarded to each engine's native parser; engine-specific operators (e.g. site:, filetype:) are passed through unchanged.",
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
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      "Engine names to use, lowercase. Multiple engines run in parallel and results are merged. Must match this instance's enabled engines (the available list is enumerated in this tool's description above).",
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
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      "Category names to constrain the search. SearXNG runs every engine tagged with these categories. The available categories are enumerated in this tool's description above.",
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

// ============================================================================
// web_url_read input
// ============================================================================
export const WebUrlReadInput = z.object({
  url: z
    .string()
    .url()
    .refine(
      (u) => u.startsWith("http://") || u.startsWith("https://"),
      "URL must use http or https scheme",
    )
    .describe(
      "HTTP(S) URL to fetch and convert to Markdown. Static pages only — for JavaScript-rendered SPAs and bot-protected sites, use a Chromium-backed reader instead.",
    ),
  readHeadings: z
    .boolean()
    .optional()
    .describe(
      "When true, returns ONLY the page's heading list as a hierarchical TOC (token-cheap survey). Pair with a follow-up call using `section` to read the chunk you actually want.",
    ),
  section: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Substring match against headings (case-insensitive). Returns content under the FIRST heading containing this text, up to the next heading at the same or higher level. Use after readHeadings to read a targeted section without dumping the whole page.",
    ),
  paragraphRange: z
    .string()
    .regex(/^\d+(-\d+)?$/, "Use 'N' or 'N-M' format, e.g. '5' or '3-7'")
    .optional()
    .describe(
      "1-indexed paragraph range, syntax 'N' or 'N-M' (e.g. '3-7' for paragraphs 3–7, '5' for paragraph 5 alone). Useful for sequential reading of long pages without re-fetching.",
    ),
  startChar: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset where extraction begins. Default 0."),
  maxLength: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Maximum characters to return. Use with startChar for paginated reading; the response includes `total_length` and `truncated` so you can plan follow-up calls.",
    ),
});

export type WebUrlReadInputT = z.infer<typeof WebUrlReadInput>;
