// Integration-shaped tests for SearxngClient — uses undici's MockAgent so
// no real SearXNG instance is required. Covers the failure modes that
// previously surfaced only in production: HTML error pages, 429 rate
// limits, malformed JSON, and the all-pages-fail path of searchMultiPage.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import { SearxngClient } from "../src/searxng.js";

const ORIGIN = "http://mock-searxng.test";

let agent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(originalDispatcher);
});

function pool() {
  return agent.get(ORIGIN);
}

describe("SearxngClient.getConfig", () => {
  it("parses /config response into enabledEngines + enabledCategories + enginesByCategory", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(200, {
        engines: [
          { name: "google", categories: ["general", "web"], enabled: true },
          { name: "arxiv", categories: ["science"], enabled: true },
          { name: "disabled-engine", categories: ["other"], enabled: false },
          { name: "pubmed", categories: ["science", "scientific publications"], enabled: true },
        ],
      });

    const client = new SearxngClient(ORIGIN);
    const cfg = await client.getConfig();

    expect(cfg.enabledEngines).toEqual(["arxiv", "google", "pubmed"]);
    expect(cfg.enabledCategories).toEqual([
      "general",
      "science",
      "scientific publications",
      "web",
    ]);
    expect(cfg.enginesByCategory).toEqual({
      general: ["google"],
      science: ["arxiv", "pubmed"],
      "scientific publications": ["pubmed"],
      web: ["google"],
    });
  });

  it("strips trailing slashes from baseUrl", async () => {
    pool().intercept({ path: "/config" }).reply(200, { engines: [] });

    const client = new SearxngClient(`${ORIGIN}//`);
    const cfg = await client.getConfig();
    expect(cfg.enabledEngines).toEqual([]);
  });

  it("excludes engines where enabled=false", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(200, {
        engines: [
          { name: "off", categories: ["x"], enabled: false },
          { name: "on", categories: ["y"], enabled: true },
        ],
      });

    const cfg = await new SearxngClient(ORIGIN).getConfig();
    expect(cfg.enabledEngines).toEqual(["on"]);
  });

  it("throws an informative error on HTTP 502 with HTML body (not a bare SyntaxError)", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(
        502,
        "<html><body><h1>502 Bad Gateway</h1><p>nginx/1.21</p></body></html>",
        { headers: { "content-type": "text/html" } },
      );

    await expect(new SearxngClient(ORIGIN).getConfig()).rejects.toThrow(
      /HTTP 502/,
    );
    await expect(new SearxngClient(ORIGIN).getConfig()).rejects.not.toThrow(
      /SyntaxError/,
    );
  });

  it("throws an informative error when the body is non-JSON despite HTTP 200", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(200, "<html>not json</html>", {
        headers: { "content-type": "text/html" },
      });

    await expect(new SearxngClient(ORIGIN).getConfig()).rejects.toThrow(
      /non-JSON/,
    );
  });

  it("includes a body snippet in the error message for diagnosis", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(503, "Service Temporarily Unavailable", {
        headers: { "content-type": "text/plain" },
      });

    await expect(new SearxngClient(ORIGIN).getConfig()).rejects.toThrow(
      /Service Temporarily Unavailable/,
    );
  });

  it("compacts whitespace in the snippet", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(500, "lots\n\n\nof\n\twhitespace");

    await expect(new SearxngClient(ORIGIN).getConfig()).rejects.toThrow(
      /lots of whitespace/,
    );
  });

  it("handles engines with no categories without crashing", async () => {
    pool()
      .intercept({ path: "/config" })
      .reply(200, {
        engines: [{ name: "weird", categories: [], enabled: true }],
      });

    const cfg = await new SearxngClient(ORIGIN).getConfig();
    expect(cfg.enabledEngines).toEqual(["weird"]);
    expect(cfg.enabledCategories).toEqual([]);
  });
});

describe("SearxngClient.search", () => {
  const minimalResp = (overrides: Record<string, unknown> = {}) => ({
    query: "x",
    number_of_results: 0,
    results: [],
    unresponsive_engines: [],
    ...overrides,
  });

  it("builds query string with only q and format=json when no optional params set", async () => {
    let capturedPath: string | undefined;
    pool()
      .intercept({ path: (p) => p.startsWith("/search") && ((capturedPath = p), true) })
      .reply(200, minimalResp());

    await new SearxngClient(ORIGIN).search({ query: "hello world" });
    expect(capturedPath).toBeDefined();
    expect(capturedPath!).toContain("q=hello+world");
    expect(capturedPath!).toContain("format=json");
    expect(capturedPath!).not.toContain("pageno=");
    expect(capturedPath!).not.toContain("language=");
    expect(capturedPath!).not.toContain("safesearch=");
    expect(capturedPath!).not.toContain("time_range=");
  });

  it("forwards engines as comma-separated", async () => {
    let capturedPath: string | undefined;
    pool()
      .intercept({ path: (p) => p.startsWith("/search") && ((capturedPath = p), true) })
      .reply(200, minimalResp());

    await new SearxngClient(ORIGIN).search({
      query: "x",
      engines: ["arxiv", "pubmed"],
    });
    expect(capturedPath!).toContain("engines=arxiv%2Cpubmed");
  });

  it("forwards every optional parameter", async () => {
    let capturedPath: string | undefined;
    pool()
      .intercept({ path: (p) => p.startsWith("/search") && ((capturedPath = p), true) })
      .reply(200, minimalResp());

    await new SearxngClient(ORIGIN).search({
      query: "x",
      categories: ["science"],
      pageno: 3,
      time_range: "month",
      language: "en",
      safe_search: 2,
    });
    expect(capturedPath!).toContain("categories=science");
    expect(capturedPath!).toContain("pageno=3");
    expect(capturedPath!).toContain("time_range=month");
    expect(capturedPath!).toContain("language=en");
    expect(capturedPath!).toContain("safesearch=2");
  });

  it("omits pageno=1 from the URL (only set when > 1)", async () => {
    let capturedPath: string | undefined;
    pool()
      .intercept({ path: (p) => p.startsWith("/search") && ((capturedPath = p), true) })
      .reply(200, minimalResp());

    await new SearxngClient(ORIGIN).search({ query: "x", pageno: 1 });
    expect(capturedPath!).not.toContain("pageno=");
  });

  it("includes a rate-limit hint when SearXNG returns 429", async () => {
    pool()
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(429, "Too Many Requests");

    await expect(
      new SearxngClient(ORIGIN).search({ query: "x" }),
    ).rejects.toThrow(/HTTP 429.*rate-limiting/);
  });

  it("throws on non-JSON response with a body snippet", async () => {
    pool()
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, "<html>error</html>", {
        headers: { "content-type": "text/html" },
      });

    await expect(
      new SearxngClient(ORIGIN).search({ query: "x" }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws on HTTP 500 with body snippet", async () => {
    pool()
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(500, "Internal Server Error");

    await expect(
      new SearxngClient(ORIGIN).search({ query: "x" }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      new SearxngClient(ORIGIN).search({ query: "x" }),
    ).rejects.not.toThrow(/rate-limiting/);
  });
});

describe("SearxngClient.searchMultiPage", () => {
  const respWith = (urls: string[], unresponsive: unknown[] = []) => ({
    query: "x",
    number_of_results: urls.length,
    results: urls.map((u) => ({
      url: u,
      title: u,
      content: "",
      engine: "test",
    })),
    unresponsive_engines: unresponsive,
  });

  it("merges results across pages with URL-based dedup", async () => {
    pool()
      .intercept({ path: (p) => p.includes("pageno=") === false && p.startsWith("/search") })
      .reply(200, respWith(["a", "b"]));
    pool()
      .intercept({ path: (p) => p.includes("pageno=2") })
      .reply(200, respWith(["b", "c"])); // 'b' duplicate
    pool()
      .intercept({ path: (p) => p.includes("pageno=3") })
      .reply(200, respWith(["d"]));

    const out = await new SearxngClient(ORIGIN).searchMultiPage({
      query: "x",
      pages: 3,
    });
    expect(out.results.map((r) => r.url)).toEqual(["a", "b", "c", "d"]);
    expect(out.pages_fetched).toBe(3);
    expect(out.number_of_results).toBe(4); // merged length, not upstream max
  });

  it("dedupes unresponsive_engines across pages by content", async () => {
    pool()
      .intercept({ path: (p) => p.includes("pageno=") === false && p.startsWith("/search") })
      .reply(200, respWith(["a"], [["google", "timeout"]]));
    pool()
      .intercept({ path: (p) => p.includes("pageno=2") })
      .reply(200, respWith(["b"], [["google", "timeout"]])); // same entry

    const out = await new SearxngClient(ORIGIN).searchMultiPage({
      query: "x",
      pages: 2,
    });
    expect(out.unresponsive_engines).toEqual([["google", "timeout"]]);
  });

  it("survives partial failure: 2 pages succeed, 1 fails", async () => {
    pool()
      .intercept({ path: (p) => p.includes("pageno=") === false && p.startsWith("/search") })
      .reply(200, respWith(["a"]));
    pool()
      .intercept({ path: (p) => p.includes("pageno=2") })
      .reply(500, "boom");
    pool()
      .intercept({ path: (p) => p.includes("pageno=3") })
      .reply(200, respWith(["c"]));

    const out = await new SearxngClient(ORIGIN).searchMultiPage({
      query: "x",
      pages: 3,
    });
    expect(out.pages_fetched).toBe(2);
    expect(out.results.map((r) => r.url)).toEqual(["a", "c"]);
  });

  it("THROWS when ALL pages fail (the silent-empty bug from B1)", async () => {
    pool()
      .intercept({ path: (p) => p.includes("pageno=") === false && p.startsWith("/search") })
      .reply(500, "page-1-down");
    pool()
      .intercept({ path: (p) => p.includes("pageno=2") })
      .reply(500, "page-2-down");

    await expect(
      new SearxngClient(ORIGIN).searchMultiPage({ query: "x", pages: 2 }),
    ).rejects.toThrow(/all 2 requested page\(s\) failed/);
  });

  it("respects pageno offset: pages=2 with pageno=5 fetches pages 5 and 6", async () => {
    let p5 = false;
    let p6 = false;
    pool()
      .intercept({ path: (p) => p.includes("pageno=5") && (p5 = true) })
      .reply(200, respWith(["p5"]));
    pool()
      .intercept({ path: (p) => p.includes("pageno=6") && (p6 = true) })
      .reply(200, respWith(["p6"]));

    await new SearxngClient(ORIGIN).searchMultiPage({
      query: "x",
      pageno: 5,
      pages: 2,
    });
    expect(p5).toBe(true);
    expect(p6).toBe(true);
  });
});
