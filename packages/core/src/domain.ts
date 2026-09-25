import { randomUUID } from "node:crypto";
import { z } from "zod";
import { capabilitySetSchema } from "./capabilities.js";

/*
 * Engine-neutral domain contracts. Vocabulary follows Context.md: Project,
 * Scenario, Session, Replay, Capture Job, Take, Timeline Event, Master,
 * Derivative, Artifact Manifest, and Managed Artifact.
 */

const nonEmpty = z.string().min(1);
const isoTimestamp = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase hex SHA-256 digest");

export function newId(prefix: "ses" | "cap" | "evt" | "job"): string {
  return `${prefix}_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Project and adapter identity

export interface Project {
  readonly id: string;
  readonly name: string;
  /** Absolute project directory containing `cappy.config.json`. */
  readonly rootDir: string;
}

export const adapterIdentitySchema = z.strictObject({
  name: nonEmpty,
  version: nonEmpty,
});
export type AdapterIdentity = z.output<typeof adapterIdentitySchema>;

// ---------------------------------------------------------------------------
// Scenario

export const PARAMETER_TYPES = ["string", "number", "integer", "boolean"] as const;

export const scenarioParameterSchema = z.strictObject({
  type: z.enum(PARAMETER_TYPES),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  enum: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/, "scenario IDs are stable lowercase identifiers"),
  name: nonEmpty,
  parameters: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), scenarioParameterSchema).default({}),
  requiredCapabilities: capabilitySetSchema.default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Scenario = z.output<typeof scenarioSchema>;

export const scenarioParametersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type ScenarioParameters = z.output<typeof scenarioParametersSchema>;

// ---------------------------------------------------------------------------
// Timeline Event

export const timelineEventSchema = z.strictObject({
  id: nonEmpty,
  /** `cappy` for controller lifecycle events, `adapter` for game events. */
  source: z.enum(["cappy", "adapter"]),
  /** Receipt order assigned by Cappy. */
  seq: z.int().nonnegative(),
  /** Session-relative monotonic milliseconds. */
  t: z.number().nonnegative(),
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
  durationMs: z.number().nonnegative().optional(),
  payload: z.unknown().optional(),
  correlationId: nonEmpty.optional(),
});
export type TimelineEvent = z.output<typeof timelineEventSchema>;

// ---------------------------------------------------------------------------
// Session and Replay

export const SESSION_STATUSES = ["active", "completed", "failed", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Cappy-owned envelope around an adapter-owned, opaque replay payload. */
export const replayEnvelopeSchema = z.strictObject({
  /** Payload location relative to the managed root. */
  path: nonEmpty,
  bytes: z.int().nonnegative(),
  sha256: sha256Schema,
  /** Adapter-declared format label; Cappy never interprets the payload. */
  format: nonEmpty.optional(),
  requiredCapabilities: capabilitySetSchema.default([]),
});
export type ReplayEnvelope = z.output<typeof replayEnvelopeSchema>;

export const sessionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: nonEmpty,
    projectId: nonEmpty,
    origin: z.enum(["scenario", "freeform"]),
    scenario: z.strictObject({ id: nonEmpty, parameters: scenarioParametersSchema.default({}) }).optional(),
    startedAt: isoTimestamp,
    endedAt: isoTimestamp.optional(),
    adapter: adapterIdentitySchema,
    gameBuild: nonEmpty.optional(),
    capabilities: capabilitySetSchema,
    replay: replayEnvelopeSchema.optional(),
    status: z.enum(SESSION_STATUSES),
    correlationId: nonEmpty,
  })
  .superRefine((session, ctx) => {
    if (session.origin === "scenario" && session.scenario === undefined) {
      ctx.addIssue({ code: "custom", path: ["scenario"], message: "scenario sessions must identify their scenario" });
    }
    if (session.origin === "freeform" && session.scenario !== undefined) {
      ctx.addIssue({ code: "custom", path: ["scenario"], message: "freeform sessions have no scenario" });
    }
    if (session.status !== "active" && session.endedAt === undefined) {
      ctx.addIssue({ code: "custom", path: ["endedAt"], message: "finished sessions must record endedAt" });
    }
  });
export type Session = z.output<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// Capture Job

export const CAPTURE_JOB_STATES = [
  "created",
  "preflighting",
  "preparing_game",
  "ready",
  "recording",
  "finalizing",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type CaptureJobState = (typeof CAPTURE_JOB_STATES)[number];

const FORWARD: Readonly<Partial<Record<CaptureJobState, CaptureJobState>>> = {
  created: "preflighting",
  preflighting: "preparing_game",
  preparing_game: "ready",
  ready: "recording",
  recording: "finalizing",
  finalizing: "processing",
  processing: "succeeded",
};

export const TERMINAL_JOB_STATES: readonly CaptureJobState[] = ["succeeded", "failed", "cancelled"];

/**
 * States a user may cancel from. Once recording has stopped (`finalizing`,
 * `processing`) the job runs to success or failure so a verified master is
 * never abandoned half-processed.
 */
export const CANCELLABLE_JOB_STATES: readonly CaptureJobState[] = [
  "created",
  "preflighting",
  "preparing_game",
  "ready",
  "recording",
];

export function isTerminalJobState(state: CaptureJobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export function canTransition(from: CaptureJobState, to: CaptureJobState): boolean {
  if (isTerminalJobState(from)) {
    return false;
  }
  if (to === "failed") {
    return true;
  }
  if (to === "cancelled") {
    return CANCELLABLE_JOB_STATES.includes(from);
  }
  return FORWARD[from] === to;
}

export const captureSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scenario"), scenarioId: nonEmpty, parameters: scenarioParametersSchema.default({}) }),
  z.strictObject({ kind: z.literal("replay"), sessionId: nonEmpty }),
]);
export type CaptureSource = z.output<typeof captureSourceSchema>;

export const captureJobSchema = z.strictObject({
  id: nonEmpty,
  correlationId: nonEmpty,
  projectId: nonEmpty,
  source: captureSourceSchema,
  preset: nonEmpty,
  take: z.int().positive(),
  state: z.enum(CAPTURE_JOB_STATES),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type CaptureJob = z.output<typeof captureJobSchema>;

// ---------------------------------------------------------------------------
// Artifact

export const OWNERSHIP_CLASSES = ["managed", "imported", "external"] as const;
export type Ownership = (typeof OWNERSHIP_CLASSES)[number];

export const artifactSchema = z.strictObject({
  /** For example `master`, `replay`, `timeline`, or a derivative role. */
  role: nonEmpty,
  /** Relative to the managed root where possible. */
  path: nonEmpty,
  ownership: z.enum(OWNERSHIP_CLASSES),
  mediaType: nonEmpty,
  bytes: z.int().nonnegative(),
  sha256: sha256Schema,
  source: z.strictObject({ tool: nonEmpty, version: nonEmpty.optional() }),
  durationMs: z.number().nonnegative().optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  /** A clip's resolved window on the master, with the anchoring events' IDs. */
  window: z
    .strictObject({
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
      startEventId: nonEmpty.optional(),
      endEventId: nonEmpty.optional(),
    })
    .optional(),
  /** A still's or thumbnail's resolved frame time on the master, with the anchoring event's ID. */
  at: z.strictObject({ ms: z.number().nonnegative(), eventId: nonEmpty.optional() }).optional(),
});
export type Artifact = z.output<typeof artifactSchema>;

// ---------------------------------------------------------------------------
// Artifact Manifest

export const MANIFEST_SCHEMA_VERSION = 1;

const toolVersionSchema = z.strictObject({ version: nonEmpty }).catchall(z.unknown());

export const verificationCheckSchema = z.strictObject({
  name: nonEmpty,
  passed: z.boolean(),
  detail: z.string().optional(),
});

export const manifestSchema = z
  .strictObject({
    manifestVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    identity: z.strictObject({
      captureId: nonEmpty,
      sessionId: nonEmpty,
      take: z.int().positive(),
      project: z.strictObject({ id: nonEmpty, name: nonEmpty }),
      source: captureSourceSchema,
      correlationId: nonEmpty,
    }),
    build: z.strictObject({
      cappyVersion: nonEmpty,
      adapter: adapterIdentitySchema,
      gameBuild: nonEmpty.optional(),
      protocolVersion: nonEmpty,
      capabilities: capabilitySetSchema,
    }),
    timing: z.strictObject({
      startedAt: isoTimestamp,
      endedAt: isoTimestamp,
      monotonic: z.strictObject({ startMs: z.number(), endMs: z.number() }).optional(),
      /**
       * How timeline times map onto the master. Times are milliseconds from
       * the moment OBS confirmed recording; adapter events are shifted by
       * `adapterOffsetMs`. The true start lies up to `uncertaintyMs` earlier.
       */
      sync: z
        .strictObject({
          reference: z.literal("obs_recording_confirmed"),
          adapterOffsetMs: z.number().nonnegative(),
          uncertaintyMs: z.number().nonnegative(),
        })
        .optional(),
      timeline: z.union([z.array(timelineEventSchema), z.strictObject({ path: nonEmpty, sha256: sha256Schema })]),
    }),
    tooling: z.strictObject({
      obs: toolVersionSchema.optional(),
      ffmpeg: toolVersionSchema.optional(),
      ffprobe: toolVersionSchema.optional(),
      preset: z.strictObject({ name: nonEmpty, fingerprint: sha256Schema }),
    }),
    artifacts: z.array(artifactSchema),
    result: z.strictObject({
      warnings: z.array(z.string()).default([]),
      checks: z.array(verificationCheckSchema),
      error: z.strictObject({ code: nonEmpty, message: nonEmpty }).optional(),
    }),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.status !== "succeeded") {
      if (manifest.result.error === undefined) {
        ctx.addIssue({ code: "custom", path: ["result", "error"], message: "non-successful manifests must record their error" });
      }
      return;
    }
    // A successful manifest must be unambiguous evidence.
    if (manifest.result.error !== undefined) {
      ctx.addIssue({ code: "custom", path: ["result", "error"], message: "successful manifests cannot carry an error" });
    }
    if (manifest.result.checks.length === 0 || manifest.result.checks.some((check) => !check.passed)) {
      ctx.addIssue({ code: "custom", path: ["result", "checks"], message: "successful manifests require every check to pass" });
    }
    if (!manifest.artifacts.some((artifact) => artifact.role === "master")) {
      ctx.addIssue({ code: "custom", path: ["artifacts"], message: "successful manifests require a master artifact" });
    }
  });
export type ArtifactManifest = z.output<typeof manifestSchema>;
