// Lightweight URL → Markdown reader. Pairs with the search tools as the
// "Tier 2" page reader: handles ~80% of static HTML pages cheaply, with
// token-efficient extraction modes (TOC scan, section-targeted, paragraph
// range, character window). For JS-rendered pages, agents should fall
// through to a Chromium-backed reader (Crawl4AI) — this module deliberately
// does NOT try to handle SPAs or bot-protected sites.
//
// Stack: undici for HTTP, node-html-markdown for HTML→Markdown conversion.

import { request, getGlobalDispatcher, interceptors } from "undici";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { VERSION } from "./version.js";

const HEADERS_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 30_000;
// Bound the body we'll buffer from a single fetch. node-html-markdown scans
// every byte, so an unbounded read on a misconfigured (or adversarial)
// upstream would balloon memory regardless of any Content-Length lie.
// 10 MB comfortably covers Wikipedia-class long-form pages while preventing
// pathological reads.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const nhm = new NodeHtmlMarkdown();

// Stream-read the body up to `cap` bytes. Returns `truncated: true` if we
// hit the cap before the stream ended — caller decides whether to still
// honor the partial body (e.g. for an error snippet) or reject outright.
//
// Exported for direct unit testing; the helper isn't used outside this
// module in production.
export async function readTextWithCap(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    if (total + buf.length > cap) {
      const remaining = cap - total;
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

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

// Returns the heading list as an indented bulleted tree. Indent depth tracks
// the heading level so the agent can grok structure at a glance.
export function extractHeadings(markdown: string): string {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
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
  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#+)\s+(.+?)\s*$/.exec(lines[i]!);
    if (m && m[2]!.toLowerCase().includes(target)) {
      startIdx = i;
      startLevel = m[1]!.length;
      break;
    }
  }
  if (startIdx === -1) return "";

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#+)\s+/.exec(lines[i]!);
    if (m && m[1]!.length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n").trim();
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
  // Validate URL shape and scheme up front so we throw a clear error
  // instead of relying on undici's deeper failure messages.
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

  // undici@7+ removed `maxRedirections` from request options; redirect
  // handling is now a composable interceptor on a dispatcher. Composing
  // onto the *current global* dispatcher (rather than a fresh Agent) is
  // what lets the test suite swap in a MockAgent without our redirect
  // wrapper bypassing it.
  const { body, statusCode, headers } = await request(url, {
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    // Pretend to be a generic browser; many sites 403 on bare undici UA.
    headers: {
      "user-agent":
        `Mozilla/5.0 (compatible; searxng-deepdive/${VERSION}; +https://github.com/burakaydinofficial/searxng-deepdive)`,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    dispatcher: getGlobalDispatcher().compose(
      interceptors.redirect({ maxRedirections: 5 }),
    ),
  });

  const { text, truncated } = await readTextWithCap(body, MAX_BODY_BYTES);
  if (statusCode >= 400) {
    // Surface the upstream snippet even on truncated bodies — the first 10MB
    // is more than enough for diagnostic context.
    throw new Error(
      `URL returned HTTP ${statusCode}: ${snippetOf(text)} (URL: ${url})`,
    );
  }
  if (truncated) {
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
  const isHtml =
    contentType.includes("html") || contentType.includes("xml");
  const isJson =
    /\bapplication\/(?:[\w.+-]+\+)?json\b/.test(contentType) ||
    contentType.startsWith("text/json");
  const isPlainText = contentType.startsWith("text/");
  const looksTextual =
    contentType === "" || isHtml || isJson || isPlainText;
  if (!looksTextual) {
    return {
      url,
      mode: "full",
      markdown: "",
      total_length: 0,
      truncated: false,
      hint: `URL returned content-type "${contentType}" — not HTML/text/JSON. The page is likely a binary resource (PDF, image, archive, etc.) and can't be Markdown-converted. Use a different tool for binary downloads.`,
    };
  }

  // HTML/XML → node-html-markdown. JSON → pretty-print inside a fenced
  // code block so the structure survives round-tripping through an LLM.
  // Plaintext / unspecified content-type pass through verbatim — running
  // them through the HTML parser would silently decode entities the page
  // may have meant literally (e.g. a CSV line containing "&amp;").
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
    return {
      url,
      mode: "paragraphRange",
      markdown: out,
      total_length: totalLength,
      truncated: false,
      hint: emptyHint(
        out,
        `paragraphRange "${options.paragraphRange}" returned empty; the page may have fewer paragraphs than requested`,
      ),
    };
  }

  const start = options.startChar ?? 0;
  const max = options.maxLength;
  if (start > 0 || max !== undefined) {
    const end = max !== undefined ? start + max : totalLength;
    return {
      url,
      mode: "window",
      markdown: fullMarkdown.slice(start, end),
      total_length: totalLength,
      truncated: end < totalLength,
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
