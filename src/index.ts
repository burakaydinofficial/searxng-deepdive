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

  // Probe early so we fail loudly if SearXNG isn't reachable, instead of
  // registering tools that will all 500 on first call. The fetched config
  // is then handed to registerTools so we don't pay for a second /config
  // round-trip during MCP setup.
  let cfg: SearxngConfig;
  try {
    cfg = await client.getConfig();
  } catch (e) {
    logStderr(
      `Failed to reach SearXNG at ${SEARXNG_URL}. Set SEARXNG_URL to your instance.`,
    );
    logStderr(`Original error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const server = new Server(
    { name: "searxng-deepdive", version: VERSION },
    { capabilities: { tools: {} } },
  );

  await registerTools(server, client, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logStderr(
    `Connected to ${SEARXNG_URL} (${cfg.enabledEngines.length} engines enabled). MCP stdio server ready.`,
  );
}

main().catch((e) => {
  logStderr(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
