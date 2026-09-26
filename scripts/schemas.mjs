#!/usr/bin/env node
// Write Cappy's published JSON Schemas (docs/schemas/) from the runtime schemas.
// Run through `npm run schemas`, which builds first.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { publishedSchemas } from "../packages/core/dist/index.js";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "schemas");
mkdirSync(directory, { recursive: true });
for (const [file, schema] of Object.entries(publishedSchemas())) {
  writeFileSync(path.join(directory, file), `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote docs/schemas/${file}\n`);
}
