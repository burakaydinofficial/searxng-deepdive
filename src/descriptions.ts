// Tool descriptions are generated at server startup from the live SearXNG
// /config response. The agent sees the actual list of enabled engines and
// categories on the user's instance — not a generic boilerplate copy.

import type { SearxngConfig } from "./searxng.js";

export function searchDescription(_cfg: SearxngConfig): string {
  return [
    "Broad web search across the SearXNG instance's full enabled engine pool.",
    "",
    "Use this for general-purpose queries when you don't have a specific source preference.",
    "Returns a merged, deduplicated result list from many engines (typically 80–200 results",
    "per page after dedup, depending on which engines respond at query time).",
    "",
    "Knobs:",
    "  • pages=N (max 5) — fetch multiple pages and merge for more results in one call.",
    "  • format='full' — full result objects with metadata; default 'compact' is token-efficient.",
    "  • time_range — narrow to recent results.",
    "",
    "When to reach for a different tool:",
    "  • search_on_engines    — you want specific sources (e.g. just ArXiv + PubMed)",
    "  • search_by_category   — you want all engines in a category (e.g. all science)",
  ].join("\n");
}

export function searchOnEnginesDescription(cfg: SearxngConfig): string {
  return [
    "Search using ONLY the specified engines.",
    "",
    "Use when you have a specific source preference: 'just ArXiv and Semantic Scholar',",
    "'use only DuckDuckGo for fast triage', 'compare Google vs Brave on the same query'.",
    "",
    `Available engines on this instance (${cfg.enabledEngines.length} total):`,
    `  ${cfg.enabledEngines.join(", ")}`,
    "",
    "Pass engine names exactly as listed above. Engines not in this list will be ignored.",
    "Multi-page fanout (pages=N) and other knobs work the same as the broad `search` tool.",
  ].join("\n");
}

export function searchByCategoryDescription(cfg: SearxngConfig): string {
  const categoryLines = cfg.enabledCategories.map((cat) => {
    const engines = cfg.enginesByCategory[cat] ?? [];
    const sample = engines.slice(0, 5).join(", ");
    const more = engines.length > 5 ? `, +${engines.length - 5} more` : "";
    return `  • ${cat} (${engines.length}): ${sample}${more}`;
  });

  return [
    "Search within one or more categories — runs every engine tagged with each.",
    "",
    "Use when you want broad coverage of a content type without enumerating engines:",
    "  'all science engines for X', 'all news engines for X', 'all IT/code engines for X'.",
    "",
    "Available categories on this instance:",
    ...categoryLines,
    "",
    "Pass category names exactly as listed above. Multi-page fanout (pages=N) and other",
    "knobs work the same as the broad `search` tool.",
  ].join("\n");
}
