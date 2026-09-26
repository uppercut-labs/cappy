import { adapterIdentitySchema, capabilitySetSchema, scenarioParametersSchema, scenarioSchema } from "@cappy/core";
import { z } from "zod";

/*
 * Cappy adapter protocol, version 1. Every message is one JSON object with a
 * `type` field. See docs/protocol.md for the adapter author's reference.
 */

/** Protocol major versions this controller implements. */
export const SUPPORTED_PROTOCOL = { min: 1, max: 1 } as const;

/** Largest accepted WebSocket message, in bytes. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Largest decoded inline replay payload. Larger payloads use file handoff. */
export const MAX_INLINE_REPLAY_BYTES = 1024 * 1024;

const opId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.int().min(1).max(1000);

/** How a replay payload travels between Cappy and an adapter. */
export const replayHandoffSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inline"),
    encoding: z.literal("base64"),
    data: z
      .string()
      .max(Math.ceil(MAX_INLINE_REPLAY_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, "expected base64"),
    sha256,
    format: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    /** Untrusted: an adapter-supplied path never grants deletion authority. */
    path: z.string().min(1).max(4096),
    sha256,
    bytes: z.int().nonnegative(),
    format: z.string().min(1).max(128).optional(),
  }),
]);
export type ReplayHandoff = z.output<typeof replayHandoffSchema>;

// ---------------------------------------------------------------------------
// Adapter -> Cappy

/**
 * The hello is sent before a version is negotiated, so unknown fields from a
 * newer adapter are dropped rather than rejected.
 */
export const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.strictObject({ min: version, max: version }).refine((range) => range.min <= range.max, "min must not exceed max"),
  /** The per-launch session token Cappy supplied through CAPPY_SESSION_TOKEN. */
  token: z.string().min(16).max(256),
  adapter: adapterIdentitySchema,
  game: z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(256).optional() }),
  build: z.string().min(1).max(256).optional(),
  capabilities: capabilitySetSchema,
});

export const adapterMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  z.strictObject({ type: z.literal("scenarios"), scenarios: z.array(scenarioSchema).max(1000) }),
  z.strictObject({ type: z.literal("ready"), op: opId }),
  z.strictObject({ type: z.literal("started"), op: opId }),
  z.strictObject({
    type: z.literal("event"),
    op: opId,
    /** Operation-relative monotonic milliseconds. */
    t: z.number().nonnegative(),
    event: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
    durationMs: z.number().nonnegative().optional(),
    payload: z.unknown().optional(),
  }),
  z.strictObject({
    type: z.literal("completed"),
    op: opId,
    result: z.record(z.string(), z.unknown()).optional(),
    replay: replayHandoffSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("failed"),
    op: opId,
    code: z.string().min(1).max(128),
    message: z.string().max(2000),
  }),
  z.strictObject({ type: z.literal("pong"), nonce: z.string().max(64) }),
]);
export type AdapterMessage = z.output<typeof adapterMessageSchema>;
export type HelloMessage = z.output<typeof helloSchema>;

// ---------------------------------------------------------------------------
// Cappy -> Adapter

export const controllerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("welcome"), protocol: version, controller: adapterIdentitySchema }),
  z.strictObject({ type: z.literal("reject"), code: z.string(), message: z.string() }),
  z.strictObject({ type: z.literal("list_scenarios") }),
  z.strictObject({
    type: z.literal("prepare_scenario"),
    op: opId,
    scenario: z.string().min(1),
    parameters: scenarioParametersSchema,
    presentation: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ type: z.literal("record_start"), op: opId }),
  z.strictObject({
    type: z.literal("prepare_replay"),
    op: opId,
    replay: replayHandoffSchema,
    presentation: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ type: z.literal("start"), op: opId }),
  z.strictObject({ type: z.literal("stop"), op: opId }),
  z.strictObject({ type: z.literal("cancel"), op: opId }),
  z.strictObject({ type: z.literal("ping"), nonce: z.string().max(64) }),
  z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string(), op: opId.optional() }),
]);
export type ControllerMessage = z.output<typeof controllerMessageSchema>;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function parseWith<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "message is not valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, message: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  return { ok: false, reason: `schema violation${where}: ${issue?.message ?? "invalid message"}` };
}

export function parseAdapterMessage(text: string): ParseResult<AdapterMessage> {
  return parseWith(adapterMessageSchema, text);
}

export function parseControllerMessage(text: string): ParseResult<ControllerMessage> {
  return parseWith(controllerMessageSchema, text);
}

/** Highest protocol version both sides support, or undefined if none. */
export function negotiateVersion(
  adapter: { min: number; max: number },
  controller: { min: number; max: number } = SUPPORTED_PROTOCOL,
): number | undefined {
  const high = Math.min(adapter.max, controller.max);
  const low = Math.max(adapter.min, controller.min);
  return high >= low ? high : undefined;
}
