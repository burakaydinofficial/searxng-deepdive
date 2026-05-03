# Changelog

All notable changes to `searxng-deepdive` will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `AGENTS.md` — guide for AI assistants editing the codebase
- `CHANGELOG.md` (this file)

## [0.2.0] — 2026-05-03

### Added
- **`web_url_read` tool** — fetch a URL and convert HTML content to clean
  Markdown. Lightweight HTTP + HTML→Markdown (no headless browser; handles
  ~80% of static HTML pages). Token-efficient extraction modes:
  `readHeadings` (TOC scan), `section` (substring-match heading targeting),
  `paragraphRange` (1-indexed slice), `startChar`+`maxLength` (character
  window). Falls back gracefully on binary content-types and non-HTTP
  schemes.
- HTTP client hardening: 10s/15s timeouts on `getConfig`, distinguished
  error messaging for 429 rate-limited responses, JSON-parse fallback
  with body snippet when SearXNG returns HTML error pages.
- `searchMultiPage` now throws on all-pages-fail (was silently returning
  empty), dedupes `unresponsive_engines` by content (was double-counting
  same engine across pages), and reports `number_of_results` as the merged
  result count rather than the per-page upstream estimate.
- Comprehensive test suite: 102 tests across 7 files (~4s).
- GitHub Actions workflows for test (push/PR/dispatch, Node 18/20/22 matrix)
  and publish (on `v*.*.*` tags, with version-tag verification and npm
  provenance attestation).
- LICENSE file (MIT).

### Changed
- Tool descriptions now warn that `time_range` may return zero results on
  some engines (was: claimed it would be "ignored", which lost real
  searches and confused models).
- `language` and `safe_search` schema descriptions no longer claim
  defaults the code doesn't apply.
- Cross-validation (`search_on_engines` ↔ `search_by_category`) is
  case-insensitive — `arXiv`, `PubMed`, `Semantic Scholar` all match
  the canonical lowercase entries; SearXNG receives the normalized form.
- `search_on_engines` and `search_by_category` validators emit
  cross-reference hints when a value is the wrong kind ("`arxiv` is an
  engine, not a category — use `search_on_engines`").
- Zero-result responses now include a `hint` field when a probable cause
  is identifiable: `time_range` was set, all requested engines were
  unresponsive, some engines were unresponsive on broad search, or only
  one engine was queried and returned nothing.
- `searchMultiPage` request fanout now uses `Promise.allSettled` for
  partial-failure resilience; `pageno + pages` semantics composed
  (e.g. `pageno=5, pages=2` fetches pages 5 and 6).
- README rewritten to be readable as a standalone npm package (was
  previously oriented around the SearXNG-Compose monorepo).

### Removed
- Hardcoded engine names from zero-result hints (was opinionated; not
  cross-instance valid).

## [0.1.0] — 2026-05-02

Initial release inside the [SearXNG-Compose](https://github.com/burakaydinofficial/SearXNG-Compose)
monorepo, prior to extraction into this standalone repo.

### Added
- Three MCP tools: `search`, `search_on_engines`, `search_by_category`.
- Multi-page fanout via `pages` parameter (capped at 5).
- Compact-format response trimming (`format: "compact"` default; `"full"`
  available).
- Dynamic tool descriptions generated at server startup from SearXNG's
  `/config` — agents see the live enabled engine and category lists for
  the connected instance.
- Zod input schemas with agent-targeted descriptions for every parameter.
- TypeScript-first build (Node 18+), tsx for dev, vitest for tests.
