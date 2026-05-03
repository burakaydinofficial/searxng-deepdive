import { describe, it, expect } from "vitest";
import {
  buildZeroResultHint,
  type ZeroResultContext,
} from "../src/tools.js";
import type { SearchResponse } from "../src/searxng.js";

const empty = (
  partial: Partial<SearchResponse> = {},
): SearchResponse => ({
  query: "x",
  number_of_results: 0,
  results: [],
  unresponsive_engines: [],
  ...partial,
});

describe("buildZeroResultHint", () => {
  it("returns undefined when there are results (short-circuit)", () => {
    const resp: SearchResponse = {
      query: "x",
      number_of_results: 1,
      results: [
        { url: "u", title: "t", content: "c", engine: "google" },
      ],
      unresponsive_engines: [],
    };
    expect(buildZeroResultHint(resp, {})).toBeUndefined();
  });

  it("returns undefined for zero results with no diagnostic context", () => {
    expect(buildZeroResultHint(empty(), {})).toBeUndefined();
  });

  it("hints when time_range was set and results are empty", () => {
    const ctx: ZeroResultContext = { time_range: "month" };
    const hint = buildZeroResultHint(empty(), ctx);
    expect(hint).toBeDefined();
    expect(hint).toMatch(/time_range="month"/);
    expect(hint).toMatch(/without time_range/);
  });

  it("does not name specific engines in the time_range hint (engine-agnostic)", () => {
    // Earlier versions hardcoded 'arxiv, pubmed, semantic scholar' — that's
    // an opinionated claim that may not generalize. Keep it generic.
    const ctx: ZeroResultContext = { time_range: "year" };
    const hint = buildZeroResultHint(empty(), ctx)!;
    expect(hint).not.toMatch(/arxiv/i);
    expect(hint).not.toMatch(/pubmed/i);
    expect(hint).not.toMatch(/semantic scholar/i);
    expect(hint).not.toMatch(/wikimedia/i);
  });

  it("hints when all explicitly-requested engines were unresponsive", () => {
    const resp = empty({
      unresponsive_engines: [["google", "timeout"], ["bing", "captcha"]],
    });
    const ctx: ZeroResultContext = { engines: ["google", "bing"] };
    const hint = buildZeroResultHint(resp, ctx)!;
    expect(hint).toMatch(/All 2 requested engine/);
  });

  it("hints when SOME engines were unresponsive AND no engines were specified (broad-search blind spot — B2 fix)", () => {
    // The bug this guards against: broad `search` tool with rate-limited
    // upstream engines returns 0 results. Without this hint the model
    // blames its query and retries with rephrasings forever.
    const resp = empty({
      unresponsive_engines: [
        ["google", "timeout"],
        ["bing", "captcha"],
        ["brave", "rate limit"],
      ],
    });
    const ctx: ZeroResultContext = {}; // broad search — no engines/categories
    const hint = buildZeroResultHint(resp, ctx);
    expect(hint).toBeDefined();
    expect(hint).toMatch(/3 engine/);
    expect(hint).toMatch(/upstream/);
  });

  it("hints when a single engine was queried and returned nothing", () => {
    const ctx: ZeroResultContext = { engines: ["mojeek"] };
    const hint = buildZeroResultHint(empty(), ctx);
    expect(hint).toMatch(/Only one engine/);
    expect(hint).toMatch(/mojeek/);
  });

  it("does not crash when unresponsive_engines is null", () => {
    // SearXNG sometimes returns null instead of [] for this field.
    const resp = empty({
      unresponsive_engines: null as unknown as unknown[],
    });
    expect(() => buildZeroResultHint(resp, {})).not.toThrow();
    expect(buildZeroResultHint(resp, {})).toBeUndefined();
  });

  it("composes time_range + unresponsive when both apply", () => {
    const resp = empty({
      unresponsive_engines: [["google", "timeout"]],
    });
    const ctx: ZeroResultContext = {
      time_range: "month",
      engines: ["google"],
    };
    const hint = buildZeroResultHint(resp, ctx)!;
    expect(hint).toMatch(/time_range/);
    expect(hint).toMatch(/All 1 requested engine/);
  });
});
