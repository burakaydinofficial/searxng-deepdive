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

const HEADERS_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 30_000;

const nhm = new NodeHtmlMarkdown();

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

  const { body, statusCode, headers } = await request(url, {
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    // Pretend to be a generic browser; many sites 403 on bare undici UA.
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; searxng-deepdive/0.2; +https://github.com/burakaydinofficial/SearXNG-Compose)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    maxRedirections: 5,
  });

  const text = await body.text();
  if (statusCode >= 400) {
    throw new Error(
      `URL returned HTTP ${statusCode}: ${snippetOf(text)} (URL: ${url})`,
    );
  }

  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  // Accept HTML, plaintext, and (silently) anything without a content-type
  // header. Reject other binary-ish types with a hint instead of a confusing
  // crash from passing PDF/binary bytes through the HTML→MD converter.
  const looksTextual =
    contentType === "" ||
    contentType.includes("html") ||
    contentType.includes("xml") ||
    contentType.includes("text/plain") ||
    contentType.includes("text/markdown");
  if (!looksTextual) {
    return {
      url,
      mode: "full",
      markdown: "",
      total_length: 0,
      truncated: false,
      hint: `URL returned content-type "${contentType}" — not HTML/text. The page is likely a binary resource (PDF, image, archive, etc.) and can't be Markdown-converted. Use a different tool for binary downloads.`,
    };
  }

  const fullMarkdown = nhm.translate(text);
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
