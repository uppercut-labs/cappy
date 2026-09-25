import { z } from "zod";
import type { TimelineEvent } from "./domain.js";

/** How one adapter event type differs between two captures (SPEC 11.8). */
export const timelineDiffEntrySchema = z.strictObject({
  type: z.string().min(1),
  countA: z.int().nonnegative(),
  countB: z.int().nonnegative(),
  /** Occurrences paired by order: the n-th in A with the n-th in B. */
  matched: z.int().nonnegative(),
  /** Times, from A's aligned start, of A's occurrences that B lacks. */
  missingAtMs: z.array(z.number()),
  /** Times, from B's aligned start, of B's occurrences beyond A's count. */
  extraAtMs: z.array(z.number()),
  /** Mean of B's time minus A's over matched occurrences; null when none matched. */
  meanDriftMs: z.number().nullable(),
  /** The matched drift largest in magnitude, with its sign; null when none matched. */
  maxDriftMs: z.number().nullable(),
});
export type TimelineDiffEntry = z.output<typeof timelineDiffEntrySchema>;

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * Compare the adapter events of two capture timelines, with times measured
 * from each capture's aligned start. Events of a type are paired in order of
 * occurrence. Types are listed in order of first appearance in A, then B.
 */
export function diffTimelines(a: readonly TimelineEvent[], startA: number, b: readonly TimelineEvent[], startB: number): TimelineDiffEntry[] {
  const byType = (events: readonly TimelineEvent[], start: number): Map<string, number[]> => {
    const grouped = new Map<string, number[]>();
    for (const event of [...events].filter((entry) => entry.source === "adapter").sort((x, y) => x.t - y.t || x.seq - y.seq)) {
      grouped.set(event.type, [...(grouped.get(event.type) ?? []), round(event.t - start)]);
    }
    return grouped;
  };
  const inA = byType(a, startA);
  const inB = byType(b, startB);
  return [...new Set([...inA.keys(), ...inB.keys()])].map((type) => {
    const timesA = inA.get(type) ?? [];
    const timesB = inB.get(type) ?? [];
    const matched = Math.min(timesA.length, timesB.length);
    const drifts = timesA.slice(0, matched).map((time, index) => round((timesB[index] ?? time) - time));
    const largest = drifts.reduce<number | null>((max, drift) => (max === null || Math.abs(drift) > Math.abs(max) ? drift : max), null);
    return {
      type,
      countA: timesA.length,
      countB: timesB.length,
      matched,
      missingAtMs: timesA.slice(matched),
      extraAtMs: timesB.slice(matched),
      meanDriftMs: matched === 0 ? null : round(drifts.reduce((total, drift) => total + drift, 0) / matched),
      maxDriftMs: largest,
    };
  });
}
