import { describe, expect, it } from "vitest";
import { type TimelineEvent, diffTimelines } from "@cappy/core";

let seq = 0;
const event = (type: string, t: number, source: TimelineEvent["source"] = "adapter"): TimelineEvent => ({ id: `evt_${seq}`, source, seq: seq++, t, type });

describe("timeline diff", () => {
  it("pairs events of a type by occurrence, measured from each aligned start", () => {
    const a = [event("REPLAY_STARTED", 100, "cappy"), event("JUMP", 350), event("COIN", 500), event("JUMP", 800)];
    // B's first JUMP is 10 ms later relative to its start, its second on time, and its COIN 10 ms early.
    const b = [event("REPLAY_STARTED", 40, "cappy"), event("JUMP", 300), event("JUMP", 740), event("COIN", 430)];
    expect(diffTimelines(a, 100, b, 40)).toEqual([
      { type: "JUMP", countA: 2, countB: 2, matched: 2, missingAtMs: [], extraAtMs: [], meanDriftMs: 5, maxDriftMs: 10 },
      { type: "COIN", countA: 1, countB: 1, matched: 1, missingAtMs: [], extraAtMs: [], meanDriftMs: -10, maxDriftMs: -10 },
    ]);
  });

  it("reports missing and extra occurrences and types present in only one capture", () => {
    const a = [event("SPELL_CAST", 100), event("SPELL_CAST", 300), event("IMPACT", 400)];
    const b = [event("SPELL_CAST", 110), event("BOSS_DEFEATED", 900)];
    expect(diffTimelines(a, 0, b, 0)).toEqual([
      { type: "SPELL_CAST", countA: 2, countB: 1, matched: 1, missingAtMs: [300], extraAtMs: [], meanDriftMs: 10, maxDriftMs: 10 },
      { type: "IMPACT", countA: 1, countB: 0, matched: 0, missingAtMs: [400], extraAtMs: [], meanDriftMs: null, maxDriftMs: null },
      { type: "BOSS_DEFEATED", countA: 0, countB: 1, matched: 0, missingAtMs: [], extraAtMs: [900], meanDriftMs: null, maxDriftMs: null },
    ]);
  });

  it("keeps the sign of the largest drift and ignores Cappy lifecycle events", () => {
    const a = [event("HIT", 100), event("HIT", 200), event("HIT", 300), event("RECORDING_STARTED", 0, "cappy")];
    const b = [event("HIT", 105), event("HIT", 170), event("HIT", 320)];
    expect(diffTimelines(a, 0, b, 0)).toEqual([
      { type: "HIT", countA: 3, countB: 3, matched: 3, missingAtMs: [], extraAtMs: [], meanDriftMs: -1.667, maxDriftMs: -30 },
    ]);
    expect(diffTimelines([event("SCENARIO_STARTED", 0, "cappy")], 0, [], 0)).toEqual([]);
  });
});
