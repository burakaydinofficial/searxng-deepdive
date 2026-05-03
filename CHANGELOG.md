# Changelog

All notable changes to `searxng-deepdive` will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] — 2026-05-03

### Added
- `web_url_read` now accepts `application/json` and JSON variants
  (`application/ld+json`, `application/vnd.*+json`, etc.) as textual
  content. JSON bodies pass through pretty-printed inside a fenced code
  block instead of being rejected with the binary-content hint.
  Surfaced live when an agent tried to read a published `server.json`
  spec and got the "binary resource" stub back.
- `mcpName` field in `package.json` and a top-level `server.json` so
  the package can be submitted to the official
  [MCP Registry](https://registry.modelcontextprotocol.io/). The
  registry uses these to verify the npm package and the registry
  entry agree before listing.
- Four new tests in `tests/url-reader.test.ts` covering JSON pass-through,
  JSON content-type variants, lying content-type fallback, and
  plaintext verbatim handling.

### Changed
- `web_url_read`'s plaintext / non-HTML textual responses now pass
  through verbatim instead of going through `node-html-markdown`. The
  HTML parser was silently decoding entities the page may have meant
  literally (e.g. a CSV containing `&amp;` getting rewritten to `&`).
- The "not HTML/text" hint message updated to mention JSON in the
  accepted set, so the wording stays accurate.

## [0.3.1] — 2026-05-03

### Changed
- Publish workflow now uses npm Trusted Publishing (OIDC) instead of
  a long-lived `NPM_TOKEN` secret. Maintainer/CI hardening only —
  the published tarball contents are byte-identical to 0.3.0 (no
  source or runtime change). This release exists so the OIDC
  handshake gets exercised end-to-end before a real-content release.

## [0.3.0] — 2026-05-03

### Added
- `AGENTS.md` — agent-readable working-conventions guide.
- `SECURITY.md` — vulnerability-reporting policy with an in-scope /
  out-of-scope list (so the SSRF-by-design behavior of `web_url_read`
  isn't reported as a bug).
- `CONTRIBUTING.md` — quick-start for human contributors; defers to
  `AGENTS.md` for working conventions to avoid two-source drift.
- `.github/dependabot.yml` — weekly grouped dep updates for npm and
  GitHub Actions ecosystems.
- `src/version.ts` — single source of truth for the package version,
  read from `package.json` at module load.
- README "Security notes" section documenting the local-first trust
  model and the URL-fetch surface inherent to `web_url_read`.

### Changed
- **BREAKING:** `engines.node` is now `>=20.18.1` (was `>=18`). Node 18
  reached EOL on 2025-04-30 and was no longer defensible to advertise.
  We pinned `>=20.18.1` rather than the more aspirational `>=22` because
  Node 20 is still in maintenance LTS through April 2027 with a real
  user base, and undici 7 (the line we ship) supports it. The trailing
  `.18.1` matches undici 7's own engines floor exactly.
- CI test matrix is now `[ubuntu, macos, windows] × Node [20, 22, 24]`
  (was Linux-only Node 18/20/22). Cross-OS coverage proves the package
  installs and runs everywhere it claims to before publish.
- README "Tests" badge swapped from a static "102 passing" shield to
  the live workflow status badge so it stops drifting on every test add.
- The MCP handshake now reports the actual package version. Previously
  hardcoded as `"0.1.0"` even after `package.json` was at `0.2.0`.
- url-reader's outbound user-agent now uses the live package version.
  Previously hardcoded as `"searxng-deepdive/0.2"`.
- `registerTools(server, client, config)` now takes the SearxngConfig
  rather than re-fetching `/config` itself. The startup probe in
  `index.ts` already had it; passing it through removes a redundant
  round-trip and the tiny window where the two reads could disagree.
- `web_url_read` body reads are now capped at 10 MB and consumed via
  a stream-with-cap helper, so an upstream advertising `text/html`
  but shipping a multi-GB asset can't OOM the process. Catches
  Content-Length lies that a post-hoc length check would miss.

### Removed
- `zod-to-json-schema` dependency. Zod 4 ships `z.toJSONSchema()`
  natively — one fewer transitive supply-chain hop, recommended by
  the upstream maintainer (deprecated in late 2025).

### Dependencies
- `zod` ^3 → ^4 (renames `ZodError.errors` → `.issues`; per-issue
  shape is unchanged so internal `er.path.join(".")` and `er.message`
  callers still work).
- `undici` ^6 → ^7 (redirect handling moved from request option to
  composable interceptor on the dispatcher). Stayed on v7 rather than
  v8 because v8 requires Node 22.19+ and the only v8 feature we'd
  pick up is HTTP/2-by-default, which v7 also supports as opt-in;
  v7 still receives parallel security backports.
- `@modelcontextprotocol/sdk` ^1.0.4 → ^1.29 (security + protocol
  fixes; no public API used by this package changed).
- `vitest` ^2 → ^4 (transitively clears the esbuild/vite dev-server
  advisories from the previous audit; full suite now ~1s).
- `@types/node` ^20 → ^22 (newer Node typings).

`npm audit` now reports 0 vulnerabilities.

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
