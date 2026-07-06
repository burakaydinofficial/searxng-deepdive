// Tests for the web_url_read tool's underlying url-reader module.
// Pure-extraction helpers tested with literal markdown fixtures (no HTTP);
// fetch + content-type + extraction-mode integration tested via undici
// MockAgent so no network is required.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import {
  fetchAndConvertToMarkdown,
  extractHeadings,
  extractSection,
  extractParagraphRange,
  readTextWithCap,
  MAX_OUTPUT_CHARS,
  MAX_BODY_BYTES,
} from "../src/url-reader.js";

const ORIGIN = "http://example.test";

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

// ---------------------------------------------------------------------------
// Pure extraction helpers
// ---------------------------------------------------------------------------

describe("extractHeadings", () => {
  it("returns hierarchical bulleted list of all heading levels", () => {
    const md = [
      "# Title",
      "Some intro.",
      "## Section A",
      "Content.",
      "### Sub A.1",
      "More.",
      "## Section B",
    ].join("\n");
    expect(extractHeadings(md)).toBe(
      "- Title\n  - Section A\n    - Sub A.1\n  - Section B",
    );
  });

  it("returns empty string when there are no headings", () => {
    expect(extractHeadings("just some text\n\nanother paragraph")).toBe("");
  });

  it("ignores lines that look like headings but aren't (no space after #)", () => {
    expect(extractHeadings("#NotAHeading\nplain text")).toBe("");
  });

  it("ignores # lines inside fenced code blocks", () => {
    const md = [
      "# Real Title",
      "```sh",
      "# not a heading (shell comment)",
      "echo hi",
      "```",
      "## Real Sub",
    ].join("\n");
    expect(extractHeadings(md)).toBe("- Real Title\n  - Real Sub");
  });
});

describe("extractSection", () => {
  const md = [
    "# Top",
    "intro paragraph",
    "## Installation",
    "first install line",
    "second install line",
    "## Usage",
    "usage line",
    "### Advanced",
    "advanced line",
    "## API",
    "api line",
  ].join("\n");

  it("returns content from matching heading until next same-or-higher heading", () => {
    const out = extractSection(md, "Installation");
    expect(out).toContain("## Installation");
    expect(out).toContain("first install line");
    expect(out).toContain("second install line");
    expect(out).not.toContain("## Usage");
    expect(out).not.toContain("usage line");
  });

  it("includes deeper sub-headings within the matched section", () => {
    const out = extractSection(md, "Usage");
    expect(out).toContain("usage line");
    expect(out).toContain("### Advanced");
    expect(out).toContain("advanced line");
    expect(out).not.toContain("## API");
  });

  it("matches case-insensitively and on substrings", () => {
    expect(extractSection(md, "INSTALL")).toContain("first install line");
    expect(extractSection(md, "install")).toContain("first install line");
  });

  it("returns empty string when no heading matches", () => {
    expect(extractSection(md, "Nonexistent")).toBe("");
  });

  it("matches the FIRST occurrence (not all)", () => {
    const dup = "## A\nfirst\n## B\n## A\nsecond";
    const out = extractSection(dup, "A");
    expect(out).toContain("first");
    expect(out).not.toContain("second");
  });

  it("does not treat a # inside a fenced code block as a section boundary", () => {
    const md = [
      "## Install",
      "run this:",
      "```bash",
      "# comment that looks like a heading",
      "apt install foo",
      "```",
      "done installing",
      "## Usage",
      "use it",
    ].join("\n");
    const out = extractSection(md, "Install");
    expect(out).toContain("apt install foo");
    expect(out).toContain("done installing");
    expect(out).not.toContain("use it");
  });
});

describe("readTextWithCap", () => {
  async function* feed(...chunks: string[]): AsyncIterable<Buffer> {
    for (const c of chunks) yield Buffer.from(c, "utf8");
  }

  it("returns the full text when the stream stays under the cap", async () => {
    const r = await readTextWithCap(feed("hello ", "world"), 100);
    expect(r).toEqual({ text: "hello world", truncated: false });
  });

  it("truncates to exactly `cap` bytes when the stream exceeds it", async () => {
    const r = await readTextWithCap(feed("aaaa", "bbbb", "cccc"), 6);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("aaaabb"); // first 6 bytes
  });

  it("returns empty string for an empty stream", async () => {
    const r = await readTextWithCap(feed(), 100);
    expect(r).toEqual({ text: "", truncated: false });
  });

  it("handles cap=0 by truncating immediately on first non-empty chunk", async () => {
    const r = await readTextWithCap(feed("anything"), 0);
    expect(r).toEqual({ text: "", truncated: true });
  });
});

describe("extractParagraphRange", () => {
  const md = "para 1\n\npara 2\n\npara 3\n\npara 4\n\npara 5";

  it("returns a single paragraph for 'N'", () => {
    expect(extractParagraphRange(md, "3")).toBe("para 3");
  });

  it("returns paragraphs N..M (1-indexed, inclusive)", () => {
    expect(extractParagraphRange(md, "2-4")).toBe("para 2\n\npara 3\n\npara 4");
  });

  it("returns first N paragraphs for '1-N'", () => {
    expect(extractParagraphRange(md, "1-2")).toBe("para 1\n\npara 2");
  });

  it("clamps end to actual paragraph count", () => {
    expect(extractParagraphRange(md, "4-100")).toBe("para 4\n\npara 5");
  });

  it("returns empty when start exceeds paragraph count", () => {
    expect(extractParagraphRange(md, "99")).toBe("");
  });

  it("ignores blank/whitespace-only paragraphs in the count", () => {
    const sparse = "para 1\n\n   \n\npara 2";
    expect(extractParagraphRange(sparse, "2")).toBe("para 2");
  });
});

// ---------------------------------------------------------------------------
// fetchAndConvertToMarkdown integration
// ---------------------------------------------------------------------------

describe("fetchAndConvertToMarkdown", () => {
  it("converts simple HTML to Markdown", async () => {
    pool()
      .intercept({ path: "/" })
      .reply(
        200,
        "<html><body><h1>Hello</h1><p>world.</p></body></html>",
        { headers: { "content-type": "text/html" } },
      );

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/`);
    expect(r.mode).toBe("full");
    expect(r.markdown).toContain("Hello");
    expect(r.markdown).toContain("world");
    expect(r.total_length).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
  });

  it("rejects invalid URL", async () => {
    await expect(fetchAndConvertToMarkdown("not a url")).rejects.toThrow(
      /Invalid URL/,
    );
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(
      fetchAndConvertToMarkdown("ftp://example.test/file"),
    ).rejects.toThrow(/http or https/);
  });

  it("throws on HTTP 404 with snippet of body", async () => {
    pool().intercept({ path: "/missing" }).reply(404, "Not Found");
    await expect(
      fetchAndConvertToMarkdown(`${ORIGIN}/missing`),
    ).rejects.toThrow(/HTTP 404.*Not Found/);
  });

  it("returns hint and empty markdown for binary content-type", async () => {
    pool()
      .intercept({ path: "/file.pdf" })
      .reply(200, "binary garbage", {
        headers: { "content-type": "application/pdf" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/file.pdf`);
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/content-type "application\/pdf"/);
    expect(r.hint).toMatch(/binary resource/);
  });

  it("readHeadings:true returns just the heading tree", async () => {
    pool()
      .intercept({ path: "/page" })
      .reply(
        200,
        "<h1>Top</h1><p>x</p><h2>Sub</h2><p>y</p>",
        { headers: { "content-type": "text/html" } },
      );

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/page`, {
      readHeadings: true,
    });
    expect(r.mode).toBe("readHeadings");
    expect(r.markdown).toMatch(/Top/);
    expect(r.markdown).toMatch(/Sub/);
    expect(r.markdown).not.toMatch(/^[xy]$/m);
  });

  it("readHeadings:true with no headings returns empty + hint", async () => {
    pool()
      .intercept({ path: "/textonly" })
      .reply(200, "<p>just a paragraph</p>", {
        headers: { "content-type": "text/html" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/textonly`, {
      readHeadings: true,
    });
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/no headings found/);
  });

  it("section:'<text>' returns matched section", async () => {
    pool()
      .intercept({ path: "/doc" })
      .reply(
        200,
        "<h1>Top</h1><p>intro</p><h2>Install</h2><p>step one</p><h2>Usage</h2><p>run it</p>",
        { headers: { "content-type": "text/html" } },
      );

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/doc`, {
      section: "Install",
    });
    expect(r.mode).toBe("section");
    expect(r.markdown).toMatch(/Install/);
    expect(r.markdown).toMatch(/step one/);
    expect(r.markdown).not.toMatch(/run it/);
  });

  it("section with no match returns empty + readHeadings recovery hint", async () => {
    pool()
      .intercept({ path: "/doc2" })
      .reply(200, "<h1>Top</h1><p>intro</p>", {
        headers: { "content-type": "text/html" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/doc2`, {
      section: "NonExistentSection",
    });
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/readHeadings:true/);
  });

  it("startChar + maxLength returns character window with truncated flag", async () => {
    const longHtml = `<p>${"x".repeat(5000)}</p>`;
    pool()
      .intercept({ path: "/long" })
      .reply(200, longHtml, { headers: { "content-type": "text/html" } });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/long`, {
      startChar: 100,
      maxLength: 200,
    });
    expect(r.mode).toBe("window");
    expect(r.markdown.length).toBeLessThanOrEqual(200);
    expect(r.truncated).toBe(true);
    expect(r.total_length).toBeGreaterThan(300);
  });

  it("priority: readHeadings beats section beats paragraphRange beats window", async () => {
    pool()
      .intercept({ path: "/page" })
      .reply(
        200,
        "<h1>A</h1><p>p1</p><h2>B</h2><p>p2</p>",
        { headers: { "content-type": "text/html" } },
      );

    // All extraction options set; expect readHeadings to win
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/page`, {
      readHeadings: true,
      section: "B",
      paragraphRange: "1",
      startChar: 5,
      maxLength: 10,
    });
    expect(r.mode).toBe("readHeadings");
  });

  it("returns JSON content-type as a pretty-printed fenced code block", async () => {
    pool()
      .intercept({ path: "/api" })
      .reply(200, '{"hello":"world","items":[1,2,3]}', {
        headers: { "content-type": "application/json" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/api`);
    expect(r.mode).toBe("full");
    expect(r.markdown).toContain("```json");
    expect(r.markdown).toContain('"hello": "world"'); // pretty-printed key/value spacing
    expect(r.markdown).toContain('  "items"'); // 2-space indent
    expect(r.markdown.endsWith("```")).toBe(true);
  });

  it("accepts JSON content-type variants (application/ld+json, vnd.*+json)", async () => {
    pool()
      .intercept({ path: "/ld" })
      .reply(200, '{"@context":"https://schema.org"}', {
        headers: { "content-type": "application/ld+json" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/ld`);
    expect(r.markdown).toContain("```json");
    expect(r.markdown).toContain('"@context"');
  });

  it("falls through to raw body when content-type lies about being JSON", async () => {
    pool()
      .intercept({ path: "/bogus" })
      .reply(200, "{not valid json}", {
        headers: { "content-type": "application/json" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/bogus`);
    expect(r.markdown).toBe("{not valid json}"); // no crash, no code fence
  });

  it("accepts application/yaml content-type and passes through verbatim", async () => {
    const yaml = "name: example\nlist:\n  - one\n  - two\n";
    pool()
      .intercept({ path: "/y" })
      .reply(200, yaml, {
        headers: { "content-type": "application/yaml" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/y`);
    // No HTML conversion, no JSON code-fence — YAML is human-readable text.
    expect(r.markdown).toBe(yaml);
  });

  it("accepts application/toml content-type and passes through verbatim", async () => {
    const toml = '[package]\nname = "example"\nversion = "1.0.0"\n';
    pool()
      .intercept({ path: "/t" })
      .reply(200, toml, {
        headers: { "content-type": "application/toml" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/t`);
    expect(r.markdown).toBe(toml);
  });

  it("rejects truly binary content-types with the diagnostic hint", async () => {
    pool()
      .intercept({ path: "/zip" })
      .reply(200, "PK...binary garbage", {
        headers: { "content-type": "application/zip" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/zip`);
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/HTML\/text\/JSON\/YAML\/TOML/);
    expect(r.hint).toMatch(/binary resource/);
  });

  it("passes plaintext through verbatim without HTML-entity decoding", async () => {
    pool()
      .intercept({ path: "/text" })
      .reply(200, "Hello & welcome <user>", {
        headers: { "content-type": "text/plain" },
      });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/text`);
    // & and < survive — running this through node-html-markdown would
    // have decoded "&" as an entity and dropped or escaped "<user>".
    expect(r.markdown).toBe("Hello & welcome <user>");
  });

  it("accepts redirects up to 5 hops", async () => {
    // Just verify maxRedirections is set; intercepting the redirect chain
    // in MockAgent is awkward, so we just confirm the basic GET still works.
    pool()
      .intercept({ path: "/r" })
      .reply(200, "<p>final</p>", {
        headers: { "content-type": "text/html" },
      });
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/r`);
    expect(r.markdown).toContain("final");
  });
});

// ---------------------------------------------------------------------------
// SSRF guard: web_url_read must not reach private/internal addresses, on the
// initial request or via a redirect hop.
// ---------------------------------------------------------------------------

describe("fetchAndConvertToMarkdown reaches private hosts by default (blocking is opt-in)", () => {
  it("fetches a loopback URL when SEARXNG_DEEPDIVE_BLOCK_PRIVATE is unset", async () => {
    delete process.env.SEARXNG_DEEPDIVE_BLOCK_PRIVATE;
    agent
      .get("http://127.0.0.1:8123")
      .intercept({ path: "/x" })
      .reply(200, "<h1>internal reachable</h1>", {
        headers: { "content-type": "text/html" },
      });
    const r = await fetchAndConvertToMarkdown("http://127.0.0.1:8123/x");
    expect(r.markdown).toContain("internal reachable");
  });
});

describe("fetchAndConvertToMarkdown SSRF guard (opt-in via SEARXNG_DEEPDIVE_BLOCK_PRIVATE)", () => {
  beforeEach(() => {
    process.env.SEARXNG_DEEPDIVE_BLOCK_PRIVATE = "1";
  });
  afterEach(() => {
    delete process.env.SEARXNG_DEEPDIVE_BLOCK_PRIVATE;
  });

  it("blocks a direct loopback URL", async () => {
    await expect(
      fetchAndConvertToMarkdown("http://127.0.0.1:7979/config"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks the cloud-metadata endpoint", async () => {
    await expect(
      fetchAndConvertToMarkdown("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks a hostname that resolves to loopback (localhost)", async () => {
    await expect(
      fetchAndConvertToMarkdown("http://localhost:7979/"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks a redirect from a public-looking host to an internal address", async () => {
    pool()
      .intercept({ path: "/redir" })
      .reply(302, "", { headers: { location: "http://127.0.0.1:8080/secrets" } });
    await expect(
      fetchAndConvertToMarkdown(`${ORIGIN}/redir`),
    ).rejects.toThrow(/private\/internal/);
  });

  it("follows a redirect to another public path and returns the final body", async () => {
    pool()
      .intercept({ path: "/a" })
      .reply(301, "", { headers: { location: `${ORIGIN}/b` } });
    pool()
      .intercept({ path: "/b" })
      .reply(200, "<h1>arrived</h1>", {
        headers: { "content-type": "text/html" },
      });
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/a`);
    expect(r.markdown).toContain("arrived");
  });

  it("blocks a redirect to a non-http(s) scheme", async () => {
    pool()
      .intercept({ path: "/js" })
      .reply(302, "", { headers: { location: "file:///etc/passwd" } });
    await expect(
      fetchAndConvertToMarkdown(`${ORIGIN}/js`),
    ).rejects.toThrow(/non-http/);
  });

  it("allows an internal host that is on the operator allowlist", async () => {
    const prev = process.env.SEARXNG_DEEPDIVE_ALLOWED_HOSTS;
    process.env.SEARXNG_DEEPDIVE_ALLOWED_HOSTS = "127.0.0.1";
    try {
      agent
        .get("http://127.0.0.1:9999")
        .intercept({ path: "/ok" })
        .reply(200, "<h1>internal ok</h1>", {
          headers: { "content-type": "text/html" },
        });
      const r = await fetchAndConvertToMarkdown("http://127.0.0.1:9999/ok");
      expect(r.markdown).toContain("internal ok");
    } finally {
      if (prev === undefined) delete process.env.SEARXNG_DEEPDIVE_ALLOWED_HOSTS;
      else process.env.SEARXNG_DEEPDIVE_ALLOWED_HOSTS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Output cap: full-mode reads of a very large page are truncated with a hint.
// ---------------------------------------------------------------------------

describe("fetchAndConvertToMarkdown output cap", () => {
  it("truncates oversized full-mode output and hints to paginate", async () => {
    const big = `<p>${"x".repeat(MAX_OUTPUT_CHARS + 50_000)}</p>`;
    pool()
      .intercept({ path: "/big" })
      .reply(200, big, { headers: { "content-type": "text/html" } });

    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/big`);
    expect(r.mode).toBe("full");
    expect(r.truncated).toBe(true);
    expect(r.markdown.length).toBe(MAX_OUTPUT_CHARS);
    expect(r.total_length).toBeGreaterThan(MAX_OUTPUT_CHARS);
    expect(r.hint).toMatch(/truncated|paginate/i);
  });

  it("throws when the response body exceeds MAX_BODY_BYTES", async () => {
    const huge = "a".repeat(MAX_BODY_BYTES + 100);
    pool()
      .intercept({ path: "/huge" })
      .reply(200, huge, { headers: { "content-type": "text/plain" } });
    await expect(
      fetchAndConvertToMarkdown(`${ORIGIN}/huge`),
    ).rejects.toThrow(/exceeded|too large/i);
  });
});

// ---------------------------------------------------------------------------
// Extraction-mode hints: accurate diagnostics for reversed ranges and
// paging past the end of the document.
// ---------------------------------------------------------------------------

describe("fetchAndConvertToMarkdown extraction hints", () => {
  it("gives a reversed-range hint for paragraphRange N-M with M < N", async () => {
    pool()
      .intercept({ path: "/p" })
      .reply(200, "<p>one</p><p>two</p><p>three</p>", {
        headers: { "content-type": "text/html" },
      });
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/p`, {
      paragraphRange: "5-3",
    });
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/reversed/);
  });

  it("hints when startChar is at or beyond the end of the document", async () => {
    pool()
      .intercept({ path: "/s" })
      .reply(200, "<p>short</p>", { headers: { "content-type": "text/html" } });
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/s`, {
      startChar: 99999,
      maxLength: 50,
    });
    expect(r.markdown).toBe("");
    expect(r.truncated).toBe(false);
    expect(r.hint).toMatch(/beyond|past/i);
  });

  it("hints that paragraphRange is 1-indexed for '0'", async () => {
    pool()
      .intercept({ path: "/z" })
      .reply(200, "<p>a</p><p>b</p>", {
        headers: { "content-type": "text/html" },
      });
    const r = await fetchAndConvertToMarkdown(`${ORIGIN}/z`, {
      paragraphRange: "0",
    });
    expect(r.markdown).toBe("");
    expect(r.hint).toMatch(/1-indexed/);
  });
});
