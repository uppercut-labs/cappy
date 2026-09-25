#!/usr/bin/env node
// Assemble the runnable Godot demo: fixtures/godot-demo plus the Cappy addon
// from adapters/godot/addons, copied into <destination>.
//
//   node scripts/assemble-godot-demo.mjs <destination>
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assembleGodotDemo(destination) {
  const target = path.resolve(destination);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(root, "fixtures/godot-demo"), target, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".godot"),
  });
  cpSync(path.join(root, "adapters/godot/addons"), path.join(target, "addons"), { recursive: true });
  return target;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (destination === undefined) {
    process.stderr.write("usage: node scripts/assemble-godot-demo.mjs <destination>\n");
    process.exit(2);
  }
  if (existsSync(path.join(destination, "project.godot"))) {
    process.stderr.write(`updating existing demo at ${destination}\n`);
  }
  process.stdout.write(`${assembleGodotDemo(destination)}\n`);
}
