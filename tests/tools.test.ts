// Tests for the tool dispatch layer: unknown-tool / invalid-args protocol
// faults throw, but tool-execution failures come back as { isError: true }
// content so the agent sees the hint. Plus the concurrency Semaphore.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import { buildTools, dispatchToolCall, Semaphore } from "../src/tools.js";
import { SearxngClient, type SearxngConfig } from "../src/searxng.js";

const ORIGIN = "http://tools-mock.test";
const config: SearxngConfig = {
  enabledEngines: ["google", "arxiv"],
  enabledCategories: ["news", "science"],
  enginesByCategory: { news: ["google"], science: ["arxiv"] },
};

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

function tools() {
  return buildTools(new SearxngClient(ORIGIN), config);
}

describe("dispatchToolCall", () => {
  it("throws on an unknown tool (protocol fault)", async () => {
    await expect(dispatchToolCall(tools(), "nope", {})).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it("throws on schema-invalid arguments (protocol fault)", async () => {
    await expect(dispatchToolCall(tools(), "search", {})).rejects.toThrow(
      /Invalid arguments/,
    );
  });

  it("throws the category-vs-engine hint (surfaced via the -32603 envelope)", async () => {
    await expect(
      dispatchToolCall(tools(), "search_on_engines", {
        query: "x",
        engines: ["science"],
      }),
    ).rejects.toThrow(/is a category/);
  });

  it("throws the invalid-engine hint", async () => {
    await expect(
      dispatchToolCall(tools(), "search_on_engines", {
        query: "x",
        engines: ["notreal"],
      }),
    ).rejects.toThrow(/Invalid engine/);
  });

  it("returns content on success", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, {
        query: "x",
        number_of_results: 1,
        results: [{ url: "u", title: "t", content: "c", engine: "google" }],
        unresponsive_engines: [],
      });
    const r = await dispatchToolCall(tools(), "search", { query: "x" });
    expect(JSON.parse(r.content[0]!.text).result_count).toBe(1);
  });

  it("recovers targeted-search validation via lazy config when startup config was empty", async () => {
    // Simulate a degraded startup: server booted with an empty config because
    // SearXNG was down. SearXNG is up now, so doSearch's lazy getConfigOrNull
    // fetches the live engine list and the targeted search validates + runs.
    const emptyConfig: SearxngConfig = {
      enabledEngines: [],
      enabledCategories: [],
      enginesByCategory: {},
    };
    const client = new SearxngClient(ORIGIN);
    const tls = buildTools(client, emptyConfig);
    agent
      .get(ORIGIN)
      .intercept({ path: "/config" })
      .reply(200, {
        engines: [{ name: "google", categories: ["general"], enabled: true }],
      });
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, {
        query: "x",
        number_of_results: 1,
        results: [{ url: "u", title: "t", content: "c", engine: "google" }],
        unresponsive_engines: [],
      });
    const r = await dispatchToolCall(tls, "search_on_engines", {
      query: "x",
      engines: ["google"],
    });
    expect(JSON.parse(r.content[0]!.text).result_count).toBe(1);
  });
});

describe("Semaphore", () => {
  it("bounds concurrency and runs queued work after a slot frees", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    let releaseA!: () => void;
    const a = sem.run(async () => {
      order.push("a-start");
      await new Promise<void>((r) => (releaseA = r));
      order.push("a-end");
    });
    const b = sem.run(async () => {
      order.push("b-start");
    });
    // b must not begin until a releases the only slot.
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });
});
