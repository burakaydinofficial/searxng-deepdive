#!/usr/bin/env node
// searxng-deepdive MCP server entrypoint.
//
// Connects to a SearXNG instance via SEARXNG_URL (default http://127.0.0.1:8080),
// introspects /config to learn the live engine pool, and exposes three search
// tools over MCP stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SearxngClient } from "./searxng.js";
import { registerTools } from "./tools.js";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8080";

function logStderr(msg: string): void {
  process.stderr.write(`[searxng-deepdive] ${msg}\n`);
}

async function main(): Promise<void> {
  const client = new SearxngClient(SEARXNG_URL);

  // Probe early so we fail loudly if SearXNG isn't reachable, instead of
  // registering tools that will all 500 on first call.
  let engineCount = 0;
  try {
    const cfg = await client.getConfig();
    engineCount = cfg.enabledEngines.length;
  } catch (e) {
    logStderr(
      `Failed to reach SearXNG at ${SEARXNG_URL}. Set SEARXNG_URL to your instance.`,
    );
    logStderr(`Original error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const server = new Server(
    { name: "searxng-deepdive", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  await registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logStderr(
    `Connected to ${SEARXNG_URL} (${engineCount} engines enabled). MCP stdio server ready.`,
  );
}

main().catch((e) => {
  logStderr(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
