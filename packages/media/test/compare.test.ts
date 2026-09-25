import { describe, expect, it } from "vitest";
import { type FrameScore, comparisonArguments, parseFrameScores, selectWorstFrames, summarizeScores, worstFrameArguments } from "@cappy/media";

const frame = (n: number, ssim: number, fps = 10): FrameScore => ({ frame: n, tMs: ((n - 1) * 1000) / fps, ssim, psnr: 30 });

describe("worst-frame selection", () => {
  it("picks the three lowest-SSIM frames at least a second apart, lowest first", () => {
    // 10 fps over 4 s: a dip around 0.5 s, a deeper one at 2.0 s, and a shallow one at 3.5 s.
    const frames = Array.from({ length: 40 }, (_, index) => frame(index + 1, 0.99));
    const set = (n: number, ssim: number): void => {
      frames[n - 1] = frame(n, ssim);
    };
    set(6, 0.7);
    set(7, 0.6);
    set(8, 0.65);
    set(21, 0.4);
    set(22, 0.45);
    set(36, 0.9);
    expect(selectWorstFrames(frames)).toEqual([
      { rank: 1, tMs: 2000, ssim: 0.4 },
      { rank: 2, tMs: 600, ssim: 0.6 },
      { rank: 3, tMs: 3500, ssim: 0.9 },
    ]);
  });

  it("returns fewer frames when the span is too short for three a second apart", () => {
    const frames = [frame(1, 0.9), frame(2, 0.8), frame(3, 0.95)];
    expect(selectWorstFrames(frames)).toEqual([{ rank: 1, tMs: 100, ssim: 0.8 }]);
    expect(selectWorstFrames(Array.from({ length: 15 }, (_, index) => frame(index + 1, 1)))).toEqual([
      { rank: 1, tMs: 0, ssim: 1 },
      { rank: 2, tMs: 1000, ssim: 1 },
    ]);
  });
});

describe("comparison statistics", () => {
  it("parses FFmpeg's SSIM and PSNR logs, with inf as identical", () => {
    const ssim = "n:1 Y:1.000000 U:1.000000 V:1.000000 All:1.000000 (inf)\nn:2 Y:0.9 U:0.95 V:0.95 All:0.925000 (11.2)\n";
    const psnr = "n:1 mse_avg:0.00 psnr_avg:inf psnr_y:inf\nn:2 mse_avg:40.5 psnr_avg:32.05 psnr_y:31.2\n";
    const frames = parseFrameScores(ssim, psnr, 25);
    expect(frames).toEqual([
      { frame: 1, tMs: 0, ssim: 1, psnr: null },
      { frame: 2, tMs: 40, ssim: 0.925, psnr: 32.05 },
    ]);
    expect(summarizeScores(frames ?? [])).toEqual({ frames: 2, ssim: { mean: 0.9625, min: 0.925, minAtMs: 40 }, psnr: { mean: 32.05, min: 32.05 } });
    expect(parseFrameScores("", psnr, 25)).toBeUndefined();
    expect(parseFrameScores(ssim, "n:1 psnr_avg:inf\n", 25)).toBeUndefined();
  });

  it("scores identical spans as SSIM 1 with no finite PSNR", () => {
    expect(summarizeScores([frame(1, 1), frame(2, 1)].map((entry) => ({ ...entry, psnr: null })))).toEqual({
      frames: 2,
      ssim: { mean: 1, min: 1, minAtMs: 0 },
      psnr: { mean: null, min: null },
    });
  });

  it("builds shell-free FFmpeg arguments over the aligned span, normalizing B to A", () => {
    const a = { path: "/a/master one.mkv", startMs: 120.5 };
    const b = { path: "/b/master.mov", startMs: 80 };
    const normalization = { width: 1280, height: 720, frameRate: 30 };
    const args = comparisonArguments(a, b, 1500, normalization, { ssimLog: ".s.log", psnrLog: ".p.log", triptych: ".t.mp4" });
    expect(args).toEqual(expect.arrayContaining(["-n", "-ss", "0.1205", "-t", "1.5", "-i", "/a/master one.mkv", "-ss", "0.08", "-i", "/b/master.mov"]));
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("[1:v]fps=30,scale=1280:720");
    expect(graph).toContain("ssim=stats_file=.s.log");
    expect(graph).toContain("hstack=inputs=3");
    expect(args.at(-1)).toBe(".t.mp4");

    const still = worstFrameArguments(a, b, 1000, normalization, { a: "a.png", b: "b.png", diff: "d.png" });
    expect(still.filter((arg, index) => still[index - 1] === "-ss")).toEqual(["1.1205", "1.08"]);
    expect(still.filter((arg, index) => still[index - 2] === "-frames:v")).toEqual(["a.png", "b.png", "d.png"]);
  });
});
