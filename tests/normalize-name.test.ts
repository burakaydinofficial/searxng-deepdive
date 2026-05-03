import { describe, it, expect } from "vitest";
import { normalizeName } from "../src/tools.js";

describe("normalizeName", () => {
  it("lowercases ASCII", () => {
    expect(normalizeName("arXiv")).toBe("arxiv");
    expect(normalizeName("PubMed")).toBe("pubmed");
    expect(normalizeName("Semantic Scholar")).toBe("semantic scholar");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeName("  pubmed  ")).toBe("pubmed");
    expect(normalizeName("\tarxiv\n")).toBe("arxiv");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
    expect(normalizeName("   ")).toBe("");
  });

  it("preserves internal whitespace and punctuation", () => {
    expect(normalizeName("scientific publications")).toBe(
      "scientific publications",
    );
    expect(normalizeName("brave.images")).toBe("brave.images");
  });

  it("is idempotent", () => {
    const samples = ["arXiv", "  PubMed  ", "Scientific Publications", ""];
    for (const s of samples) {
      const once = normalizeName(s);
      expect(normalizeName(once)).toBe(once);
    }
  });
});
