// Lightweight URL → Markdown reader. Pairs with the search tools as the
// "Tier 2" page reader: handles ~80% of static HTML pages cheaply, with
// token-efficient extraction modes (TOC scan, section-targeted, paragraph
// range, character window). For JS-rendered pages, agents should fall
// through to a Chromium-backed reader (Crawl4AI) — this module deliberately
// does NOT try to handle SPAs or bot-protected sites.
//
// Stack: undici for HTTP, node-html-markdown for HTML→Markdown conversion.

import { request } from "undici";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { VERSION } from "./version.js";
import { assertUrlAllowed, isPrivateBlockingEnabled } from "./ssrf-guard.js";
import { readTextWithCap } from "./stream-read.js";

const HEADERS_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 30_000;
// Bound the body we'll buffer from a single fetch. node-html-markdown scans
// every byte, so an unbounded read on a misconfigured (or adversarial)
// upstream would balloon memory regardless of any Content-Length lie.
// 10 MB comfortably covers Wikipedia-class long-form pages while preventing
// pathological reads.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Whole-operation deadline for a single web_url_read (covers all redirect
// hops). undici's bodyTimeout is per-chunk only, so a slow drip could otherwise
// keep a fetch alive far longer than intended.
const TOTAL_DEADLINE_MS = 45_000;

// Cap the markdown we return in one call. A full read of a large page can be
// ~10 MB (MAX_BODY_BYTES); returning that in one blob blows the caller's
// context window. Past this we return a prefix + truncated:true and steer the
// agent to paginate (startChar/maxLength) or use an extraction mode.
export const MAX_OUTPUT_CHARS = 100_000;

const nhm = new NodeHtmlMarkdown();

// Max redirect hops we follow for a single web_url_read call.
const MAX_REDIRECTS = 5;

// Sent on every hop. Pretend to be a generic browser; many sites 403 on a
// bare undici UA.
const REQUEST_HEADERS = {
  "user-agent":
    `Mozilla/5.0 (compatible; searxng-deepdive/${VERSION}; +https://github.com/burakaydinofficial/searxng-deepdive)`,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Fetch `startUrl`, following up to MAX_REDIRECTS redirects MANUALLY so the
// SSRF guard (assertUrlAllowed) runs against every hop, not just the first.
// undici's redirect interceptor would follow 3xx hops opaquely, which lets a
// public URL 302 into an internal/metadata address (redirect SSRF). Returns
// the final, non-redirect response.
async function guardedFetch(startUrl: string) {
  // One deadline for the whole operation, spanning all redirect hops — the
  // per-chunk bodyTimeout does not bound total wall-clock against a slow drip.
  const signal = AbortSignal.timeout(TOTAL_DEADLINE_MS);
  // Private-address blocking is opt-in (see ssrf-guard.ts). When off (default),
  // web_url_read reaches any http(s) host by design. The scheme check below
  // and the per-hop scheme re-check still apply, so file:// stays blocked.
  const blockPrivate = isPrivateBlockingEnabled();
  let currentUrl = startUrl;
  for (let hop = 0; ; hop++) {
    if (blockPrivate) await assertUrlAllowed(currentUrl);
    // undici's `request` does not follow redirects on its own (that needs the
    // redirect interceptor, which we deliberately don't use here), so every 3xx
    // surfaces to us to re-validate before we follow it manually.
    const { statusCode, headers, body } = await request(currentUrl, {
      method: "GET",
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      signal,
    });

    const isRedirect =
      statusCode >= 300 && statusCode < 400 && headers.location !== undefined;
    if (!isRedirect) return { statusCode, headers, body };

    // Discard the redirect body so the connection can be released.
    await body.dump();
    if (hop >= MAX_REDIRECTS) {
      throw new Error(
        `Too many redirects (more than ${MAX_REDIRECTS}) starting from ${startUrl}`,
      );
    }
    const locRaw = headers.location;
    const loc = Array.isArray(locRaw) ? locRaw[0] : locRaw;
    let next: URL;
    try {
      next = new URL(String(loc), currentUrl);
    } catch {
      throw new Error(
        `Redirect from ${currentUrl} had an invalid Location header: "${loc}"`,
      );
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(
        `Redirect blocked: ${currentUrl} redirected to a non-http(s) URL (${next.href})`,
      );
    }
    currentUrl = next.href;
  }
}

// readTextWithCap lives in stream-read.ts (shared with the SearXNG client).
// Re-exported here so existing importers and tests keep resolving it.
export { readTextWithCap };

export interface ReadOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
}

export type ReadMode =
  | "full"
  | "readHeadings"
  | "section"
  | "paragraphRange"
  | "window";

export interface ReadResult {
  url: string;
  mode: ReadMode;
  markdown: string;
  total_length: number;
  truncated: boolean;
  hint?: string;
}

function snippetOf(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// Format a JSON body as a fenced markdown code block so the LLM consumer
// sees structured, human-readable output. Falls back to the raw text if
// the body doesn't actually parse — a lying content-type shouldn't crash
// the reader; better to surface what arrived than to swallow it.
function formatJsonAsMarkdown(text: string): string {
  try {
    return "```json\n" + JSON.stringify(JSON.parse(text), null, 2) + "\n```";
  } catch {
    return text;
  }
}

function emptyHint(extracted: string, msg: string): string | undefined {
  return extracted.trim() === "" ? msg : undefined;
}

// Matches a fenced-code-block delimiter (``` or ~~~), possibly indented and
// with an info string. We toggle in/out of fences so `#` lines inside a code
// block (shell comments, Python, C preprocessor directives) aren't mistaken
// for headings.
const FENCE_RE = /^\s*(?:```|~~~)/;

// Returns the heading list as an indented bulleted tree. Indent depth tracks
// the heading level so the agent can grok structure at a glance.
export function extractHeadings(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();
    out.push(`${"  ".repeat(Math.max(0, level - 1))}- ${text}`);
  }
  return out.join("\n");
}

// Returns content under the FIRST heading whose text contains `sectionTitle`
// (case-insensitive substring match), up to but not including the next
// heading at the same-or-higher level. Returns empty string if no match.
export function extractSection(markdown: string, sectionTitle: string): string {
  const lines = markdown.split("\n");
  const target = sectionTitle.trim().toLowerCase();

  // Collect real ATX headings, ignoring `#` lines inside fenced code blocks —
  // otherwise a shell/Python code sample truncates the section or spawns a
  // phantom boundary.
  const headings: { idx: number; level: number; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i]!)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#+)\s+(.+?)\s*$/.exec(lines[i]!);
    if (m) headings.push({ idx: i, level: m[1]!.length, text: m[2]! });
  }

  const start = headings.find((h) => h.text.toLowerCase().includes(target));
  if (!start) return "";
  const end = headings.find((h) => h.idx > start.idx && h.level <= start.level);
  const endIdx = end ? end.idx : lines.length;
  return lines.slice(start.idx, endIdx).join("\n").trim();
}

// 1-indexed paragraph range. Syntax: "N", "N-M". Schema rejects everything
// else upstream so this function can assume valid input.
export function extractParagraphRange(
  markdown: string,
  range: string,
): string {
  const m = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
  if (!m) return "";

  const start1 = parseInt(m[1]!, 10);
  const end1 = m[2] !== undefined ? parseInt(m[2]!, 10) : start1;

  const paragraphs = markdown
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const sliceStart = Math.max(0, start1 - 1);
  const sliceEnd = Math.min(paragraphs.length, end1);
  return paragraphs.slice(sliceStart, sliceEnd).join("\n\n");
}

export async function fetchAndConvertToMarkdown(
  url: string,
  options: ReadOptions = {},
): Promise<ReadResult> {
  // Validate URL shape and scheme up front so we throw a clear error instead of
  // relying on undici's deeper failure messages. Only http(s) is permitted:
  // this is a WEB page reader, and refusing file:// (and every other non-http(s)
  // scheme) deliberately keeps it from becoming a filesystem escape hatch — a
  // prompt-injected page could otherwise steer the agent to read local secrets
  // (~/.ssh, .env, cloud credentials) via file://. Legitimate local-file access
  // belongs to a dedicated, root-scoped MCP filesystem server, not a URL
  // fetcher. This block is intentional and not configurable.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `URL must be http or https; got ${parsed.protocol} (URL: ${url})`,
    );
  }

  // Fetch with the SSRF guard applied to the initial URL and re-applied to
  // every redirect hop (see guardedFetch / ssrf-guard.ts). Following redirects
  // manually — rather than via undici's opaque redirect interceptor — is what
  // lets us re-validate each hop and stop a public URL from 302'ing into an
  // internal/metadata address.
  const { body, statusCode, headers } = await guardedFetch(url);

  const { text, truncated } = await readTextWithCap(body, MAX_BODY_BYTES);
  if (statusCode >= 400) {
    // Drain any unread bytes (oversized error page) so the connection is
    // released rather than held, then surface the upstream snippet.
    await body.dump().catch(() => {});
    throw new Error(
      `URL returned HTTP ${statusCode}: ${snippetOf(text)} (URL: ${url})`,
    );
  }
  if (truncated) {
    await body.dump().catch(() => {});
    throw new Error(
      `URL response exceeded ${MAX_BODY_BYTES} bytes; refusing to process. The page is too large to safely convert. (URL: ${url})`,
    );
  }

  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  // Accept HTML/XML, JSON (including +json variants), any text/* subtype,
  // and (silently) responses without a content-type header. Reject other
  // binary-ish types with a hint instead of a confusing crash from passing
  // PDF/image bytes through the HTML→Markdown converter.
  //
  // JSON-shaped types (application/json, application/ld+json,
  // application/vnd.api+json, etc.) are intentionally allowed: research
  // agents legitimately need to read spec/manifest files (server.json,
  // OpenAPI definitions, registry API responses), and rejecting them
  // forced a "binary resource" stub even though the body was text.
  //
  // YAML and TOML get the same treatment for the same reason — config
  // files, package manifests (Cargo.toml, pyproject.toml), CI workflow
  // YAML, OpenAPI specs as YAML — all legitimate research-time targets.
  const isHtml =
    contentType.includes("html") || contentType.includes("xml");
  const isJson =
    /\bapplication\/(?:[\w.+-]+\+)?json\b/.test(contentType) ||
    contentType.startsWith("text/json");
  const isStructuredTextApp =
    contentType.startsWith("application/yaml") ||
    contentType.startsWith("application/x-yaml") ||
    contentType.startsWith("application/toml") ||
    contentType.startsWith("application/x-toml");
  const isPlainText = contentType.startsWith("text/");
  const looksTextual =
    contentType === "" ||
    isHtml ||
    isJson ||
    isStructuredTextApp ||
    isPlainText;
  if (!looksTextual) {
    return {
      url,
      mode: "full",
      markdown: "",
      total_length: 0,
      truncated: false,
      hint: `URL returned content-type "${contentType}" — not HTML/text/JSON/YAML/TOML. The page is likely a binary resource (PDF, image, archive, etc.) and can't be Markdown-converted. Use a different tool for binary downloads.`,
    };
  }

  // HTML/XML → node-html-markdown. JSON → pretty-print inside a fenced
  // code block so the structure survives round-tripping through an LLM.
  // Plaintext / unspecified content-type pass through verbatim — running
  // them through the HTML parser would silently decode entities the page
  // may have meant literally (e.g. a CSV line containing "&amp;").
  //
  // nhm.translate is synchronous and can briefly block the event loop on a
  // large document. That is bounded by MAX_BODY_BYTES (10 MB) and, for a
  // single-client stdio server, a transient stall of a respawnable process is
  // acceptable; offloading to a worker thread is deferred as it is not worth
  // the machinery here.
  const fullMarkdown = isHtml
    ? nhm.translate(text)
    : isJson
      ? formatJsonAsMarkdown(text)
      : text;
  const totalLength = fullMarkdown.length;

  // Extraction modes — applied in priority order; first set wins.
  if (options.readHeadings) {
    const out = extractHeadings(fullMarkdown);
    return {
      url,
      mode: "readHeadings",
      markdown: out,
      total_length: totalLength,
      truncated: false,
      hint: emptyHint(
        out,
        "no headings found on this page; try without readHeadings to see the full markdown",
      ),
    };
  }
  if (options.section) {
    const out = extractSection(fullMarkdown, options.section);
    return {
      url,
      mode: "section",
      markdown: out,
      total_length: totalLength,
      truncated: false,
      hint: emptyHint(
        out,
        `no heading containing "${options.section}" found; call again with readHeadings:true to see what's available`,
      ),
    };
  }
  if (options.paragraphRange) {
    const out = extractParagraphRange(fullMarkdown, options.paragraphRange);
    let hint: string | undefined;
    if (out.trim() === "") {
      // Distinguish a reversed range (M < N) from a genuine "page has fewer
      // paragraphs" — the old hint asserted the latter for both, which was
      // factually wrong and misleading for the agent.
      const m = /^(\d+)(?:-(\d+))?$/.exec(options.paragraphRange.trim());
      const start = m ? parseInt(m[1]!, 10) : NaN;
      const end = m && m[2] !== undefined ? parseInt(m[2]!, 10) : start;
      hint =
        Number.isFinite(start) && start < 1
          ? `paragraphRange "${options.paragraphRange}" is 1-indexed; the first paragraph is 1, not 0.`
          : Number.isFinite(start) && Number.isFinite(end) && end < start
            ? `paragraphRange "${options.paragraphRange}" is reversed (end < start); use 'N-M' with N <= M.`
            : `paragraphRange "${options.paragraphRange}" returned empty; the page may have fewer paragraphs than requested.`;
    }
    return {
      url,
      mode: "paragraphRange",
      markdown: out,
      total_length: totalLength,
      truncated: false,
      hint,
    };
  }

  const start = options.startChar ?? 0;
  const max = options.maxLength;
  if (start > 0 || max !== undefined) {
    const end = max !== undefined ? start + max : totalLength;
    const windowMd = fullMarkdown.slice(start, end);
    // Explain an empty window caused by paging past the end, rather than
    // returning empty markdown with no signal.
    const hint =
      windowMd === "" && start >= totalLength && totalLength > 0
        ? `startChar ${start} is at or beyond the document length (${totalLength}); nothing to return. Use a startChar below ${totalLength}.`
        : undefined;
    return {
      url,
      mode: "window",
      markdown: windowMd,
      total_length: totalLength,
      truncated: end < totalLength,
      hint,
    };
  }

  if (totalLength > MAX_OUTPUT_CHARS) {
    return {
      url,
      mode: "full",
      markdown: fullMarkdown.slice(0, MAX_OUTPUT_CHARS),
      total_length: totalLength,
      truncated: true,
      hint: `Output truncated to ${MAX_OUTPUT_CHARS} characters (full length ${totalLength}). Paginate with startChar + maxLength, or use an extraction mode (readHeadings, section, paragraphRange) to target just the part you need.`,
    };
  }
  return {
    url,
    mode: "full",
    markdown: fullMarkdown,
    total_length: totalLength,
    truncated: false,
  };
}
