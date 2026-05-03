// Dev-time tool exerciser. Bypasses the MCP layer; calls our SearxngClient
// directly and prints JSON for visual inspection.
//
// Usage:
//   SEARXNG_URL=http://127.0.0.1:7979 npm run probe
//
// Prints (roughly):
//   - introspection summary (engine count, category list)
//   - search('claude code') compact, single page
//   - search_on_engines('claude code', ['duckduckgo', 'wikipedia'])
//   - search_by_category('claude code', ['general', 'it'])
//   - search('claude code', pages=2) -- multi-page fanout

import { SearxngClient } from "../src/searxng.js";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:7979";
const QUERY = process.env.PROBE_QUERY ?? "claude code";

function header(label: string): void {
  process.stdout.write(`\n=== ${label} ===\n`);
}

function compact(resp: { results: Array<{ url: string; title: string; engine: string }> }): void {
  for (const r of resp.results.slice(0, 5)) {
    process.stdout.write(`  ${r.engine.padEnd(15)} ${r.title.slice(0, 80)}\n`);
    process.stdout.write(`  ${" ".repeat(15)} ${r.url}\n`);
  }
  if (resp.results.length > 5) {
    process.stdout.write(`  ... +${resp.results.length - 5} more\n`);
  }
}

async function main(): Promise<void> {
  const client = new SearxngClient(SEARXNG_URL);

  header("Introspection (/config)");
  const cfg = await client.getConfig();
  process.stdout.write(`  ${cfg.enabledEngines.length} engines enabled\n`);
  process.stdout.write(`  ${cfg.enabledCategories.length} categories: ${cfg.enabledCategories.join(", ")}\n`);

  header(`search('${QUERY}')`);
  const r1 = await client.search({ query: QUERY });
  process.stdout.write(`  ${r1.results.length} results\n`);
  compact(r1);

  header(`search_on_engines('${QUERY}', ['duckduckgo', 'wikipedia'])`);
  const r2 = await client.search({
    query: QUERY,
    engines: ["duckduckgo", "wikipedia"],
  });
  process.stdout.write(`  ${r2.results.length} results\n`);
  compact(r2);

  header(`search_by_category('${QUERY}', ['general', 'it'])`);
  const r3 = await client.search({
    query: QUERY,
    categories: ["general", "it"],
  });
  process.stdout.write(`  ${r3.results.length} results\n`);
  compact(r3);

  header(`search('${QUERY}', pages=2) -- multi-page fanout`);
  const r4 = await client.searchMultiPage({ query: QUERY, pages: 2 });
  process.stdout.write(`  ${r4.results.length} merged results across ${r4.pages_fetched} page(s)\n`);
  compact(r4);
}

main().catch((e) => {
  process.stderr.write(`probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
