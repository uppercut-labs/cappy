import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs|json)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).some((segment) => segment === "node_modules" || segment === "dist"));
}

describe("package boundaries", () => {
  it("keeps every shared TypeScript package free of Godot dependencies", async () => {
    const packages = await readdir(packagesDir, { withFileTypes: true });
    expect(packages.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const pkg of packages.filter((entry) => entry.isDirectory())) {
      for (const file of await sourceFiles(path.join(packagesDir, pkg.name))) {
        if (/godot/i.test(await readFile(file, "utf8"))) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
