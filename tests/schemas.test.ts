// Schema-level input guards. paragraphRange enforces the N / N-M *shape* but
// not 1-indexing (that's guided by a runtime hint, per the "informatively-
// wrong" design), and the query is not length-capped (long queries are the
// agent's call; SearXNG bounds the request line upstream).

import { describe, it, expect } from "vitest";
import { WebUrlReadInput, SearchInput } from "../src/schemas.js";

const url = "http://example.test/";

describe("WebUrlReadInput.paragraphRange", () => {
  it("accepts N and N-M", () => {
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "3" }).success).toBe(true);
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "3-7" }).success).toBe(true);
  });

  it("rejects non-numeric or malformed formats", () => {
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "abc" }).success).toBe(false);
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "1-2-3" }).success).toBe(false);
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "" }).success).toBe(false);
  });

  it("accepts '0' at the schema level (1-indexing is guided by a runtime hint, not a hard reject)", () => {
    expect(WebUrlReadInput.safeParse({ url, paragraphRange: "0" }).success).toBe(true);
  });
});

describe("SearchInput.query", () => {
  it("accepts a normal query", () => {
    expect(SearchInput.safeParse({ query: "hello world" }).success).toBe(true);
  });

  it("rejects empty / whitespace-only queries", () => {
    expect(SearchInput.safeParse({ query: "   " }).success).toBe(false);
  });

  it("does not cap query length", () => {
    expect(SearchInput.safeParse({ query: "a".repeat(5000) }).success).toBe(true);
  });
});
