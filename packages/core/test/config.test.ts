import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigIssue, loadConfig, parseConfig } from "@cappy/core";

const minimal = {
  schemaVersion: 1,
  project: { id: "demo", name: "Demo Game" },
  game: { command: "demo-game" },
  adapter: { port: 47100 },
};

function issuesOf(raw: unknown): ConfigIssue[] {
  const result = parseConfig(raw);
  if (result.ok) {
    throw new Error("expected configuration to be invalid");
  }
  expect(result.error.code).toBe("CONFIG_INVALID");
  expect(result.error.operation).toBe("config.load");
  return result.error.details?.["issues"] as ConfigIssue[];
}

describe("parseConfig", () => {
  it("accepts a minimal configuration and applies defaults", () => {
    const result = parseConfig(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.adapter.host).toBe("127.0.0.1");
    expect(result.value.game.args).toEqual([]);
    expect(result.value.presets).toEqual({});
    expect(result.value.timeouts).toEqual({ connectMs: 30_000, readyMs: 60_000, obsMs: 10_000, processMs: 300_000 });
  });

  it("accepts a full configuration with OBS, tools, and presets", () => {
    const result = parseConfig({
      ...minimal,
      game: { command: "demo-game", args: ["--path", "fixtures/demo"], cwd: "." },
      workspace: { root: "/captures/demo" },
      obs: { url: "ws://127.0.0.1:4455", passwordEnv: "CAPPY_OBS_PASSWORD", scene: "Capture" },
      tools: { ffmpeg: "/opt/ffmpeg/bin/ffmpeg" },
      presets: {
        trailer: {
          scene: "Capture",
          derivatives: [
            { kind: "mp4", role: "delivery" },
            { kind: "thumbnail", role: "thumb", required: false },
          ],
        },
      },
      defaultPreset: "trailer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.obs?.switchScene).toBe(false);
    expect(result.value.presets["trailer"]?.derivatives[0]?.required).toBe(true);
  });

  it("reports every invalid field with a structured path", () => {
    const issues = issuesOf({
      schemaVersion: 2,
      project: { id: "Not Valid", name: "" },
      game: {},
      adapter: { port: 70000 },
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["schemaVersion", "project.id", "project.name", "game.command", "adapter.port"]));
    for (const issue of issues) {
      expect(issue.message).toEqual(expect.any(String));
    }
  });

  it("rejects unknown keys so typos are not silently ignored", () => {
    const paths = issuesOf({ ...minimal, adaptor: { port: 1 } }).map((issue) => issue.path);
    expect(paths).toContain("(root)");
  });

  it("rejects a non-loopback adapter listener", () => {
    const issues = issuesOf({ ...minimal, adapter: { host: "0.0.0.0", port: 47100 } });
    expect(issues).toEqual([expect.objectContaining({ path: "adapter.host", message: expect.stringContaining("loopback") })]);
  });

  it("refuses to store an OBS password in configuration", () => {
    const issues = issuesOf({ ...minimal, obs: { password: "hunter2" } });
    expect(issues).toEqual([expect.objectContaining({ path: "obs.password", message: expect.stringContaining("passwordEnv") })]);
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("rejects a default preset that is not defined", () => {
    const issues = issuesOf({ ...minimal, defaultPreset: "missing" });
    expect(issues).toEqual([expect.objectContaining({ path: "defaultPreset" })]);
  });

  it("rejects duplicate derivative roles within a preset", () => {
    const issues = issuesOf({
      ...minimal,
      presets: { trailer: { derivatives: [{ kind: "mp4", role: "out" }, { kind: "clip", role: "out" }] } },
    });
    expect(issues).toEqual([expect.objectContaining({ path: "presets.trailer.derivatives[1].role" })]);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cappy-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads cappy.config.json from the project directory", async () => {
    await writeFile(path.join(dir, "cappy.config.json"), JSON.stringify(minimal));
    const result = await loadConfig({ projectDir: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectDir).toBe(path.resolve(dir));
    expect(result.value.configPath).toBe(path.join(path.resolve(dir), "cappy.config.json"));
    expect(result.value.config.project.id).toBe("demo");
  });

  it("fails with CONFIG_NOT_FOUND when the file is missing", async () => {
    const result = await loadConfig({ projectDir: dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "CONFIG_NOT_FOUND", operation: "config.load", retryable: false });
  });

  it("fails with CONFIG_PARSE_ERROR for malformed JSON", async () => {
    await writeFile(path.join(dir, "cappy.config.json"), "{ not json");
    const result = await loadConfig({ projectDir: dir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_PARSE_ERROR");
  });

  it("fails with CONFIG_INVALID for schema-invalid content", async () => {
    await writeFile(path.join(dir, "custom.json"), JSON.stringify({ ...minimal, adapter: {} }));
    const result = await loadConfig({ projectDir: dir, configPath: "custom.json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.["issues"]).toEqual([expect.objectContaining({ path: "adapter.port" })]);
  });
});
