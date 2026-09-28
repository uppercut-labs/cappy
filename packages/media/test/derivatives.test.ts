import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DerivativeSpec, type TimelineEvent, parseConfig } from "@uppercut-labs/cappy-internal-core";
import { MAX_EVERY_OUTPUTS, expandDerivative, ffmpegArguments, resolveTiming, validateDerivatives } from "@uppercut-labs/cappy-internal-media";

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
    // The stretch of video ending at 2 s is read and its last frame kept: the frame at or before 2 s.
    expect(args).toEqual(expect.arrayContaining(["-n", "-ss", "1", "-t", "1.001", "-i", "/in/master file.mkv", "-vf", "scale=320:-2", "-update", "1"]));
    expect(args.at(-1)).toBe("/out/.thumb.partial.jpg");
    const first = ffmpegArguments({ kind: "still", role: "poster", required: true, options: { at: 0.25 } }, "/in.mkv", "/out.png");
    expect(first.slice(first.indexOf("-ss"), first.indexOf("-i"))).toEqual(["-ss", "0", "-t", "0.251"]);
  });
});

const event = (seq: number, type: string, t: number, payload?: unknown): TimelineEvent => ({
  id: `evt_${seq}`,
  source: type.endsWith("_STARTED") ? "cappy" : "adapter",
  seq,
  t,
  type,
  ...(payload === undefined ? {} : { payload }),
});

/** A capture timeline on the master clock, as the capture job builds it. */
const timeline: TimelineEvent[] = [
  event(0, "SCENARIO_STARTED", 200),
  event(1, "IMPACT", 900, { target: { kind: "minion" } }),
  event(2, "SPELL_CAST", 1000, { spell: "fireball", power: 3 }),
  event(3, "IMPACT", 1500, { target: { kind: "boss" } }),
  event(4, "SPELL_CAST", 2000, { spell: "frost", power: "3" }),
  event(5, "IMPACT", 3000, { target: { kind: "boss" } }),
];

const spec = (kind: DerivativeSpec["kind"], options: Record<string, unknown>, role = "shot"): DerivativeSpec => ({ kind, role, required: true, options });

describe("event anchors", () => {
  it("cuts a clip from an offset before one event to an offset after the next matching event", () => {
    const clip = spec("clip", { start: { event: "SPELL_CAST", offset: -0.5 }, end: { event: "IMPACT", offset: 1 } });
    const resolved = resolveTiming(clip, { timeline, masterDurationMs: 10_000 });
    // The IMPACT at 900 ms precedes the start event, so the first IMPACT at or after it is at 1500 ms.
    expect(resolved).toEqual({ ok: true, value: { window: { startMs: 500, endMs: 2500, startEventId: "evt_2", endEventId: "evt_3" }, warnings: [] } });
    const args = ffmpegArguments(clip, "/in.mkv", "/out.mp4", resolved.ok ? resolved.value : { warnings: [] });
    expect(args).toEqual(expect.arrayContaining(["-ss", "0.5", "-i", "/in.mkv", "-t", "2"]));
  });

  it("picks occurrences, the last match, and payload conditions by dotted path with strict equality", () => {
    const window = (options: Record<string, unknown>) => {
      const resolved = resolveTiming(spec("clip", { duration: 1, ...options }), { timeline });
      return resolved.ok ? resolved.value.window?.startEventId : resolved.error.code;
    };
    expect(window({ start: { event: "SPELL_CAST", occurrence: 2 } })).toBe("evt_4");
    expect(window({ start: { event: "IMPACT", occurrence: "last" } })).toBe("evt_5");
    expect(window({ start: { event: "IMPACT", where: { "target.kind": "boss" } } })).toBe("evt_3");
    expect(window({ start: { event: "SPELL_CAST", where: { power: 3 } } })).toBe("evt_2");
    expect(window({ start: { event: "SPELL_CAST", where: { power: "3" } } })).toBe("evt_4");
    expect(window({ start: { event: "SPELL_CAST", where: { spell: "fireball", power: 4 } } })).toBe("DERIVATIVE_ANCHOR_UNRESOLVED");
    expect(window({ start: { event: "IMPACT", where: { "target.kind.name": "boss" } } })).toBe("DERIVATIVE_ANCHOR_UNRESOLVED");
    expect(window({ start: { event: "SPELL_CAST", occurrence: 3 } })).toBe("DERIVATIVE_ANCHOR_UNRESOLVED");
    expect(window({ start: { event: "SCENARIO_STARTED" } })).toBe("evt_0");
  });

  it("resolves an end anchor after a numeric start and records numeric windows unchanged", () => {
    expect(resolveTiming(spec("clip", { start: 1.2, end: { event: "IMPACT" } }), { timeline })).toEqual({
      ok: true,
      value: { window: { startMs: 1200, endMs: 1500, endEventId: "evt_3" }, warnings: [] },
    });
    // Times given only in seconds are never clamped, as in V1.
    expect(resolveTiming(spec("clip", { start: 9, duration: 5 }), { timeline, masterDurationMs: 10_000 })).toEqual({
      ok: true,
      value: { window: { startMs: 9000, endMs: 14_000 }, warnings: [] },
    });
    expect(resolveTiming(spec("still", { at: 30 }), { timeline, masterDurationMs: 2000 })).toEqual({ ok: true, value: { at: { ms: 30_000 }, warnings: [] } });
  });

  it("clamps anchored windows and times to the master with a warning, and fails an empty window", () => {
    const early = resolveTiming(spec("clip", { start: { event: "SCENARIO_STARTED", offset: -1 }, end: { event: "IMPACT", occurrence: "last", offset: 2 } }), {
      timeline,
      masterDurationMs: 4000,
    });
    expect(early.ok && early.value.window).toEqual({ startMs: 0, endMs: 4000, startEventId: "evt_0", endEventId: "evt_5" });
    expect(early.ok && early.value.warnings).toEqual([expect.stringContaining("clamped")]);

    const empty = resolveTiming(spec("clip", { start: { event: "IMPACT", occurrence: "last", offset: 1 }, duration: 2 }), { timeline, masterDurationMs: 3500 });
    expect(empty).toMatchObject({ ok: false, error: { code: "DERIVATIVE_WINDOW_EMPTY" } });

    const still = resolveTiming(spec("still", { at: { event: "IMPACT", occurrence: "last", offset: 5 } }), { timeline, masterDurationMs: 4000 });
    expect(still).toEqual({ ok: true, value: { at: { ms: 4000, eventId: "evt_5" }, warnings: [expect.stringContaining("clamped")] } });
    const thumb = resolveTiming(spec("thumbnail", { at: { event: "SCENARIO_STARTED", offset: -1 } }), { timeline, masterDurationMs: 4000 });
    expect(thumb.ok && thumb.value.at).toEqual({ ms: 0, eventId: "evt_0" });
  });

  it("reports an unresolved anchor with the anchor that failed", () => {
    const resolved = resolveTiming(spec("thumbnail", { at: { event: "BOSS_DEFEATED" } }, "poster"), { timeline });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "DERIVATIVE_ANCHOR_UNRESOLVED", message: expect.stringContaining("BOSS_DEFEATED #1"), details: { role: "poster", at: { event: "BOSS_DEFEATED" } } },
    });
  });

  it("validates anchor syntax before any capture starts", () => {
    const problems = (options: Record<string, unknown>, kind: DerivativeSpec["kind"] = "clip") => {
      const result = validateDerivatives([spec(kind, options)]);
      return result.ok ? [] : (result.error.details?.["problems"] as string[]);
    };
    expect(problems({ start: { event: "SPELL_CAST" }, end: { event: "IMPACT" } })).toEqual([]);
    expect(problems({ start: { event: "1BAD" }, duration: 1 })).toEqual([expect.stringContaining("shot: start")]);
    expect(problems({ start: { event: "SPELL_CAST" }, duration: 1, end: 3 })).toEqual([expect.stringContaining("exactly one of duration or end")]);
    expect(problems({ start: { event: "SPELL_CAST" } })).toEqual([expect.stringContaining("exactly one of duration or end")]);
    expect(problems({ start: { event: "SPELL_CAST", where: { spell: { name: "fireball" } } }, duration: 1 })).not.toEqual([]);
    expect(problems({ start: { event: "SPELL_CAST", occurrence: 0 }, duration: 1 })).not.toEqual([]);
    expect(problems({ start: { event: "SPELL_CAST", colour: "red" }, duration: 1 })).not.toEqual([]);
    expect(problems({ start: 3, end: 2 })).toEqual([expect.stringContaining("end: must be after start")]);
    expect(problems({ at: { event: "IMPACT", offset: -0.1 } }, "still")).toEqual([]);
    expect(problems({ at: { event: "" } }, "thumbnail")).not.toEqual([]);
  });

  it("refuses to build FFmpeg arguments for anchors that were never resolved", () => {
    expect(() => ffmpegArguments(spec("still", { at: { event: "IMPACT" } }), "/in.mkv", "/out.png")).toThrow(/resolve its timing/);
  });
});

describe("every-match derivatives", () => {
  const bounces: TimelineEvent[] = [
    event(0, "SCENARIO_STARTED", 10),
    event(1, "BOUNCE", 400, { bounce: 1 }),
    event(2, "BOUNCE", 900, { bounce: 2 }),
    event(3, "SETTLED", 1000),
    event(4, "BOUNCE", 1200, { bounce: 3 }),
  ];

  it("expands one derivative into a numbered output per matching event, each paired with its own end", () => {
    const clip = spec("clip", { start: { event: "BOUNCE", occurrence: "every", offset: -0.2 }, end: { event: "BOUNCE", offset: 0.2 } }, "hop");
    const expanded = expandDerivative(clip, { timeline: bounces });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.value.warnings).toEqual([]);
    expect(expanded.value.derivatives.map((entry) => entry.role)).toEqual(["hop-1", "hop-2", "hop-3"]);
    const windows = expanded.value.derivatives.map((entry) => {
      const resolved = resolveTiming(entry, { timeline: bounces, masterDurationMs: 5000 });
      return resolved.ok ? resolved.value.window : undefined;
    });
    expect(windows).toEqual([
      { startMs: 200, endMs: 600, startEventId: "evt_1", endEventId: "evt_1" },
      { startMs: 700, endMs: 1100, startEventId: "evt_2", endEventId: "evt_2" },
      { startMs: 1000, endMs: 1400, startEventId: "evt_4", endEventId: "evt_4" },
    ]);
    // Each clip ends at the first qualifying event after its own start, not at a shared end.
    const toSettle = expandDerivative(spec("clip", { start: { event: "BOUNCE", occurrence: "every" }, end: { event: "SETTLED" } }, "fall"), { timeline: bounces });
    const ends = toSettle.ok ? toSettle.value.derivatives.map((entry) => resolveTiming(entry, { timeline: bounces })) : [];
    expect(ends.map((entry) => (entry.ok ? entry.value.window?.endEventId : entry.error.code))).toEqual(["evt_3", "evt_3", "DERIVATIVE_ANCHOR_UNRESOLVED"]);
  });

  it("filters with where, leaves ordinary derivatives alone, and fails when nothing matches", () => {
    const still = spec("still", { at: { event: "BOUNCE", occurrence: "every", where: { bounce: 2 } } }, "peak");
    const expanded = expandDerivative(still, { timeline: bounces });
    expect(expanded.ok && expanded.value.derivatives.map((entry) => [entry.role, (entry.options["at"] as { occurrence: number }).occurrence])).toEqual([["peak-1", 1]]);
    const resolved = expanded.ok ? resolveTiming(expanded.value.derivatives[0] as DerivativeSpec, { timeline: bounces }) : undefined;
    expect(resolved?.ok && resolved.value.at).toEqual({ ms: 900, eventId: "evt_2" });

    const plain = spec("thumbnail", { at: { event: "BOUNCE" } }, "thumb");
    expect(expandDerivative(plain, { timeline: bounces })).toEqual({ ok: true, value: { derivatives: [plain], warnings: [] } });
    expect(expandDerivative(spec("still", { at: { event: "BOSS", occurrence: "every" } }), { timeline: bounces })).toMatchObject({
      ok: false,
      error: { code: "DERIVATIVE_ANCHOR_UNRESOLVED", message: expect.stringContaining("BOSS every") },
    });
  });

  it(`caps the outputs at ${MAX_EVERY_OUTPUTS} and says how many matches were skipped`, () => {
    const many = Array.from({ length: 130 }, (_, index) => event(index, "COIN", index * 10));
    const expanded = expandDerivative(spec("still", { at: { event: "COIN", occurrence: "every" } }, "coin"), { timeline: many });
    expect(expanded.ok && expanded.value.derivatives).toHaveLength(MAX_EVERY_OUTPUTS);
    expect(expanded.ok && expanded.value.warnings).toEqual([expect.stringContaining("30 skipped")]);
  });

  it("allows every only on a clip's start and a still's or thumbnail's time, and rejects colliding roles", () => {
    const problems = (derivatives: DerivativeSpec[]) => {
      const result = validateDerivatives(derivatives);
      return result.ok ? [] : (result.error.details?.["problems"] as string[]);
    };
    expect(problems([spec("clip", { start: { event: "HIT", occurrence: "every" }, duration: 1 }, "hit")])).toEqual([]);
    expect(problems([spec("thumbnail", { at: { event: "HIT", occurrence: "every" } }, "hit")])).toEqual([]);
    expect(problems([spec("clip", { start: { event: "HIT" }, end: { event: "HIT", occurrence: "every" } }, "hit")])).toEqual([
      expect.stringContaining('occurrence "every" is allowed only on start'),
    ]);
    expect(problems([spec("clip", { start: { event: "HIT", occurrence: "every" }, end: 5 }, "hit")])).toEqual([expect.stringContaining("needs an end anchor or a duration")]);
    expect(problems([spec("still", { at: { event: "HIT", occurrence: "every" } }, "hit"), spec("still", { at: 1 }, "hit-2")])).toEqual([
      expect.stringContaining('hit-2: collides with the outputs of "hit"'),
    ]);
    expect(problems([spec("still", { at: { event: "HIT", occurrence: "every" } }, "hit"), spec("still", { at: 1 }, "hit-x")])).toEqual([]);
  });
});
