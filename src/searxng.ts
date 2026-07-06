// Thin SearXNG HTTP client. Two operations matter for v0.1:
//   - getConfig() introspects /config to learn what engines/categories are
//     enabled on the instance. We use this to bake the actual live engine
//     list into our tool descriptions so the agent sees what's available.
//   - search() / searchMultiPage() hit /search?format=json with our params.

import { request } from "undici";
import { readTextWithCap } from "./stream-read.js";

// Bound how much of a /config or /search response we buffer. A misconfigured
// or malicious/compromised instance returning an enormous body would otherwise
// balloon memory. Generous enough never to truncate a legitimate JSON response.
const MAX_SEARXNG_BYTES = 25 * 1024 * 1024;

// Trim a response body for inclusion in an error message. Caps at ~200
// chars and squashes whitespace runs so an HTML 502 page doesn't dump
// hundreds of useless tags into the error.
function snippetOf(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// Names in the /config response are interpolated verbatim into agent-facing
// tool descriptions and error messages. A malicious, compromised, or MITM'd
// SearXNG instance (the default transport is plaintext http://) could embed
// newlines/control chars to forge an authoritative "system" directive inside a
// description, or an absurdly long string to bloat it. Sanitize at this
// boundary so both descriptions and error strings are covered. Legitimate
// engine/category names are short and control-char-free, so this is a no-op
// for them.
const MAX_CONFIG_NAME_LEN = 64;

// Code points to neutralize in /config-derived names: C0 controls, DEL, C1
// controls, and bidi/zero-width format chars — all can forge visual structure
// (newline-forged "directives") or hide/reorder content in an agent-facing
// description. Checked by code point so no such byte appears in this source.
function isStrippableCodePoint(cp: number): boolean {
  return (
    cp < 0x20 || // C0 controls (incl. newline/tab)
    cp === 0x7f || // DEL
    (cp >= 0x80 && cp <= 0x9f) || // C1 controls
    cp === 0x061c || // Arabic letter mark
    (cp >= 0x200b && cp <= 0x200f) || // zero-width + LRM/RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
    cp === 0xfeff // BOM / zero-width no-break space
  );
}

function sanitizeConfigName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = Array.from(name, (ch) =>
    isStrippableCodePoint(ch.codePointAt(0)!) ? " " : ch,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_CONFIG_NAME_LEN
    ? cleaned.slice(0, MAX_CONFIG_NAME_LEN) + "…"
    : cleaned;
}

// Normalize a result URL for cross-page dedup: drop the fragment and a single
// trailing slash (scheme/host are lowercased by URL). The query string is
// kept, since it frequently distinguishes genuinely different resources. Falls
// back to the raw string for anything that isn't a parseable absolute URL.
function dedupKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return raw;
  }
}

export type TimeRange = "day" | "week" | "month" | "year";
export type SafeSearch = 0 | 1 | 2;

export interface SearchParams {
  query: string;
  engines?: string[];
  categories?: string[];
  pageno?: number;
  time_range?: TimeRange;
  language?: string;
  safe_search?: SafeSearch;
}

export interface SearchResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  engines?: string[];
  score?: number;
  category?: string;
  publishedDate?: string | null;
  metadata?: string;
  [key: string]: unknown;
}

export interface SearchResponse {
  query: string;
  number_of_results: number;
  results: SearchResult[];
  answers?: unknown[];
  corrections?: unknown[];
  infoboxes?: unknown[];
  suggestions?: unknown[];
  unresponsive_engines?: unknown[];
}

interface ConfigEngineEntry {
  name: string;
  categories: string[];
  enabled: boolean;
}

interface ConfigResponse {
  engines: ConfigEngineEntry[];
}

export interface SearxngConfig {
  enabledEngines: string[];
  enabledCategories: string[];
  // category -> sorted list of engines in it
  enginesByCategory: Record<string, string[]>;
}

export class SearxngClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getConfig(): Promise<SearxngConfig> {
    const { body, statusCode } = await request(`${this.baseUrl}/config`, {
      headersTimeout: 10_000,
      bodyTimeout: 15_000,
    });

    // Read as text first so we can fall back gracefully if SearXNG returns
    // HTML (e.g. Cloudflare 502 page) or some other non-JSON body. Without
    // this, JSON.parse throws a bare SyntaxError that gives the caller no
    // useful diagnostic. Capped so a runaway body can't exhaust memory.
    const { text, truncated } = await readTextWithCap(body, MAX_SEARXNG_BYTES);
    if (truncated) {
      throw new Error(
        `SearXNG /config response exceeded ${MAX_SEARXNG_BYTES} bytes; refusing to buffer it.`,
      );
    }
    if (statusCode >= 400) {
      throw new Error(
        `SearXNG /config returned HTTP ${statusCode}: ${snippetOf(text)}`,
      );
    }
    let config: ConfigResponse;
    try {
      config = JSON.parse(text) as ConfigResponse;
    } catch {
      throw new Error(
        `SearXNG /config returned non-JSON (HTTP ${statusCode}): ${snippetOf(text)}`,
      );
    }

    const enabledEngines: string[] = [];
    const categorySet = new Set<string>();
    const enginesByCategory: Record<string, string[]> = {};

    for (const engine of config.engines ?? []) {
      if (!engine.enabled) continue;
      const name = sanitizeConfigName(engine.name);
      if (!name) continue;
      enabledEngines.push(name);
      for (const rawCat of engine.categories ?? []) {
        const cat = sanitizeConfigName(rawCat);
        if (!cat) continue;
        categorySet.add(cat);
        (enginesByCategory[cat] ??= []).push(name);
      }
    }

    enabledEngines.sort();
    for (const cat of categorySet) {
      enginesByCategory[cat]!.sort();
    }

    return {
      enabledEngines,
      enabledCategories: [...categorySet].sort(),
      enginesByCategory,
    };
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("format", "json");
    if (params.engines?.length) {
      url.searchParams.set("engines", params.engines.join(","));
    }
    if (params.categories?.length) {
      url.searchParams.set("categories", params.categories.join(","));
    }
    if (params.pageno && params.pageno > 1) {
      url.searchParams.set("pageno", String(params.pageno));
    }
    if (params.time_range) {
      url.searchParams.set("time_range", params.time_range);
    }
    if (params.language) {
      url.searchParams.set("language", params.language);
    }
    if (params.safe_search !== undefined) {
      url.searchParams.set("safesearch", String(params.safe_search));
    }

    const { body, statusCode } = await request(url.href, {
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });

    const { text, truncated } = await readTextWithCap(body, MAX_SEARXNG_BYTES);
    if (truncated) {
      throw new Error(
        `SearXNG /search response exceeded ${MAX_SEARXNG_BYTES} bytes; refusing to buffer it.`,
      );
    }
    if (statusCode >= 400) {
      const rateLimited =
        statusCode === 429
          ? " — instance is rate-limiting; reduce pages, wait, or target fewer engines"
          : "";
      throw new Error(
        `SearXNG /search returned HTTP ${statusCode}${rateLimited}: ${snippetOf(text)}`,
      );
    }
    try {
      return JSON.parse(text) as SearchResponse;
    } catch {
      throw new Error(
        `SearXNG /search returned non-JSON (HTTP ${statusCode}): ${snippetOf(text)}`,
      );
    }
  }

  // Fan out N consecutive pages, merge with URL-based dedup. Errors on
  // *some* pages don't fail the whole call. Errors on *all* pages do —
  // otherwise the caller silently gets {results: [], pages_fetched: 0}
  // and the model assumes the query was bad rather than upstream being
  // unreachable.
  //
  // The `unresponsive_engines` accumulator dedupes by JSON-stringified
  // shape, since SearXNG returns engine-failure entries as `[engine, reason]`
  // tuples and reporting the same engine N times across N pages misleads
  // the model into thinking N engines failed when only one did.
  async searchMultiPage(
    params: SearchParams & { pages: number },
  ): Promise<SearchResponse & { pages_fetched: number }> {
    const startPage = params.pageno ?? 1;
    const pageNumbers = Array.from(
      { length: params.pages },
      (_, i) => startPage + i,
    );

    const responses = await Promise.allSettled(
      pageNumbers.map((p) => this.search({ ...params, pageno: p })),
    );

    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    const unresponsiveSeen = new Set<string>();
    const unresponsiveAccum: unknown[] = [];
    let successfulPages = 0;
    const failures: unknown[] = [];

    for (const settled of responses) {
      if (settled.status !== "fulfilled") {
        failures.push(settled.reason);
        continue;
      }
      successfulPages++;
      const resp = settled.value;
      for (const r of resp.results) {
        const key = dedupKey(r.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      const upstream = Array.isArray(resp.unresponsive_engines)
        ? resp.unresponsive_engines
        : [];
      for (const u of upstream) {
        const key = JSON.stringify(u);
        if (unresponsiveSeen.has(key)) continue;
        unresponsiveSeen.add(key);
        unresponsiveAccum.push(u);
      }
    }

    if (successfulPages === 0 && failures.length > 0) {
      const first = failures[0];
      const msg = first instanceof Error ? first.message : String(first);
      throw new Error(
        `searchMultiPage: all ${pageNumbers.length} requested page(s) failed. First error: ${msg}`,
      );
    }

    return {
      query: params.query,
      // `number_of_results` here reports the merged result count, not the
      // upstream estimate. SearXNG's per-page estimate fluctuates and would
      // contradict the actual array length the caller is reading.
      number_of_results: merged.length,
      results: merged,
      unresponsive_engines: unresponsiveAccum,
      pages_fetched: successfulPages,
    };
  }
}
