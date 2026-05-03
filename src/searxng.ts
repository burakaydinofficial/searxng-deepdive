// Thin SearXNG HTTP client. Two operations matter for v0.1:
//   - getConfig() introspects /config to learn what engines/categories are
//     enabled on the instance. We use this to bake the actual live engine
//     list into our tool descriptions so the agent sees what's available.
//   - search() / searchMultiPage() hit /search?format=json with our params.

import { request } from "undici";

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
    const { body, statusCode } = await request(`${this.baseUrl}/config`);
    if (statusCode >= 400) {
      throw new Error(`SearXNG /config returned HTTP ${statusCode}`);
    }
    const config = (await body.json()) as ConfigResponse;

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
    if (statusCode >= 400) {
      throw new Error(`SearXNG /search returned HTTP ${statusCode}`);
    }
    return (await body.json()) as SearchResponse;
  }

  // Fan out N consecutive pages, merge with URL-based dedup. Errors on a
  // single page don't fail the whole call -- they're reported in the merged
  // unresponsive_engines list.
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
    const unresponsiveAccum: unknown[] = [];
    let totalCount = 0;
    let successfulPages = 0;

    for (const settled of responses) {
      if (settled.status !== "fulfilled") continue;
      successfulPages++;
      const resp = settled.value;
      totalCount = Math.max(totalCount, resp.number_of_results ?? 0);
      for (const r of resp.results) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        merged.push(r);
      }
      for (const u of resp.unresponsive_engines ?? []) {
        unresponsiveAccum.push(u);
      }
    }

    return {
      query: params.query,
      number_of_results: totalCount,
      results: merged,
      unresponsive_engines: unresponsiveAccum,
      pages_fetched: successfulPages,
    };
  }
}
