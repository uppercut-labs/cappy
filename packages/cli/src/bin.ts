#!/usr/bin/env node
import { main } from "./main.js";

const exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});
process.exitCode = exitCode;
