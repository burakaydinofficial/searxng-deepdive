# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via GitHub Security
Advisories:

→ <https://github.com/burakaydinofficial/searxng-deepdive/security/advisories/new>

Do not open a public issue for security reports.

If you don't have a GitHub account or cannot use Security Advisories,
contact the maintainer directly via the email on the GitHub profile.

## What's in scope

This is a local-first MCP server. The threat model assumes the package
runs inside the user's trust boundary, with an LLM the user controls,
over a stdio MCP transport. Within that scope, the following are
considered legitimate concerns:

- input handling that crashes the process or causes undefined behavior
  on adversarial SearXNG responses or URL bodies
- supply-chain compromise paths in the published npm package
- unbounded resource consumption (memory, file descriptors) from any
  single tool call
- insufficient hardening of the URL-fetch path that goes beyond the
  documented "any URL the model picks" semantics (see README §Security
  notes — fetching arbitrary intranet URLs at the model's request is
  the *expected* behavior, not a vulnerability)

## What's out of scope

- The MCP server being used in a topology where an untrusted party
  selects the URLs / queries (e.g. a public-facing MCP gateway). This
  isn't the intended deployment; the README documents it.
- SearXNG instance compromise. SearXNG is upstream and has its own
  security model — report there.
- Issues that require local code execution on the host already running
  the MCP server. If the attacker has that, they own the box already.

## Versions covered

The latest published `0.x` release on npm. Older `0.x` releases will
not receive security patches; upgrade to the current line.
