import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Build every package once so tests can launch real CLI and fixture processes. */
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b"], { cwd: root, stdio: "inherit" });
}
