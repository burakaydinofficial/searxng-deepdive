// Tool descriptions are generated at server startup from the live SearXNG
// /config response. The agent sees the actual list of enabled engines and
// categories on the user's instance — not a generic boilerplate copy.

import type { SearxngConfig } from "./searxng.js";

export function searchDescription(cfg: SearxngConfig): string {
  return [
    "Broad web search across the SearXNG instance's full enabled engine pool.",
    "",
    `Use this for general-purpose queries when you don't have a specific source preference. Returns a merged, deduplicated result list from across the ${cfg.enabledEngines.length} enabled engines on this instance — actual yield depends on which engines respond at query time.`,
    "",
    "Knobs:",
    "  • pages=N (max 5) — fetch multiple pages and merge for more results in one call.",
    "  • format='full' — full result objects with metadata; default 'compact' is token-efficient.",
    "  • time_range — narrow to recent results (note: not all engines support this — see field doc).",
    "",
    "When to reach for a different tool:",
    "  • search_on_engines    — you want specific sources (e.g. just ArXiv + PubMed)",
    "  • search_by_category   — you want all engines in a category (e.g. all science)",
  ].join("\n");
}

export function searchOnEnginesDescription(cfg: SearxngConfig): string {
  // Pick a science-shaped example if we have one, otherwise fall back to
  // whatever's available, so the example is never misleading.
  const has = (n: string) => cfg.enabledEngines.includes(n);
  const academic = ["arxiv", "semantic scholar", "pubmed"].filter(has);
  const exampleAcademic = academic.length >= 2
    ? `engines: [${academic.map((e) => JSON.stringify(e)).join(", ")}]`
    : `engines: [${cfg.enabledEngines.slice(0, 2).map((e) => JSON.stringify(e)).join(", ")}]`;

  return [
    "Search using ONLY the specified engines.",
    "",
    "Use when you have a specific source preference: 'just ArXiv and Semantic Scholar',",
    "'use only DuckDuckGo for fast triage', 'compare Google vs Brave on the same query'.",
    "",
    "============================================================",
    "VALID `engines` values are the engine names listed below.",
    "DO NOT pass category names here (use search_by_category for those).",
    "============================================================",
    "",
    "EXAMPLES of valid invocation:",
    `  ${exampleAcademic}                    ← academic-source search`,
    `  engines: ["duckduckgo"]                                        ← single-engine triage`,
    `  engines: ["google", "brave"]                                   ← compare two engines`,
    "",
    "WRONG (these would be rejected — they are CATEGORIES, not engines):",
    "  engines: [\"science\"]                                          ❌",
    "  engines: [\"scientific publications\"]                          ❌",
    "  engines: [\"news\"]                                             ❌",
    "  → for those use search_by_category instead.",
    "",
    "Engine names are case-insensitive ('arXiv' and 'arxiv' both work),",
    "but they MUST be valid engine names — passing 'arXiv' as a category",
    "won't be rescued by case-insensitivity, you'd still get a validation error.",
    "",
    `Engine names enabled on this instance (${cfg.enabledEngines.length} total):`,
    `  ${cfg.enabledEngines.join(", ")}`,
    "",
    "Multi-page fanout (pages=N) and other knobs work the same as the broad `search` tool.",
  ].join("\n");
}

export function searchByCategoryDescription(cfg: SearxngConfig): string {
  // Show category names on their own first (the actionable list), then
  // show what engines belong to each (reference only). The earlier flat
  // "category (N): engine1, engine2, ..." format caused agents to confuse
  // engine names with category names and pass them in the categories
  // array. Examples + anti-examples below close that loop.
  const categoryReferenceLines = cfg.enabledCategories.map((cat) => {
    const engines = cfg.enginesByCategory[cat] ?? [];
    const sample = engines.slice(0, 5).join(", ");
    const more = engines.length > 5 ? `, +${engines.length - 5} more` : "";
    return `  • ${cat} → ${sample}${more}`;
  });

  // Pick concrete examples that actually exist on this instance.
  const has = (c: string) => cfg.enabledCategories.includes(c);
  const sciCat = has("scientific publications")
    ? "scientific publications"
    : has("science")
      ? "science"
      : cfg.enabledCategories[0] ?? "general";
  const newsCat = has("news") ? "news" : cfg.enabledCategories[0] ?? "general";
  const itCat = has("it") ? "it" : cfg.enabledCategories[0] ?? "general";

  return [
    "Search within one or more categories — runs every engine tagged with each.",
    "",
    "Use when you want broad coverage of a content type without enumerating engines:",
    "  'all science engines for X', 'all news engines for X', 'all IT/code engines for X'.",
    "",
    "============================================================",
    "VALID `categories` values are the names listed in 'Categories' below.",
    "DO NOT pass engine names here (use search_on_engines for those).",
    "============================================================",
    "",
    `Categories enabled on this instance: ${cfg.enabledCategories.join(", ")}`,
    "",
    "EXAMPLES of valid invocation:",
    `  categories: [${JSON.stringify(sciCat)}]                       ← all engines in '${sciCat}'`,
    `  categories: [${JSON.stringify(newsCat)}]                                          ← all '${newsCat}' engines`,
    `  categories: [${JSON.stringify(sciCat)}, ${JSON.stringify(itCat)}]               ← multiple categories combined`,
    "",
    "WRONG (these would be rejected — they are ENGINES, not categories):",
    "  categories: [\"arxiv\", \"pubmed\"]                                ❌",
    "  categories: [\"google\", \"bing\"]                                 ❌",
    "  categories: [\"arXiv\", \"Semantic Scholar\"]                      ❌  (case doesn't matter — still engines)",
    "  → for those use search_on_engines instead.",
    "",
    "For reference, which engines belong to each category:",
    ...categoryReferenceLines,
    "",
    "Multi-page fanout (pages=N) and other knobs work the same as the broad `search` tool.",
  ].join("\n");
}

export function webUrlReadDescription(): string {
  return [
    "Fetch a URL and convert its HTML content to clean Markdown.",
    "",
    "Use after `search` (or its variants) when you have a URL and want the",
    "actual page text, not just the search snippet. Lightweight HTTP +",
    "HTML→Markdown — handles ~80% of the static-HTML web (Wikipedia, docs",
    "sites, blogs, news, GitHub READMEs).",
    "",
    "What this DOES NOT handle:",
    "  • JavaScript-rendered pages (React/Vue/Angular SPAs) — content loads",
    "    after the initial HTML, which we don't execute. Returns minimal or",
    "    empty markdown for these.",
    "  • Bot-protected pages (Cloudflare challenge, captcha) — typically",
    "    fail with HTTP 403/503.",
    "  • Binary resources (PDF, images, archives) — returns an explanatory",
    "    hint instead of garbled bytes.",
    "",
    "For those cases, fall back to a Chromium-backed reader (e.g. Crawl4AI",
    "exposed via the SearXNG-Compose `reader` profile).",
    "",
    "Token-efficient extraction modes (priority order — first one set wins):",
    "  • readHeadings:true        — returns ONLY the heading list (hierarchical",
    "                                 TOC). Cheapest survey of a long page.",
    "  • section:'<text>'         — returns content under first matching",
    "                                 heading, up to the next same-or-higher",
    "                                 heading. Use after readHeadings to jump.",
    "  • paragraphRange:'3-7'     — 1-indexed paragraph slice; supports 'N'",
    "                                 (single) or 'N-M' (range).",
    "  • startChar + maxLength    — character window pagination. Response",
    "                                 includes total_length and truncated so",
    "                                 you can plan follow-up calls.",
    "",
    "If no extraction mode is set, returns the full Markdown.",
    "",
    "Recommended workflow for long pages:",
    "  1. web_url_read(url, readHeadings: true)            ← TOC scan",
    "  2. web_url_read(url, section: '<chosen heading>')   ← targeted read",
    "Far more token-efficient than fetching the full page up front.",
  ].join("\n");
}
