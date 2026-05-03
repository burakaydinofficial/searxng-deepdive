// Thin SearXNG HTTP client. Two operations matter for v0.1:
//   - getConfig() introspects /config to learn what engines/categories are
//     enabled on the instance. We use this to bake the actual live engine
//     list into our tool descriptions so the agent sees what's available.
//   - search() / searchMultiPage() hit /search?format=json with our params.

import { request } from "undici";

// Trim a response body for inclusion in an error message. Caps at ~200
// chars and squashes whitespace runs so an HTML 502 page doesn't dump
// hundreds of useless tags into the error.
function snippetOf(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
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
    // useful diagnostic.
    const text = await body.text();
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
      enabledEngines.push(engine.name);
      for (const cat of engine.categories ?? []) {
        categorySet.add(cat);
        (enginesByCategory[cat] ??= []).push(engine.name);
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

    const text = await body.text();
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
        if (seen.has(r.url)) continue;
        seen.add(r.url);
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
