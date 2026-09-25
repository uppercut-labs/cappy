import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@cappy/core";
import { ffmpegArguments, validateDerivatives } from "@cappy/media";

describe("derivative options", () => {
  it("accepts every preset in the example configuration", async () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cappy.config.example.json");
    const config = parseConfig(JSON.parse(await readFile(file, "utf8")));
    if (!config.ok) throw new Error(config.error.message);
    for (const preset of Object.values(config.value.presets)) {
      expect(validateDerivatives(preset.derivatives)).toEqual({ ok: true, value: true });
    }
  });

  it("reports every invalid option", () => {
    const result = validateDerivatives([
      { kind: "clip", role: "a", required: true, options: { start: -1 } },
      { kind: "mp4", role: "b", required: true, options: { crf: 99, colour: "red" } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.["problems"]).toEqual(
      expect.arrayContaining([expect.stringContaining("a: start"), expect.stringContaining("a: duration"), expect.stringContaining("b: crf")]),
    );
  });

  it("builds shell-free FFmpeg arguments that never overwrite", () => {
    const args = ffmpegArguments({ kind: "thumbnail", role: "thumb", required: true, options: { at: 2, width: 320 } }, "/in/master file.mkv", "/out/.thumb.partial.jpg");
    expect(args).toEqual(expect.arrayContaining(["-n", "-ss", "2", "-i", "/in/master file.mkv", "-frames:v", "1", "-vf", "scale=320:-2"]));
    expect(args.at(-1)).toBe("/out/.thumb.partial.jpg");
  });
});
