# searxng-deepdive

[![Tests](https://github.com/burakaydinofficial/searxng-deepdive/actions/workflows/test.yml/badge.svg)](https://github.com/burakaydinofficial/searxng-deepdive/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io/) server for [SearXNG](https://docs.searxng.org/)
designed for LLM agents doing real research. Four tools with agent-friendly
schemas, multi-page result fanout, lightweight URL→Markdown reading, and
tool descriptions generated dynamically from the live engine pool of *your*
SearXNG instance.

## Why another mcp-searxng?

Existing packages are minimal — most expose a single `search(query)` tool
with no way for the model to ask for more results, target specific engines,
or constrain by category. The richer ones bake static descriptions, so the
LLM never learns what's actually enabled on *this* instance. None of them
treat agent-tool-selection ergonomics as a design priority.

`searxng-deepdive` opens those knobs up:

| Feature | This | npm `mcp-searxng` (ihor-sokoliuk) | PyPI `mcp-searxng` (SecretiveShell) |
|---|---|---|---|
| Engine targeting | ✅ via `search_on_engines` | ❌ | ❌ |
| Category targeting | ✅ via `search_by_category` | ❌ | ❌ |
| Multi-page fanout in one call | ✅ via `pages: N` | ❌ (one page per call) | ❌ |
| Pagination | ✅ via `pageno` | ✅ | ❌ |
| Compact response trim | ✅ via `format: "compact"` | ❌ | ❌ |
| Dynamic descriptions per instance | ✅ live engine list injected | ❌ static | ❌ static |
| Validation with cross-tool hints | ✅ engine-vs-category, case-insensitive | ❌ | ❌ |
| Zero-result hints | ✅ time_range / unresponsive engines / single-engine | ❌ | ❌ |
| URL reader (HTML→Markdown) | ✅ with TOC scan + section extraction | ✅ basic | ❌ |
| Test suite | ✅ 102 unit + integration | minimal | ❌ |

## Quickstart

Install via `npx -y` from any MCP client:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "searxng-deepdive"],
      "env": { "SEARXNG_URL": "http://127.0.0.1:7979/" }
    }
  }
}
```

`SEARXNG_URL` should point at your running SearXNG instance. Need one?
The companion repo [SearXNG-Compose](https://github.com/burakaydinofficial/SearXNG-Compose)
ships a plug-and-play Docker stack tuned for LLM consumption.

## Tools

The server registers four tools. The LLM picks among them based on the
descriptions below, augmented at startup with the live engine and category
list from your instance.

### `search(query, [...])`

Broad web search across the full enabled engine pool. Use when you don't
have a specific source preference. Returns merged, deduplicated results
across however many engines respond.

### `search_on_engines(query, engines, [...])`

Search using only the specified engines (e.g. `["arxiv", "pubmed", "semantic scholar"]`).
The tool description registered with the MCP client includes the actual
list of engines enabled on your instance — agents don't have to guess
names. Validation rejects invalid names with a "did you mean" hint when
they look like categories instead of engines.

### `search_by_category(query, categories, [...])`

Search within specific categories — runs every engine tagged with each.
Description includes the live category list and which engines belong to
each. Same validation: invalid category names produce a clear error
that points at `search_on_engines` when the offending value is actually
an engine name.

### `web_url_read(url, [readHeadings, section, paragraphRange, startChar, maxLength])`

Fetch a URL and convert its HTML to clean Markdown. Lightweight HTTP +
HTML→Markdown (no headless browser) — handles ~80% of the static-HTML
web (Wikipedia, docs sites, blogs, news, GitHub READMEs).

Token-efficient extraction modes (priority order, first set wins):

- `readHeadings: true` — return only the heading list as a hierarchical TOC
- `section: "Installation"` — return content under matching heading
- `paragraphRange: "3-7"` — 1-indexed paragraph slice
- `startChar` + `maxLength` — character window pagination

Recommended workflow for long pages: TOC scan first (`readHeadings`), then
targeted read (`section`). Far more token-efficient than fetching the full
page up front.

For JS-rendered SPAs and bot-protected sites this tool returns minimal/empty
content — fall back to a Chromium-backed reader (e.g. Crawl4AI) for those.

### Common parameters across all search tools

- `pageno` — 1-indexed starting page (default 1)
- `pages` — multi-page fanout in one call (1–5, default 1)
- `time_range` — `day` / `week` / `month` / `year` (warning: not all engines support this; some return empty when set)
- `language` — BCP-47 code or `all`
- `safe_search` — 0 / 1 / 2
- `format` — `compact` (default) or `full`

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `SEARXNG_URL` | `http://127.0.0.1:8080` | Base URL of the SearXNG instance |

## Development

```bash
git clone <this repo>
cd searxng-deepdive          # or wherever you cloned to
npm install
npm run build                # tsc
npm test                     # vitest
SEARXNG_URL=http://127.0.0.1:7979 npm run probe    # exercise the SearXNG client
SEARXNG_URL=http://127.0.0.1:7979 npm run dev      # start the MCP stdio server
```

### Pointing an MCP client at the source during development

Use `tsx` to run from `src/` directly so you don't need to rebuild on every edit:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/searxng-deepdive/src/index.ts"],
      "env": { "SEARXNG_URL": "http://127.0.0.1:7979/" }
    }
  }
}
```

> **MCP clients cache the subprocess.** When you edit code, the running
> server keeps the old behavior until the subprocess is killed and
> respawned. Quit the host (LM Studio, Claude Desktop, etc.) fully and
> reopen — closing the chat window alone usually isn't enough. Symptom of
> not doing this: a fix you just shipped doesn't appear to take effect.

## Testing

```
npm test
```

Test coverage spans seven files:

- **normalize-name** — case-insensitive name handling
- **validators** — engine/category validation with cross-reference hints
- **zero-result-hint** — every hint trigger and its inverse
- **trim-to-compact** — response trimming + hint inclusion
- **descriptions** — anti-pattern regex checks for the description copy
  that misled real models in earlier versions ("ignored by engines",
  "Default 'auto'", etc.) — failing build if they reappear
- **searxng-client** — HTTP client with `MockAgent`: malformed JSON,
  HTML 502 pages, 429 rate-limit handling, multi-page fanout dedup,
  all-pages-fail throws
- **url-reader** — extraction modes + HTTP integration

## Design notes

- **Why four tools instead of one with optional engine/category params?**
  Cleaner agent decision-making. With distinct tools the LLM sees explicit
  purposes; with one fat tool it has to remember when to set which optional
  flags. Trade-off: more entries in the MCP tool list, mostly identical
  handler code. Net: better agent ergonomics, especially for smaller models.

- **Why `format: "compact"` as default?** SearXNG's full result objects are
  several times heavier than just url+title+content+engine. For the typical
  agent workflow (rank candidates, pick a few to fetch in detail), the
  compact form is what the LLM actually uses. `format: "full"` is one
  parameter away when you need scores, dates, authors, or DOI.

- **Why dynamic descriptions?** Static descriptions either list every
  upstream engine (most aren't enabled on a given instance — wastes context)
  or list none (LLM has no idea what to put in `engines`). Live introspection
  of `/config` at server startup gives the LLM exactly the right hint for
  *this* instance.

- **Why convert silent-wrong into informatively-wrong?** Real LM Studio
  testing showed agents repeatedly stuck in retry loops because failed
  searches looked successful (zero results, looked like "no matches"; or
  60 garbage results, looked like the search ran). The validation +
  zero-result-hint pattern surfaces the actual cause every time. The
  description-anti-pattern test suite locks in copy that was empirically
  shown to mislead models.

## Security notes

This package is designed to run **locally**, inside the user's trust
boundary, alongside an MCP-speaking LLM client (Claude Desktop, LM Studio,
Cursor, etc.). The trust model assumes:

- the LLM is acting on the user's behalf
- the user controls what model is connected to the server
- the MCP transport is stdio, not exposed to remote callers

Within that boundary, two surfaces are worth knowing about:

- **`web_url_read` will fetch any HTTP(S) URL the model hands it**, with
  up to five redirects. On a host that can route to private networks,
  the model can therefore reach intranet services, link-local addresses,
  or cloud-instance metadata endpoints (`169.254.169.254`, etc.). This
  is by design for a local research tool but means you should not run
  this MCP server in topologies where an untrusted party can pick the
  URLs (e.g. a hosted MCP gateway facing the public internet).
  Body size is capped at 10 MB and content-type is sniffed before
  conversion, so a malformed upstream can't trivially OOM the process.

- **The `search` tools forward the model's query verbatim to SearXNG.**
  SearXNG is the trust boundary for upstream engine traffic; this
  package does not add additional rate-limiting or query rewriting.

Report suspected vulnerabilities privately via [GitHub Security
Advisories](https://github.com/burakaydinofficial/searxng-deepdive/security/advisories/new)
rather than opening a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
