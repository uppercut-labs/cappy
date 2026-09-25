#!/usr/bin/env node
// Launcher for the built CLI. It exists before the first build so npm can
// create the `cappy` command on every platform (Windows shims are only made
// for files that exist at install time).
import { existsSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const entry = new URL("../dist/bin.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write("cappy is not built yet: run `npm run build` in the Cappy repository first.\n");
  process.exit(70);
}
await import(entry.href);
