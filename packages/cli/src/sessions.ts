import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ReplayEnvelope,
  type Result,
  type Session,
  type TimelineEvent,
  cappyError,
  err,
  newId,
  ok,
  sessionSchema,
} from "@cappy/core";
import { MAX_INLINE_REPLAY_BYTES, type ReplayHandoff } from "@cappy/protocol";
import { type ManagedWorkspace, hashBytes, hashFile } from "@cappy/workspace";

const SESSION_ID = /^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION = "sessions";

/** Largest adapter replay file Cappy will copy into the managed workspace. */
export const MAX_REPLAY_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export function newSessionId(): string {
  return newId("ses");
}

function sessionDir(id: string): string {
  return `sessions/${id}`;
}

/**
 * Persists sessions under `sessions/<id>/` in the managed workspace:
 * `session.json` (metadata), `replay.bin` (the adapter's opaque payload), and
 * `timeline.json` (normalized events).
 */
export class SessionStore {
  constructor(private readonly workspace: ManagedWorkspace) {}

  /** Write or replace a session's metadata. */
  async save(session: Session): Promise<Result<Session>> {
    const validated = sessionSchema.safeParse(session);
    if (!validated.success) {
      return err(cappyError("SESSION_INVALID", `session ${session.id} failed validation`, OPERATION, { details: { reason: validated.error.message } }));
    }
    const target = `${sessionDir(session.id)}/session.json`;
    const written = await this.workspace.writeManaged(target, `${JSON.stringify(validated.data, null, 2)}\n`, {
      role: "session",
      replace: this.workspace.managed(target) !== undefined,
    });
    return written.ok ? ok(validated.data) : written;
  }

  async saveTimeline(id: string, events: readonly TimelineEvent[]): Promise<Result<string>> {
    const target = `${sessionDir(id)}/timeline.json`;
    const written = await this.workspace.writeManaged(target, `${JSON.stringify(events, null, 2)}\n`, { role: "timeline" });
    return written.ok ? ok(written.value.path) : written;
  }

  async load(id: string): Promise<Result<Session>> {
    if (!SESSION_ID.test(id)) {
      return err(cappyError("SESSION_NOT_FOUND", `"${id}" is not a session ID`, OPERATION, { retryable: false }));
    }
    const file = this.workspace.managed(`${sessionDir(id)}/session.json`);
    if (file === undefined) {
      return err(cappyError("SESSION_NOT_FOUND", `no session ${id} in ${this.workspace.root}`, OPERATION, { retryable: false }));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file.hostPath, "utf8"));
    } catch (cause) {
      return err(cappyError("SESSION_INVALID", `session ${id} metadata is unreadable`, OPERATION, { details: { cause: String(cause) } }));
    }
    const parsed = sessionSchema.safeParse(raw);
    return parsed.success
      ? ok(parsed.data)
      : err(cappyError("SESSION_INVALID", `session ${id} metadata is invalid`, OPERATION, { details: { reason: parsed.error.message } }));
  }

  /**
   * Store an adapter's replay payload without interpreting it. Inline
   * payloads are decoded from base64; file payloads are copied (never moved)
   * from the adapter's path. Both are verified against the declared SHA-256.
   */
  async storeReplay(id: string, handoff: ReplayHandoff, requiredCapabilities: readonly string[]): Promise<Result<ReplayEnvelope>> {
    const target = `${sessionDir(id)}/replay.bin`;
    let stored;
    if (handoff.kind === "inline") {
      const bytes = Buffer.from(handoff.data, "base64");
      if (hashBytes(bytes).sha256 !== handoff.sha256) {
        return err(invalidPayload("inline replay payload does not match its declared SHA-256"));
      }
      stored = await this.workspace.writeManaged(target, bytes, { role: "replay" });
    } else {
      // Adapter-supplied paths are untrusted: only a regular file, not a link,
      // within the size limit, and matching its declared digest is accepted.
      const source = path.resolve(handoff.path);
      const stats = await lstat(source).catch(() => undefined);
      if (!path.isAbsolute(handoff.path) || stats === undefined || !stats.isFile()) {
        return err(invalidPayload("replay payload file must be an absolute path to a regular file", { path: handoff.path }));
      }
      if (stats.size !== handoff.bytes || stats.size > MAX_REPLAY_FILE_BYTES) {
        return err(invalidPayload("replay payload file size does not match the handoff", { path: handoff.path }));
      }
      stored = await this.workspace.publishFile(source, target, { role: "replay" });
    }
    if (!stored.ok) {
      return stored;
    }
    if (stored.value.entry.sha256 !== handoff.sha256) {
      await this.workspace.remove([stored.value.path]);
      return err(invalidPayload("replay payload does not match its declared SHA-256"));
    }
    return ok({
      path: stored.value.path,
      bytes: stored.value.entry.bytes,
      sha256: stored.value.entry.sha256,
      ...(handoff.format === undefined ? {} : { format: handoff.format }),
      requiredCapabilities: [...requiredCapabilities],
    });
  }

  /**
   * Verify a stored replay payload and build the handoff that returns it to
   * the adapter: inline when small, otherwise a path inside the managed root.
   */
  async replayHandoff(session: Session): Promise<Result<ReplayHandoff>> {
    const envelope = session.replay;
    if (envelope === undefined) {
      return err(cappyError("SESSION_NOT_REPLAYABLE", `session ${session.id} has no replay payload`, OPERATION, { retryable: false }));
    }
    const file = this.workspace.managed(envelope.path);
    if (file === undefined) {
      return err(invalidPayload("replay payload is not a managed file in this workspace", { path: envelope.path }));
    }
    const digest = await hashFile(file.hostPath).catch(() => undefined);
    if (digest?.sha256 !== envelope.sha256 || digest.bytes !== envelope.bytes) {
      return err(invalidPayload("stored replay payload is missing or no longer matches its SHA-256", { path: envelope.path }));
    }
    const format = envelope.format === undefined ? {} : { format: envelope.format };
    if (envelope.bytes <= MAX_INLINE_REPLAY_BYTES) {
      const data = await readFile(file.hostPath);
      return ok({ kind: "inline", encoding: "base64", data: data.toString("base64"), sha256: envelope.sha256, ...format });
    }
    return ok({ kind: "file", path: file.hostPath, sha256: envelope.sha256, bytes: envelope.bytes, ...format });
  }
}

function invalidPayload(message: string, details?: Record<string, unknown>) {
  return cappyError("REPLAY_PAYLOAD_INVALID", message, OPERATION, { ...(details === undefined ? {} : { details }), retryable: false });
}

/**
 * Sessions left `active` by a command that is no longer running (for example
 * after a crash) are marked `failed`. Nothing is ever promoted to success.
 * Returns the IDs that were reconciled.
 */
export async function reconcileOrphanedSessions(store: SessionStore, workspace: ManagedWorkspace, live: ReadonlySet<string>): Promise<string[]> {
  const reconciled: string[] = [];
  for (const file of workspace.listManaged("sessions/").filter((entry) => entry.path.endsWith("/session.json"))) {
    const id = file.path.split("/")[1] ?? "";
    const loaded = await store.load(id);
    if (!loaded.ok || loaded.value.status !== "active" || live.has(loaded.value.correlationId)) {
      continue;
    }
    const saved = await store.save({ ...loaded.value, status: "failed", endedAt: new Date().toISOString() });
    if (saved.ok) {
      reconciled.push(id);
    }
  }
  return reconciled;
}

/**
 * Capabilities a stored replay needs from the adapter that plays it back:
 * `replay`, plus `deterministic_replay` when the recording adapter offered it.
 */
export function replayRequirements(recordingCapabilities: readonly string[]): string[] {
  return recordingCapabilities.includes("deterministic_replay") ? ["deterministic_replay", "replay"] : ["replay"];
}
