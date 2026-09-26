import { z } from "zod";

/**
 * Capabilities this controller understands. Adapters may declare others;
 * unknown names are carried through so newer adapters never break an older
 * controller.
 */
export const KNOWN_CAPABILITIES = [
  "scenarios",
  "freeform_recording",
  "replay",
  "deterministic_replay",
  "seek",
  "snapshots",
  "alternate_cameras",
  "telemetry",
  "time_scale",
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

export const capabilityNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "capability names are lowercase snake_case");

export const capabilitySetSchema = z.array(capabilityNameSchema).transform((names) => [...new Set(names)].sort());

export type CapabilitySet = readonly string[];

export function isKnownCapability(name: string): name is KnownCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(name);
}

/** Required capabilities the adapter did not advertise, in request order. */
export function missingCapabilities(advertised: CapabilitySet, required: readonly string[]): string[] {
  const available = new Set(advertised);
  return required.filter((name) => !available.has(name));
}

/**
 * Capabilities a preset's presentation needs (SPEC 14): `timeScale` needs
 * `time_scale`, and `camera` needs `alternate_cameras`. Other keys are
 * adapter-defined and need nothing Cappy can check.
 */
export function presentationCapabilities(presentation: Readonly<Record<string, unknown>>): KnownCapability[] {
  return [
    ...("camera" in presentation ? (["alternate_cameras"] as const) : []),
    ...("timeScale" in presentation ? (["time_scale"] as const) : []),
  ];
}
