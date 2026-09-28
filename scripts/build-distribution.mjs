import { copyFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageDir = path.join(root, "packages/cappy");
const outputDir = path.join(packageDir, "dist");

await mkdir(outputDir, { recursive: true });
await copyFile(path.join(root, "LICENSE"), path.join(packageDir, "LICENSE"));
await build({
  entryPoints: [path.join(root, "packages/cli/src/bin.ts")],
  outfile: path.join(outputDir, "cappy.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  conditions: ["source"],
  external: ["node:*", "ws", "zod"],
  sourcemap: false,
  legalComments: "none",
});
await chmod(path.join(outputDir, "cappy.js"), 0o755);
