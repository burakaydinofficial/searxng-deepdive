# searxng-deepdive

An [MCP](https://modelcontextprotocol.io/) server for [SearXNG](https://docs.searxng.org/)
designed for LLM agents doing real research. Three search tools with
agent-friendly schemas, multi-page fanout for hundreds of results in one call,
and tool descriptions generated dynamically from the live engine pool of
*your* instance.

> **Status:** v0.1, in-tree development inside the
> [SearXNG-Compose](https://github.com/burakaydinofficial/SearXNG-Compose) repo.
> Will move to its own repo and publish to npm at v1.0.

## Why another mcp-searxng?

The existing packages are minimal: most expose a single `search(query)` tool
with no way for the model to ask for more results, target specific engines,
or constrain by category. The richer ones still bake static descriptions —
the LLM never learns what's actually enabled on *this* instance.

`searxng-deepdive` opens those knobs up:

| Feature | This | npm `mcp-searxng` (ihor-sokoliuk) | PyPI `mcp-searxng` (SecretiveShell) |
|---|---|---|---|
| Engine targeting | ✅ via `search_on_engines` | ❌ | ❌ |
| Category targeting | ✅ via `search_by_category` | ❌ | ❌ |
| Multi-page fanout in one call | ✅ via `pages: N` | ❌ (one page per call) | ❌ |
| Pagination | ✅ via `pageno` | ✅ | ❌ |
| Compact response (~80% fewer tokens) | ✅ via `format: "compact"` | ❌ | ❌ |
| Dynamic descriptions per instance | ✅ live engine list injected | ❌ static | ❌ static |
| Web URL reader (HTML→Markdown) | ⏳ v0.2 | ✅ | ❌ |

## Tools

### `search(query, [pageno, pages, time_range, language, safe_search, format])`

Broad web search across the SearXNG instance's full enabled engine pool.
Returns 80–200 results per page after dedup. Use `pages: N` to fan out.

### `search_on_engines(query, engines, [...common])`

Search using only the specified engines. The tool description registered
with the MCP client includes the actual list of engines enabled on your
instance — the agent doesn't have to guess.

### `search_by_category(query, categories, [...common])`

Search within specific categories. Description includes the live category
list with sample engines per category.

## Install & run

### Standalone (development, in this repo)

```bash
cd mcp-server
npm install
SEARXNG_URL=http://127.0.0.1:7979 npm run probe   # exercise the search client
SEARXNG_URL=http://127.0.0.1:7979 npm run dev      # start the MCP stdio server
```

### From an MCP client

Once published to npm:

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

For now (in-tree development), point the client at the source via `tsx`:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "tsx", "C:/path/to/SearXNG-Compose/mcp-server/src/index.ts"],
      "env": { "SEARXNG_URL": "http://127.0.0.1:7979/" }
    }
  }
}
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `SEARXNG_URL` | `http://127.0.0.1:8080` | Base URL of the SearXNG instance |

## Roadmap

- **v0.1 (this)** — three search tools, multi-page fanout, dynamic descriptions.
- **v0.2** — `web_url_read` tool for cheap static-page Markdown extraction
  (HTTP fetch + HTML→Markdown), with token-efficient extraction params
  (`section`, `paragraphRange`, `readHeadings`).
- **v0.3** — optional `depth` semantic alias (`quick` / `medium` / `deep`)
  if real-world testing shows agents want it. Hold off until evidence.
- **v1.0** — extract to its own repo, publish to npm, write the proper
  contribution guide.

## Design notes

- **Why three tools instead of one with optional engine/category params?**
  Cleaner agent decision-making. With three distinct tools the LLM sees
  three explicit purposes; with one fat tool it has to remember when to
  set which optional flags. Compromises: more entries in the MCP tool list,
  identical handler logic under three names. Net: better agent ergonomics.
- **Why `format: "compact"` as default?** SearXNG's full result objects are
  ~5× heavier than just url+title+content+engine. For the typical agent
  workflow (rank candidates, pick a few to fetch in detail), the compact
  form is what the LLM actually uses. `format: "full"` is one parameter
  away when you need the rest.
- **Why dynamic descriptions?** Static descriptions either list every
  upstream engine (most aren't enabled on a given instance — wastes context)
  or list none (LLM has no idea what to put in `engines`). Live introspection
  at server startup gives the LLM exactly the right hint.

## License

MIT.
