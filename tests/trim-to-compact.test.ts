import { describe, it, expect } from "vitest";
import { trimToCompact } from "../src/tools.js";
import type { SearchResponse, SearchResult } from "../src/searxng.js";

function r(partial: Partial<SearchResult> & Pick<SearchResult, "url">): SearchResult {
  return {
    title: "t",
    content: "c",
    engine: "google",
    score: 0.5,
    publishedDate: null,
    metadata: "",
    ...partial,
  } as SearchResult;
}

const baseResp: SearchResponse = {
  query: "x",
  number_of_results: 3,
  results: [r({ url: "u1" }), r({ url: "u2" }), r({ url: "u3" })],
  unresponsive_engines: [],
};

describe("trimToCompact", () => {
  it("strips each result down to url/title/content/engine — exactly 4 keys", () => {
    const out = trimToCompact(baseResp, 1, {});
    for (const result of out.results) {
      expect(Object.keys(result).sort()).toEqual([
        "content",
        "engine",
        "title",
        "url",
      ]);
    }
  });

  it("reports result_count matching the array length", () => {
    const out = trimToCompact(baseResp, 1, {});
    expect(out.result_count).toBe(3);
    expect(out.result_count).toBe(out.results.length);
  });

  it("preserves the pages_fetched value passed in", () => {
    expect(trimToCompact(baseResp, 1, {}).pages_fetched).toBe(1);
    expect(trimToCompact(baseResp, 5, {}).pages_fetched).toBe(5);
  });

  it("normalizes unresponsive_engines to [] when upstream value is undefined", () => {
    const resp: SearchResponse = {
      ...baseResp,
      unresponsive_engines: undefined,
    };
    expect(trimToCompact(resp, 1, {}).unresponsive_engines).toEqual([]);
  });

  it("normalizes unresponsive_engines to [] when upstream value is null", () => {
    const resp: SearchResponse = {
      ...baseResp,
      unresponsive_engines: null as unknown as unknown[],
    };
    expect(trimToCompact(resp, 1, {}).unresponsive_engines).toEqual([]);
  });

  it("attaches a hint field when zero results AND a hint condition matches", () => {
    const empty: SearchResponse = {
      query: "x",
      number_of_results: 0,
      results: [],
      unresponsive_engines: [],
    };
    const out = trimToCompact(empty, 1, { time_range: "month" });
    expect(out.hint).toBeDefined();
    expect(out.hint).toMatch(/time_range/);
  });

  it("omits the hint field entirely when no hint condition applies (not 'hint: undefined')", () => {
    const out = trimToCompact(baseResp, 1, {});
    expect("hint" in out).toBe(false);
    // JSON.stringify check: an undefined `hint` would stringify away, but a
    // present `hint: undefined` would also stringify away — so the only
    // robust check is the property existence.
  });
});
