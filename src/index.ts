#!/usr/bin/env node
// searxng-deepdive MCP server entrypoint.
//
// Connects to a SearXNG instance via SEARXNG_URL (default http://127.0.0.1:8080),
// introspects /config to learn the live engine pool, and exposes four tools
// (three search variants + web_url_read) over MCP stdio.

import { setGlobalDispatcher } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SearxngClient, type SearxngConfig } from "./searxng.js";
import { registerTools } from "./tools.js";
import { createGuardedAgent, isPrivateBlockingEnabled } from "./ssrf-guard.js";
import { VERSION } from "./version.js";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8080";

function logStderr(msg: string): void {
  process.stderr.write(`[searxng-deepdive] ${msg}\n`);
}

async function main(): Promise<void> {
  // web_url_read reaching intranet/IP endpoints is a documented feature, so the
  // private-address guard is OPT-IN. When enabled via SEARXNG_DEEPDIVE_BLOCK_
  // PRIVATE, install a connect-time guard so even DNS rebinding can't reach an
  // internal address (a pre-flight host check alone can't — undici resolves
  // again at connect time). The operator's SEARXNG_URL host stays allowed so
  // the metasearch client keeps working; allow more via SEARXNG_DEEPDIVE_
  // ALLOWED_HOSTS.
  if (isPrivateBlockingEnabled(process.env)) {
    setGlobalDispatcher(createGuardedAgent([new URL(SEARXNG_URL).hostname]));
    logStderr(
      `Private-address blocking is ON (${"SEARXNG_DEEPDIVE_BLOCK_PRIVATE"} set); web_url_read cannot reach internal hosts except the allowlist.`,
    );
  }

  const client = new SearxngClient(SEARXNG_URL);

  // Introspect /config so tool descriptions reflect this instance's live engine
  // pool, and hand it to registerTools so MCP setup doesn't pay for a second
  // round-trip. But do NOT refuse to boot if SearXNG is unreachable: the server
  // must still complete the MCP handshake and list its tools — for smoke tests,
  // `npx` trials, and clients that start before SearXNG is up. In that case we
  // register with generic descriptions and surface the failure on the actual
  // tool call (which throws a clear error the model can act on); the search
  // path re-fetches /config lazily, so targeted searches recover once SearXNG
  // comes up, without a restart.
  let cfg: SearxngConfig;
  let degraded = false;
  try {
    cfg = await client.getConfig();
  } catch (e) {
    degraded = true;
    cfg = { enabledEngines: [], enabledCategories: [], enginesByCategory: {} };
    logStderr(
      `SearXNG not reachable at ${SEARXNG_URL} at startup (${e instanceof Error ? e.message : String(e)}). ` +
        `Starting in degraded mode: tools list with generic descriptions and calls retry SearXNG. ` +
        `Set SEARXNG_URL to your instance; restart once it is reachable for the live engine list.`,
    );
  }

  const server = new Server(
    { name: "searxng-deepdive", version: VERSION },
    { capabilities: { tools: {} } },
  );

  await registerTools(server, client, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logStderr(
    degraded
      ? `MCP stdio server ready (DEGRADED — SearXNG at ${SEARXNG_URL} was unreachable at startup).`
      : `Connected to ${SEARXNG_URL} (${cfg.enabledEngines.length} engines enabled). MCP stdio server ready.`,
  );
}

main().catch((e) => {
  logStderr(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
