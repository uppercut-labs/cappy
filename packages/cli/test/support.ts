import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Interrupts, main } from "@cappy/cli";
import { FakeObsServer, type FakeObsOptions } from "@cappy/fake-obs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const simulatorBin = path.join(repoRoot, "fixtures/adapter-simulator/dist/bin.js");

/**
 * Fake ffprobe: valid JSON for any file unless its content contains CORRUPT.
 * Content starting with SIZE:<w>x<h> reports that video size.
 */
const FAKE_FFPROBE = `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-hide_banner") { console.log("ffprobe version 9.9.9-fake"); process.exit(0); }
let text = "";
try { text = fs.readFileSync(args[args.length - 1], "utf8"); } catch {}
if (text.includes("CORRUPT")) { console.error("Invalid data found when processing input"); process.exit(1); }
const size = /^SIZE:(\\d+)x(\\d+)/.exec(text);
console.log(JSON.stringify({ format: { format_name: "matroska,webm", duration: "2.000" }, streams: [
  { codec_type: "video", codec_name: "h264", width: size ? Number(size[1]) : 1280, height: size ? Number(size[2]) : 720 },
  { codec_type: "audio", codec_name: "aac" } ] }));
`;

/**
 * Fake ffmpeg: writes its output file (the last argument). The derivative
 * role, which appears in the output file name, selects a failure mode:
 * fail-* exits 1, empty-* writes an empty file, missing-* writes nothing,
 * corrupt-* writes bytes the fake ffprobe rejects. Otherwise the output is
 * JSON recording the arguments, so tests can check seek times. A comparison
 * also writes SSIM/PSNR stats files: 1.0 throughout for identical inputs, a
 * dip at frame 2 otherwise, and a failure when the second input contains
 * FAILCMP. Worst-frame extraction writes each still, and fails when the
 * second input contains FAILSTILL.
 */
const FAKE_FFMPEG = `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-hide_banner") { console.log("ffmpeg version 9.9.9-fake"); process.exit(0); }
const output = args[args.length - 1];
const name = path.basename(output);
const graph = args[args.indexOf("-filter_complex") + 1] || "";
if (graph.includes("ssim=stats_file=")) {
  // A comparison: identical inputs score 1, different ones dip at frame 2.
  const inputs = args.flatMap((arg, i) => (arg === "-i" ? [fs.readFileSync(args[i + 1], "utf8")] : []));
  if (inputs[1].includes("FAILCMP")) { console.error("Comparison failed!"); process.exit(1); }
  const fps = Number(/fps=([0-9.]+)/.exec(graph)[1]);
  const frames = Math.max(3, Math.round(Number(args[args.indexOf("-t") + 1]) * fps));
  const same = inputs[0] === inputs[1];
  let ssim = "", psnr = "";
  for (let n = 1; n <= frames; n++) {
    const score = same ? 1 : n === 2 ? 0.5 : 0.99;
    ssim += "n:" + n + " Y:" + score + " U:" + score + " V:" + score + " All:" + score.toFixed(6) + " (" + (same ? "inf" : "20.0") + ")\\n";
    psnr += "n:" + n + " mse_avg:0.00 psnr_avg:" + (same ? "inf" : n === 2 ? "12.50" : "40.00") + " psnr_y:0\\n";
  }
  fs.writeFileSync(/ssim=stats_file=([^\\[]+)\\[/.exec(graph)[1], ssim);
  fs.writeFileSync(/psnr=stats_file=([^\\[]+)\\[/.exec(graph)[1], psnr);
  fs.writeFileSync(output, JSON.stringify({ derivedFrom: "comparison", args }) + "\\n");
  process.exit(0);
}
if (graph.includes("blend=all_mode=difference")) {
  // Worst-frame stills: every "-update 1 <file>" output.
  const inputs = args.flatMap((arg, i) => (arg === "-i" ? [fs.readFileSync(args[i + 1], "utf8")] : []));
  if (inputs[1].includes("FAILSTILL")) { console.error("Still extraction failed!"); process.exit(1); }
  args.forEach((arg, i) => { if (args[i - 2] === "-update") fs.writeFileSync(arg, JSON.stringify({ derivedFrom: "still", args }) + "\\n"); });
  process.exit(0);
}
if (name.startsWith(".fail-")) { console.error("Conversion failed!"); process.exit(1); }
if (name.startsWith(".empty-")) fs.writeFileSync(output, "");
else if (name.startsWith(".missing-")) {}
else if (name.startsWith(".corrupt-")) fs.writeFileSync(output, "CORRUPT\\n");
else fs.writeFileSync(output, JSON.stringify({ derivedFrom: "input", args }) + "\\n");
`;

/**
 * Write a fake media tool as a Node script plus an executable launcher:
 * a `.cmd` file on Windows (exercising Cappy's cmd.exe path) and a shell
 * script elsewhere. Returns the launcher path.
 */
export async function writeFakeTool(directory: string, tool: "ffmpeg" | "ffprobe"): Promise<string> {
  const script = path.join(directory, `fake-${tool}.cjs`);
  await writeFile(script, tool === "ffmpeg" ? FAKE_FFMPEG : FAKE_FFPROBE);
  if (process.platform === "win32") {
    const launcher = path.join(directory, `fake-${tool}.cmd`);
    await writeFile(launcher, `@"${process.execPath}" "${script}" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(directory, `fake-${tool}`);
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

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
  const tools = { ffmpeg: await writeFakeTool(project, "ffmpeg"), ffprobe: await writeFakeTool(project, "ffprobe") };
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
