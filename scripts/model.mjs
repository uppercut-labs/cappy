#!/usr/bin/env node
// Validate or render the living system model (docs/system-model.dot) with
// Graphviz compiled to WebAssembly (@hpcc-js/wasm-graphviz, a pinned dev
// dependency), so no system Graphviz install is needed on any host. Graphviz
// is a documentation tool only; Cappy never needs it at runtime.
//
//   node scripts/model.mjs check    # lay out the model; exits non-zero on errors or warnings
//   node scripts/model.mjs render   # write docs/system-model.svg
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Graphviz } from "@hpcc-js/wasm-graphviz";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = path.join(root, "docs/system-model.dot");
const mode = process.argv[2];

if (mode !== "check" && mode !== "render") {
  process.stderr.write("usage: node scripts/model.mjs check|render\n");
  process.exit(2);
}

const graphviz = await Graphviz.load();
let svg;
try {
  svg = graphviz.dot(readFileSync(model, "utf8"), "svg");
} catch (cause) {
  process.stderr.write(`docs/system-model.dot is invalid: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
if (mode === "check") {
  process.stdout.write(`docs/system-model.dot is valid (Graphviz ${graphviz.version()})\n`);
} else {
  writeFileSync(path.join(root, "docs/system-model.svg"), svg);
  process.stdout.write(`wrote docs/system-model.svg (Graphviz ${graphviz.version()})\n`);
}
