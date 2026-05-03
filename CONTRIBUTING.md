# Contributing

Thanks for considering a contribution to `searxng-deepdive`.

## Quick start

```bash
npm install
npm run build      # tsc — strict mode
npm test           # vitest — should be green and fast (<5s)
```

For live development against a running SearXNG instance:

```bash
SEARXNG_URL=http://127.0.0.1:7979 npm run probe   # exercise the client directly
SEARXNG_URL=http://127.0.0.1:7979 npm run dev     # start the MCP stdio server
```

`probe` bypasses MCP entirely — fastest dev loop when you want to see
what SearXNG is actually returning.

## Before you open a PR

1. **Run the test suite.** `npm test` must pass. Most behavioral changes
   should also add or update a test.
2. **Read [`AGENTS.md`](AGENTS.md).** It's the maintainer-facing guide:
   design principles to preserve, concrete gotchas, the
   "which-test-file-to-update-when" matrix, and a list of changes that
   warrant asking before doing.
3. **Keep changes scoped.** This is a small package with a tight
   contract; large speculative refactors are usually rejected even if
   they "work." A reviewable change does one thing and includes the
   test that proves it.
4. **Mind the schema descriptions.** Tool descriptions and `.describe()`
   strings are agent-facing copy; `tests/descriptions.test.ts` has
   anti-pattern regex checks for wording that empirically misled
   models. Don't reintroduce those phrases.

## Reporting bugs

Open a GitHub issue. Useful issues include:

- the MCP client you're using (Claude Desktop, LM Studio, Cursor, …)
- the SearXNG version + relevant `/config` snippet (engine names, etc.)
- the exact tool call the LLM made and the response it got back
- the version of `searxng-deepdive` (`npm ls searxng-deepdive`)

For suspected security issues, do **not** open a public issue — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the
[MIT License](LICENSE).
