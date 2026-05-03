// Single source of truth for the package version.
//
// Read at module load from package.json so a `npm version` bump propagates
// without separate code edits. The MCP handshake (src/index.ts) and the
// outbound user-agent (src/url-reader.ts) both consume this.
//
// Why a runtime read instead of `import pkg from "../package.json"`?
//   - Node ESM requires `with { type: "json" }` import attributes for JSON
//     modules, which only stabilized in Node 20+. Our `engines` allows Node 18.
//   - tsconfig has `rootDir: "./src"`, so an `import "../package.json"`
//     would also fight the emitted directory layout.
//   - The publish workflow already verifies tag↔package.json agreement, so
//     this read becomes the single hop the rest of the code depends on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// dist/version.js → ../package.json   (npm-published layout)
// src/version.ts  → ../package.json   (tsx dev layout)
const pkgPath = join(here, "..", "package.json");

interface Pkg {
  version?: unknown;
}
const pkg: Pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Pkg;

export const VERSION: string =
  typeof pkg.version === "string" && pkg.version.length > 0
    ? pkg.version
    : "0.0.0";
