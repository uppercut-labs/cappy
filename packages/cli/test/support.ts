import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Interrupts, main } from "@cappy/cli";
import { FakeObsServer, type FakeObsOptions } from "@cappy/fake-obs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const simulatorBin = path.join(repoRoot, "fixtures/adapter-simulator/dist/bin.js");

/** Fake ffprobe: valid JSON for any file unless its content contains CORRUPT. */
const FAKE_FFPROBE = `#!/bin/sh
if [ "$1" = "-hide_banner" ]; then echo "ffprobe version 9.9.9-fake"; exit 0; fi
for last; do :; done
if grep -q CORRUPT "$last" 2>/dev/null; then echo "Invalid data found when processing input" >&2; exit 1; fi
echo '{"format":{"format_name":"matroska,webm","duration":"2.000"},"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac"}]}'
`;

/**
 * Fake ffmpeg: writes its output file (the last argument). The derivative
 * role, which appears in the output file name, selects a failure mode:
 * fail-* exits 1, empty-* writes an empty file, missing-* writes nothing,
 * corrupt-* writes bytes the fake ffprobe rejects.
 */
const FAKE_FFMPEG = `#!/bin/sh
if [ "$1" = "-hide_banner" ]; then echo "ffmpeg version 9.9.9-fake"; exit 0; fi
for last; do :; done
case "$(basename "$last")" in
  .fail-*) echo "Conversion failed!" >&2; exit 1 ;;
  .empty-*) : > "$last" ;;
  .missing-*) ;;
  .corrupt-*) echo CORRUPT > "$last" ;;
  *) echo "derived from input" > "$last" ;;
esac
exit 0
`;

export interface Harness {
  readonly project: string;
  readonly obsOutput: string;
  obs: FakeObsServer;
  readonly tools: { readonly ffmpeg: string; readonly ffprobe: string };
}

export async function createHarness(prefix: string): Promise<Harness> {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  const obsOutput = path.join(project, "obs-recordings");
  await mkdir(obsOutput);
  const tools = { ffmpeg: path.join(project, "fake-ffmpeg"), ffprobe: path.join(project, "fake-ffprobe") };
  await writeFile(tools.ffmpeg, FAKE_FFMPEG);
  await writeFile(tools.ffprobe, FAKE_FFPROBE);
  await chmod(tools.ffmpeg, 0o755);
  await chmod(tools.ffprobe, 0o755);
  return { project, obsOutput, obs: undefined as unknown as FakeObsServer, tools };
}

export async function disposeHarness(harness: Harness): Promise<void> {
  await harness.obs?.close();
  await rm(harness.project, { recursive: true, force: true });
}

/** Start the fake OBS and write a project config that uses the simulator and fake media tools. */
export async function configure(harness: Harness, obsOptions: FakeObsOptions = {}, config: Record<string, unknown> = {}): Promise<void> {
  harness.obs = await FakeObsServer.start({
    recordDirectory: harness.obsOutput,
    scenes: ["Gameplay", "Capture"],
    masterBytes: Buffer.from("m".repeat(2048)),
    ...obsOptions,
  });
  await writeFile(
    path.join(harness.project, "cappy.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "sim", name: "Simulator Project" },
      game: { command: process.execPath, args: [simulatorBin] },
      adapter: { port: 0 },
      obs: { url: harness.obs.url, scene: "Capture" },
      tools: harness.tools,
      presets: { trailer: { scene: "Capture" } },
      timeouts: { connectMs: 5_000, readyMs: 5_000, obsMs: 1_000, processMs: 60_000 },
      ...config,
    }),
  );
}

export async function runCli(
  harness: Harness,
  args: string[],
  options: { sim?: Record<string, unknown>; interrupts?: () => Interrupts; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; result: Record<string, any> }> {
  let stdout = "";
  const code = await main([...args, "--json", "-C", harness.project], {
    cwd: repoRoot,
    env: { ...process.env, ...options.env, CAPPY_SIM_OPTIONS: JSON.stringify(options.sim ?? {}) },
    write: (text) => {
      stdout += text;
    },
    writeError: () => undefined,
    ...(options.interrupts === undefined ? {} : { listenForInterrupts: options.interrupts }),
  });
  return { code, result: JSON.parse(stdout) as Record<string, any> };
}
