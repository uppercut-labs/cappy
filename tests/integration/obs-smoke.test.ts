import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "@cappy/cli";
import { manifestSchema } from "@cappy/core";
import { repoRoot, simulatorBin } from "../../packages/cli/test/support.js";

/*
 * Real OBS smoke capture. Opt-in: requires a running OBS Studio (28+) with
 * WebSocket enabled, FFmpeg/ffprobe on PATH, and:
 *
 *   CAPPY_OBS_SMOKE=1
 *   CAPPY_OBS_SCENE=<existing scene name>
 *   CAPPY_OBS_URL=ws://127.0.0.1:4455      (optional; this is the default)
 *   CAPPY_OBS_PASSWORD=<password>          (only when OBS authentication is on)
 *
 * The test records a real master of about two seconds, moves it into a
 * temporary managed workspace, and produces real derivatives.
 */
const enabled = process.env["CAPPY_OBS_SMOKE"] === "1" && process.env["CAPPY_OBS_SCENE"] !== undefined;

describe.runIf(enabled)("real OBS smoke capture", { timeout: 120_000 }, () => {
  let project: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-obs-smoke-")));
    await writeFile(
      path.join(project, "cappy.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "obs-smoke", name: "OBS Smoke" },
        game: { command: process.execPath, args: [simulatorBin] },
        adapter: { port: 0 },
        obs: {
          url: process.env["CAPPY_OBS_URL"] ?? "ws://127.0.0.1:4455",
          scene: process.env["CAPPY_OBS_SCENE"],
          ...(process.env["CAPPY_OBS_PASSWORD"] === undefined ? {} : { passwordEnv: "CAPPY_OBS_PASSWORD" }),
        },
        presets: {
          smoke: {
            derivatives: [
              { kind: "mp4", role: "delivery", options: { preset: "ultrafast" } },
              { kind: "thumbnail", role: "thumb", options: { at: 0.5 } },
            ],
          },
        },
        defaultPreset: "smoke",
        // A real OBS on a busy host (for example during the full parallel suite) can take a while to identify.
        timeouts: { obsMs: 30_000 },
      }),
    );
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function cli(args: string[]): Promise<{ code: number; result: Record<string, any> }> {
    let stdout = "";
    const code = await main([...args, "--json", "-C", project], {
      cwd: repoRoot,
      env: { ...process.env, CAPPY_SIM_OPTIONS: JSON.stringify({ timeScale: 3 }) },
      write: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    });
    return { code, result: JSON.parse(stdout) as Record<string, any> };
  }

  it("passes doctor against the real OBS", async () => {
    const { result } = await cli(["doctor"]);
    const checks = Object.fromEntries(result["data"]["checks"].map((entry: { id: string; status: string }) => [entry.id, entry.status]));
    const failing = result["data"]["checks"].filter((entry: { status: string }) => entry.status !== "pass" && entry.status !== "warn");
    expect(checks, JSON.stringify(failing)).toMatchObject({ obs: "pass", "obs.scenes": "pass", ffmpeg: "pass", ffprobe: "pass" });
  });

  it("records, verifies, and processes a real master", async () => {
    const { code, result } = await cli(["run", "boss_intro"]);
    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(project, ".cappy", result["data"]["manifest"]), "utf8")) as Record<string, any>;
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest["status"]).toBe("succeeded");
    const master = manifest["artifacts"][0];
    expect(master).toMatchObject({ role: "master", ownership: "managed", source: { tool: "obs" } });
    expect(master.durationMs).toBeGreaterThan(500);
    expect(manifest["artifacts"].map((artifact: { role: string }) => artifact.role)).toEqual(["master", "delivery", "thumb"]);
    expect(JSON.stringify(manifest)).not.toContain(process.env["CAPPY_OBS_PASSWORD"] ?? "\u0000no-password");
  });
});
