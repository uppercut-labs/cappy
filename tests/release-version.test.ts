import { readFile as readRaw } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPPY_VERSION } from "@uppercut-labs/cappy-internal-core";

/*
 * Every version label a release ships or is tagged with must agree with the
 * public package version: the CLI's CAPPY_VERSION, the Godot addon that ships
 * beside it (ADR-025), and the release workflow's expected tag. Nothing public
 * ships labeled below 1.0.0.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = "adapters/godot/addons/cappy";

async function readFile(file: string): Promise<string> {
  return (await readRaw(path.join(repoRoot, file), "utf8")).replace(/\r\n/g, "\n");
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile("packages/cappy/package.json")) as { version: string };
  return manifest.version;
}

describe("release version labels", () => {
  it("publishes a version of at least 1.0.0", async () => {
    expect(await packageVersion()).toMatch(/^[1-9]\d*\.\d+\.\d+$/);
  });

  it("reports the package version from the CLI", async () => {
    expect(CAPPY_VERSION).toBe(await packageVersion());
  });

  it("labels the shipped Godot addon with the package version", async () => {
    const version = await packageVersion();
    const plugin = await readFile(`${addonDir}/plugin.cfg`);
    expect(/^version="([^"]*)"$/m.exec(plugin)?.[1]).toBe(version);
    const adapter = await readFile(`${addonDir}/cappy_adapter.gd`);
    expect(/^const ADAPTER_VERSION := "([^"]*)"$/m.exec(adapter)?.[1]).toBe(version);
  });

  it("expects the matching tag in the release workflow", async () => {
    const workflow = await readFile(".github/workflows/release.yml");
    expect(/^\s+default: (v\S+)$/m.exec(workflow)?.[1]).toBe(`v${await packageVersion()}`);
  });
});
