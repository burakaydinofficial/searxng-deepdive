import { describe, it, expect } from "vitest";
import {
  validateEngineSelection,
  validateCategorySelection,
} from "../src/tools.js";
import type { SearxngConfig } from "../src/searxng.js";

const cfg: SearxngConfig = {
  enabledEngines: [
    "arxiv",
    "duckduckgo",
    "google",
    "pubmed",
    "semantic scholar",
    "wikipedia",
  ],
  enabledCategories: [
    "general",
    "it",
    "news",
    "science",
    "scientific publications",
  ],
  enginesByCategory: {
    general: ["google", "duckduckgo"],
    it: ["google"],
    news: ["google"],
    science: ["arxiv", "pubmed"],
    "scientific publications": ["arxiv", "pubmed", "semantic scholar"],
  },
};

describe("validateEngineSelection", () => {
  it("accepts valid lowercase engine names", () => {
    expect(() => validateEngineSelection(["google"], cfg)).not.toThrow();
    expect(() =>
      validateEngineSelection(["arxiv", "pubmed"], cfg),
    ).not.toThrow();
  });

  it("accepts mixed-case engine names (case-insensitive)", () => {
    expect(() => validateEngineSelection(["Google"], cfg)).not.toThrow();
    expect(() =>
      validateEngineSelection(["arXiv", "PubMed", "Semantic Scholar"], cfg),
    ).not.toThrow();
  });

  it("accepts whitespace-padded engine names", () => {
    expect(() =>
      validateEngineSelection(["  arxiv  "], cfg),
    ).not.toThrow();
  });

  it("rejects unknown engine names", () => {
    expect(() => validateEngineSelection(["xxx"], cfg)).toThrow(/"xxx"/);
  });

  it("includes the engine in the error message verbatim, in original case", () => {
    expect(() => validateEngineSelection(["XxX"], cfg)).toThrow(/"XxX"/);
  });

  it("flags category names as 'is a category, not engines' with cross-ref to search_by_category", () => {
    expect(() => validateEngineSelection(["science"], cfg)).toThrow(
      /search_by_category/,
    );
    expect(() => validateEngineSelection(["science"], cfg)).toThrow(
      /is a category/,
    );
  });

  it("handles multi-word category names", () => {
    expect(() =>
      validateEngineSelection(["scientific publications"], cfg),
    ).toThrow(/scientific publications/);
    expect(() =>
      validateEngineSelection(["scientific publications"], cfg),
    ).toThrow(/search_by_category/);
  });

  it("uses 'are categories' (plural) when multiple invalid names match categories", () => {
    expect(() =>
      validateEngineSelection(["science", "news"], cfg),
    ).toThrow(/are categories/);
  });

  it("only mentions the cross-ref hint for invalid names that match categories — not for pure typos", () => {
    let err: unknown;
    try {
      validateEngineSelection(["arxv"], cfg); // typo, doesn't match any category
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/is a category/);
    expect((err as Error).message).not.toMatch(/are categories/);
  });

  it("error message lists available engines for self-correction", () => {
    expect(() => validateEngineSelection(["xxx"], cfg)).toThrow(
      /Available engines/,
    );
  });
});

describe("validateCategorySelection", () => {
  it("accepts valid lowercase category names", () => {
    expect(() => validateCategorySelection(["science"], cfg)).not.toThrow();
    expect(() =>
      validateCategorySelection(["news", "general"], cfg),
    ).not.toThrow();
  });

  it("accepts mixed-case category names (case-insensitive)", () => {
    expect(() => validateCategorySelection(["Science"], cfg)).not.toThrow();
    expect(() =>
      validateCategorySelection(["Scientific Publications"], cfg),
    ).not.toThrow();
  });

  it("rejects unknown category names", () => {
    expect(() => validateCategorySelection(["xyz"], cfg)).toThrow(/"xyz"/);
  });

  it("flags engine names as 'is an engine, not categories' with cross-ref to search_on_engines", () => {
    expect(() => validateCategorySelection(["arxiv"], cfg)).toThrow(
      /search_on_engines/,
    );
    expect(() => validateCategorySelection(["arxiv"], cfg)).toThrow(
      /is an engine/,
    );
  });

  it("flags MIXED-CASE engine names (the real-world LM Studio bug)", () => {
    // This is the exact failure mode that prompted the v0.1 case-insensitive fix.
    expect(() =>
      validateCategorySelection(["arXiv", "Semantic Scholar", "PubMed"], cfg),
    ).toThrow(/are engines/);
    expect(() =>
      validateCategorySelection(["arXiv", "Semantic Scholar", "PubMed"], cfg),
    ).toThrow(/search_on_engines/);
  });

  it("uses 'is an engine' (singular) when one name matches", () => {
    expect(() =>
      validateCategorySelection(["pubmed"], cfg),
    ).toThrow(/is an engine/);
  });

  it("error message lists available categories for self-correction", () => {
    expect(() => validateCategorySelection(["xyz"], cfg)).toThrow(
      /Available categories/,
    );
    expect(() => validateCategorySelection(["xyz"], cfg)).toThrow(/science/);
  });
});
