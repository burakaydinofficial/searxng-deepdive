# CLAUDE.md

> **Read [`AGENTS.md`](AGENTS.md) from top to bottom before doing anything else
> in this repository.** It is the source of truth for working conventions
> (design principles, file map, test discipline, gotchas, anti-patterns).
> Treat its contents as your primary working context for this project.

## Why two files?

`AGENTS.md` is the canonical, cross-tool guide — read by Cursor, Cline,
Aider, Continue, Codex, and Claude Code itself when present. It's the
single source of truth so the project doesn't have to maintain N copies
of the same conventions for N agent ecosystems.

`CLAUDE.md` (this file) exists only because Claude Code's default
discovery convention is to read `CLAUDE.md` automatically. Without this
redirect, a Claude Code session in this repo would skip the project
conventions entirely. The redirect ensures the same context is loaded
regardless of which agent ecosystem is opening the repo.

The whole content of this file is the redirect plus this explanation.
**All project conventions live in `AGENTS.md`** — do not add
project-wide rules here, that creates two-source drift.

## Personal vs project conventions

If you have personal Claude-specific conventions (custom slash commands,
local hooks, preferences that aren't appropriate for every contributor):

- Put them in a separate file, e.g. `.claude/conventions.md`, and
  gitignore that path.
- Don't add them to this `CLAUDE.md`, which is committed and shared.
- Don't add them to `AGENTS.md` either, which is also committed and
  shared.

The committed CLAUDE.md and AGENTS.md describe how to contribute *to
this project*, not how any one contributor's editor is configured.

---

→ Continue at [`AGENTS.md`](AGENTS.md).
