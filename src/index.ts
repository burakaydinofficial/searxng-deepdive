#!/usr/bin/env node
// searxng-deepdive MCP server entrypoint.
//
// Connects to a SearXNG instance via SEARXNG_URL (default http://127.0.0.1:8080),
// introspects /config to learn the live engine pool, and exposes four tools
// (three search variants + web_url_read) over MCP stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SearxngClient, type SearxngConfig } from "./searxng.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8080";

function logStderr(msg: string): void {
  process.stderr.write(`[searxng-deepdive] ${msg}\n`);
}

async function main(): Promise<void> {
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
