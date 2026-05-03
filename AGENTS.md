# AGENTS.md — guide for AI assistants editing this codebase

If you are an AI agent (Claude Code, Cursor, Cline, Aider, Continue, Codex, …)
about to make changes here, read this first. It encodes what humans wish you
already knew so we don't repeat the same lessons.

For human-facing docs see `README.md`. This file is for agent-readable
working conventions.

---

## What this project is, in three sentences

`searxng-deepdive` is an MCP server that wraps a SearXNG instance for LLM
agents. It exposes four tools (`search`, `search_on_engines`,
`search_by_category`, `web_url_read`) with schemas and descriptions
designed for agent-tool-selection ergonomics, not just API completeness.
Its design DNA is: **convert every silent-wrong code path into an
informatively-wrong one** — empty results and wrong-tool calls must
always carry a hint specific enough that a retry has a real chance.

---

## Setup

Node ≥20. From repo root:

```bash
npm install
npm run build      # tsc — strict mode, noUnusedLocals/Parameters
npm test           # vitest — should be 100+ tests, ~4s
```

Live development against a running SearXNG:

```bash
SEARXNG_URL=http://127.0.0.1:7979 npm run probe   # exercise the SearxngClient directly
SEARXNG_URL=http://127.0.0.1:7979 npm run dev     # start the MCP stdio server
```

`probe` bypasses MCP entirely and prints search results — fastest dev
loop when you want to see what SearXNG is actually returning.

---

## File map

```
src/
├── index.ts          # stdio MCP entrypoint; probes /config at startup
├── searxng.ts        # SearXNG HTTP client (getConfig, search, searchMultiPage)
├── schemas.ts        # Zod schemas for tool inputs (single source of truth
│                     #   for runtime validation + JSON schema sent to MCP)
├── descriptions.ts   # Tool description builders, generated dynamically from
│                     #   the live SearxngConfig at server startup
├── tools.ts          # Tool registration + dispatch; doSearch unifies the
│                     #   three search variants. Exports normalizeName,
│                     #   validateEngineSelection, validateCategorySelection,
│                     #   buildZeroResultHint, trimToCompact for tests.
└── url-reader.ts     # web_url_read implementation: undici fetch +
                      #   node-html-markdown + extraction modes
                      #   (readHeadings, section, paragraphRange, window)

tests/
├── normalize-name.test.ts        # case/whitespace normalization
├── validators.test.ts            # engine/category cross-validation w/ hints
├── zero-result-hint.test.ts      # every hint trigger + its inverse
├── trim-to-compact.test.ts       # response trimming
├── descriptions.test.ts          # ANTI-PATTERN regex checks for description copy
├── searxng-client.test.ts        # HTTP client w/ undici MockAgent
└── url-reader.test.ts            # extraction helpers + HTTP integration

scripts/
└── probe.ts          # dev-time SearxngClient exerciser (not in published bundle)

.github/workflows/
├── test.yml          # push/PR/dispatch — Node 20/22/24 × {ubuntu,macos,windows} matrix
└── publish.yml       # tags v*.*.* — verifies version, runs tests, npm publish
```

---

## Design principles to preserve

These are the load-bearing decisions. If a change you're proposing breaks
one of them, stop and ask the human first.

### 1. Silent-wrong must become informatively-wrong

Every code path where SearXNG quietly returns "successful" but useless
results gets a hint or an error. Patterns we already cover:

- Wrong-tool calls (engine names in `categories` array, etc.) →
  `validateEngineSelection` / `validateCategorySelection` throw with
  cross-reference hints pointing at the correct tool.
- `time_range` set against engines that don't support it → the response
  carries a `hint` field.
- All requested engines unresponsive → hint mentions upstream availability.
- Single engine returns nothing → hint suggests broader search.

When you add a new failure mode, add a hint. When you add a new validation,
add a test that asserts the hint message. The pattern is more important
than any individual rule.

### 2. Dynamic descriptions reflect THIS instance, not a generic template

Tool descriptions are built at server startup from `client.getConfig()`.
If you find yourself hardcoding engine or category names in
`descriptions.ts`, stop — that's how we made wrong claims about which
engines support `time_range` and got it patched out twice.

### 3. Schema descriptions cannot lie about defaults

If a Zod field says "Default 'auto'" but the code doesn't pass `'auto'`
when the field is omitted, the model believes the lie and gets confused.
Two specific historical traps:

- `time_range` once said "ignored by engines that don't support it" — it
  isn't ignored, those engines return empty. Fixed.
- `language` once said "Default 'auto' (let SearXNG pick from the query)"
  — there's no such default; the instance's configured locale applies. Fixed.

`tests/descriptions.test.ts` has anti-pattern regex checks for those exact
strings. If you reintroduce them, the test fails. If you find another lie
that needs the same treatment, add a regex check there.

### 4. Compact-format response is the default

The `format: "compact"` default keeps responses to `url/title/content/engine`
per result. Never change the default to `"full"` — that bloats every search
the LLM ever does. The `full` form is one parameter away when needed.

### 5. Lowercase normalization both ways

SearXNG is case-sensitive on engine/category names. The model frequently
passes mixed case (`arXiv`, `Semantic Scholar`). We normalize via
`normalizeName(s) = s.trim().toLowerCase()` on:
- input validation (so case doesn't fail the check)
- URL parameters sent to SearXNG (so wrong case doesn't silently no-op)

If you're adding a new place where engine/category names are compared,
go through `normalizeName`.

---

## Concrete gotchas

### MCP clients cache the subprocess

When you edit code, the running MCP server keeps the old behavior until
the host (LM Studio, Claude Desktop, etc.) restarts the subprocess.
Symptom: a fix you just shipped doesn't appear in the next call.

Quitting the chat window is usually not enough — fully quit the host
application or toggle the MCP plugin off+on in its settings.

This bites every contributor at least once. Document time spent
"debugging" what was already fixed.

### Pure-function exports from `tools.ts` exist for tests

`normalizeName`, `validateEngineSelection`, `validateCategorySelection`,
`buildZeroResultHint`, `trimToCompact` are all `export`ed. They didn't
need to be for the MCP transport — they're exported because the test
suite needs to assert their behavior in isolation. Don't make them
non-exported; the tests will break.

### `searchMultiPage` partial-failure semantics

By design: if some pages fail and at least one succeeds, return the
merged results from the successful pages with `pages_fetched < pages`.
If ALL pages fail, throw. Don't change the all-fail path back to
silently returning empty — that bug took a real LM Studio session to
catch and is locked in by `tests/searxng-client.test.ts`.

### `unresponsive_engines` from upstream can be `null`

Some SearXNG configurations send `null` instead of `[]`. Use
`Array.isArray(...)` guards before iterating. Both `searchMultiPage`
and `trimToCompact` handle this.

### Don't trust `body.json()` directly

SearXNG behind Cloudflare/nginx returns HTML 502 pages on error. Calling
`body.json()` on that throws bare `SyntaxError` with no useful diagnostic.
The pattern is: read body as text, try `JSON.parse`, catch and rethrow
with a 200-char `snippetOf(text)` of the body. Both `getConfig` and
`search` follow this.

---

## Test discipline — what to update when

| When you change… | Update… |
|---|---|
| A `.describe()` string in `schemas.ts` | `tests/descriptions.test.ts` if your edit involves a phrase that previously confused models (rare) |
| Tool description in `descriptions.ts` | `tests/descriptions.test.ts` — assert the new content is present, especially DO/DO-NOT markers |
| `validateEngineSelection` / `validateCategorySelection` | `tests/validators.test.ts` — add a case for each new failure path |
| `buildZeroResultHint` (new trigger condition) | `tests/zero-result-hint.test.ts` — assert the hint fires + assert it doesn't fire when condition isn't met |
| `SearxngClient.search` URL building | `tests/searxng-client.test.ts` — assert the new param appears in the URL |
| `SearxngClient.searchMultiPage` | `tests/searxng-client.test.ts` — at minimum, the all-fail and partial-fail paths still hold |
| `url-reader.ts` extractors | `tests/url-reader.test.ts` — pure-helper tests + at least one MockAgent integration test |

After ANY behavioral change, run `npm test` before committing.

**Don't write trial-and-error tests against a real LM Studio.** We did that
for too long. It's much faster to:
1. Identify the failure pattern from a real session
2. Write a unit test that reproduces it
3. Fix the code
4. Confirm test passes
5. Push and let the user verify in LM Studio at their convenience

When reactive fixes start piling up, stop and do a one-shot codebase
audit (a code-review-analyzer agent walking every file is the pattern
that's worked here) rather than continuing to tack one-line fixes onto
each new failure. The `CHANGELOG.md` 0.2.0 entry summarizes the most
recent such audit's outputs.

---

## Anti-patterns

Things to avoid:

- **Hardcoding engine names in error messages or descriptions.** Different
  SearXNG deployments have different engines enabled. Use the live config.
- **Adding a 4th, 5th, 6th tool that overlaps with the existing four.**
  More tools means worse model tool-selection. The bar for adding a tool
  is high; first try to extend an existing one.
- **Returning structured errors as MCP success responses with an
  `error: true` field.** Throw real errors. The MCP client's error
  envelope (`-32603`, etc.) is what the model is trained to read.
- **Adding `console.log` to production code paths.** They corrupt the
  stdio transport. Use `process.stderr.write(...)` with a `[searxng-deepdive]`
  prefix if you need to log; nothing else.
- **Bumping the version in `package.json` without also tagging.** The
  publish workflow verifies they match and refuses to publish if they
  don't. Bump-then-tag-then-push, in that order.

---

## Questions to ask the human before you do these

- Adding a new MCP tool
- Removing an existing tool (breaks user mcp.json configs)
- Renaming a tool (same)
- Changing a Zod input schema in a non-additive way (breaks existing callers)
- Adding a new dependency
- Bumping a major version
- Anything that requires changing the `publish.yml` workflow

For everything else (new tests, additional validation, description edits,
new hint conditions, internal refactor), prefer to act and report.

---

## If you've made it this far

You probably know enough to contribute well. The README has the user-
facing story; this file has the maintainer story. When in doubt, the
test suite is the contract — `npm test` is green or it isn't. If it
goes red, fix what you broke, don't loosen the test.
