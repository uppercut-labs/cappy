import { type TimelineEvent, timelineEventSchema } from "@cappy/core";
import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A derivative time given relative to a timeline event (SPEC 13, "Event
 * anchors"): the `occurrence`-th event of type `event` whose payload matches
 * every `where` condition, plus `offset` seconds.
 */
export const eventAnchorSchema = z.strictObject({
  event: timelineEventSchema.shape.type,
  /** Seconds after the event; negative is before it. */
  offset: z.number().default(0),
  /** 1-based, or the last matching event. */
  occurrence: z.union([z.int().positive(), z.literal("last")]).default(1),
  /** Dot-separated payload paths, each compared with strict equality. */
  where: z.record(z.string().regex(/^[^.]+(\.[^.]+)*$/, "use a dot-separated payload path"), scalar).optional(),
});
export type EventAnchor = z.output<typeof eventAnchorSchema>;

/** Seconds from the start of the master, or an event anchor. */
export const derivativeTimeSchema = z.union([z.number().nonnegative(), eventAnchorSchema]);
export type DerivativeTime = z.output<typeof derivativeTimeSchema>;

function valueAt(payload: unknown, dottedPath: string): { found: boolean; value?: unknown } {
  let current: unknown = payload;
  for (const key of dottedPath.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

/** Whether an event's payload satisfies every `where` condition. */
export function matchesWhere(payload: unknown, where: EventAnchor["where"]): boolean {
  return Object.entries(where ?? {}).every(([key, expected]) => {
    const actual = valueAt(payload, key);
    return actual.found && actual.value === expected;
  });
}

/**
 * The event an anchor names: candidates are events of the anchor's type whose
 * payload matches `where`, at or after `notBeforeMs`, in timeline order.
 */
export function findAnchorEvent(timeline: readonly TimelineEvent[], anchor: EventAnchor, notBeforeMs = 0): TimelineEvent | undefined {
  const candidates = timeline
    .filter((event) => event.type === anchor.event && event.t >= notBeforeMs && matchesWhere(event.payload, anchor.where))
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
  return anchor.occurrence === "last" ? candidates.at(-1) : candidates[anchor.occurrence - 1];
}

/** A human description of an anchor, for errors and warnings. */
export function describeAnchor(anchor: EventAnchor): string {
  const where = Object.entries(anchor.where ?? {})
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  const occurrence = anchor.occurrence === "last" ? "last" : `#${anchor.occurrence}`;
  return `${anchor.event} ${occurrence}${where === "" ? "" : ` where ${where}`}`;
}
