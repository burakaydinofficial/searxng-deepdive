import { describe, it, expect } from "vitest";
import {
  searchDescription,
  searchOnEnginesDescription,
  searchByCategoryDescription,
} from "../src/descriptions.js";
import { z } from "zod";
import {
  SearchInput,
  SearchOnEnginesInput,
  SearchByCategoryInput,
} from "../src/schemas.js";
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
    general: ["duckduckgo", "google"],
    it: ["google"],
    news: ["google"],
    science: ["arxiv", "pubmed"],
    "scientific publications": ["arxiv", "pubmed", "semantic scholar"],
  },
};

describe("searchDescription", () => {
  it("includes the live engine count from cfg, not a hardcoded number", () => {
    expect(searchDescription(cfg)).toContain("6 enabled engines");
  });

  it("does not contain unverified result-count claims", () => {
    // Earlier versions said "80–200 results per page" — that's a claim we
    // can't substantiate and would mislead a model on smaller instances.
    const out = searchDescription(cfg);
    expect(out).not.toMatch(/80\s*[–\-]\s*200/);
    expect(out).not.toMatch(/\d+\s*[–\-]\s*\d+\s*results/);
  });

  it("points at the other tools by name", () => {
    const out = searchDescription(cfg);
    expect(out).toContain("search_on_engines");
    expect(out).toContain("search_by_category");
  });
});

describe("searchOnEnginesDescription", () => {
  it("contains the explicit DO-NOT marker for cross-tool confusion", () => {
    expect(searchOnEnginesDescription(cfg)).toContain(
      "DO NOT pass category names",
    );
  });

  it("lists every enabled engine", () => {
    const out = searchOnEnginesDescription(cfg);
    for (const engine of cfg.enabledEngines) {
      expect(out).toContain(engine);
    }
  });

  it("includes the engine count in the header", () => {
    expect(searchOnEnginesDescription(cfg)).toContain(
      `${cfg.enabledEngines.length} total`,
    );
  });

  it("includes a WRONG anti-example showing category names being rejected", () => {
    const out = searchOnEnginesDescription(cfg);
    expect(out).toMatch(/WRONG/);
    expect(out).toMatch(/❌/);
  });

  it("does not contain templating accidents", () => {
    const out = searchOnEnginesDescription(cfg);
    expect(out).not.toContain("[object Object]");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});

describe("searchByCategoryDescription", () => {
  it("lists every enabled category in the actionable header line", () => {
    const out = searchByCategoryDescription(cfg);
    for (const cat of cfg.enabledCategories) {
      expect(out).toContain(cat);
    }
  });

  it("contains the explicit DO-NOT marker for cross-tool confusion", () => {
    expect(searchByCategoryDescription(cfg)).toContain(
      "DO NOT pass engine names",
    );
  });

  it("includes a mixed-case engine-as-category anti-example", () => {
    // The real-world LM Studio failure passed mixed-case names like 'arXiv',
    // 'Semantic Scholar'. Anti-example must show this case.
    const out = searchByCategoryDescription(cfg);
    expect(out).toMatch(/arXiv/);
    expect(out).toMatch(/case doesn't matter/);
  });

  it("shows the engine→category reference list", () => {
    const out = searchByCategoryDescription(cfg);
    // Each category should have a list of its member engines after a → arrow
    expect(out).toMatch(/scientific publications →.*arxiv/);
  });

  it("does not contain templating accidents", () => {
    const out = searchByCategoryDescription(cfg);
    expect(out).not.toContain("[object Object]");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});

describe("schema describe() strings — anti-pattern checks", () => {
  // These are the exact wordings that misled real models. If they reappear
  // in future schema edits, fail loudly. zodToJsonSchema produces the same
  // shape we hand to the MCP client, so this is what the LLM actually sees.
  const allDescriptions = [
    JSON.stringify(z.toJSONSchema(SearchInput)),
    JSON.stringify(z.toJSONSchema(SearchOnEnginesInput)),
    JSON.stringify(z.toJSONSchema(SearchByCategoryInput)),
  ].join("\n");

  it("does not claim time_range is 'ignored by engines that don't support it'", () => {
    expect(allDescriptions).not.toMatch(
      /ignored by engines that don['']t support/i,
    );
  });

  it("does not claim language defaults to 'auto'", () => {
    expect(allDescriptions).not.toMatch(/Default ['"]auto['"]/i);
  });

  it("does not claim safe_search defaults to 0", () => {
    expect(allDescriptions).not.toMatch(/Default 0\b/);
  });

  it("does warn that time_range can return zero on some engines (positive check)", () => {
    expect(allDescriptions).toMatch(/zero results/i);
  });

  it("does warn that language has no documented default", () => {
    expect(allDescriptions).toMatch(/instance['']s configured default/i);
  });
});
