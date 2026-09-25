import { describe, expect, it } from "vitest";
import {
  type ArtifactManifest,
  CAPTURE_JOB_STATES,
  artifactSchema,
  canTransition,
  capabilitySetSchema,
  captureJobSchema,
  isKnownCapability,
  manifestSchema,
  missingCapabilities,
  scenarioSchema,
  sessionSchema,
  timelineEventSchema,
} from "@cappy/core";

const sha = "a".repeat(64);
const now = "2026-09-25T12:00:00.000-05:00";

describe("capabilities", () => {
  it("keeps unknown future capabilities instead of rejecting them", () => {
    const parsed = capabilitySetSchema.parse(["replay", "time_travel", "replay"]);
    expect(parsed).toEqual(["replay", "time_travel"]);
    expect(isKnownCapability("time_travel")).toBe(false);
    expect(isKnownCapability("seek")).toBe(true);
  });

  it("reports missing required capabilities", () => {
    expect(missingCapabilities(["scenarios", "replay"], ["replay", "seek", "alternate_cameras"])).toEqual([
      "seek",
      "alternate_cameras",
    ]);
  });

  it("rejects malformed capability names", () => {
    expect(capabilitySetSchema.safeParse(["Not Valid"]).success).toBe(false);
  });
});

describe("scenario", () => {
  it("validates parameter schemas", () => {
    const scenario = scenarioSchema.parse({
      id: "boss_intro",
      name: "Boss intro",
      parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 } },
      requiredCapabilities: ["scenarios"],
    });
    expect(scenario.parameters["difficulty"]?.required).toBe(false);
    expect(scenarioSchema.safeParse({ id: "x", name: "X", parameters: { p: { type: "vector" } } }).success).toBe(false);
  });
});

describe("session", () => {
  const base = {
    schemaVersion: 1,
    id: "ses_1",
    projectId: "demo",
    startedAt: now,
    adapter: { name: "simulator", version: "0.1.0" },
    capabilities: ["freeform_recording", "replay"],
    status: "active",
    correlationId: "op_1",
  };

  it("accepts a freeform session with an opaque replay envelope", () => {
    const session = sessionSchema.parse({
      ...base,
      origin: "freeform",
      status: "completed",
      endedAt: now,
      replay: { path: "sessions/ses_1/replay.bin", bytes: 12, sha256: sha, format: "sim-inputs-v1" },
    });
    expect(session.replay?.requiredCapabilities).toEqual([]);
  });

  it("requires scenario identity for scenario sessions", () => {
    expect(sessionSchema.safeParse({ ...base, origin: "scenario" }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...base, origin: "scenario", scenario: { id: "boss_intro" } }).success).toBe(true);
  });

  it("requires finished sessions to record their end", () => {
    expect(sessionSchema.safeParse({ ...base, origin: "freeform", status: "cancelled" }).success).toBe(false);
  });
});

describe("timeline event", () => {
  it("accepts adapter semantic events and rejects negative timestamps", () => {
    const event = { id: "evt_1", source: "adapter", seq: 0, t: 12.5, type: "SPELL_CAST", payload: { power: 3 } };
    expect(timelineEventSchema.parse(event).type).toBe("SPELL_CAST");
    expect(timelineEventSchema.safeParse({ ...event, t: -1 }).success).toBe(false);
  });
});

describe("capture job state machine", () => {
  it("advances only along the declared forward path", () => {
    const forward = ["created", "preflighting", "preparing_game", "ready", "recording", "finalizing", "processing", "succeeded"] as const;
    forward.slice(1).forEach((to, index) => {
      expect(canTransition(forward[index] ?? "created", to)).toBe(true);
    });
    expect(canTransition("created", "recording")).toBe(false);
    expect(canTransition("recording", "succeeded")).toBe(false);
  });

  it("allows failure from any active state and nothing after a terminal state", () => {
    for (const state of CAPTURE_JOB_STATES) {
      const terminal = state === "succeeded" || state === "failed" || state === "cancelled";
      expect(canTransition(state, "failed")).toBe(!terminal);
      expect(canTransition(state, "preflighting")).toBe(state === "created");
    }
  });

  it("allows cancellation only before recording has stopped", () => {
    expect(canTransition("recording", "cancelled")).toBe(true);
    expect(canTransition("finalizing", "cancelled")).toBe(false);
    expect(canTransition("processing", "cancelled")).toBe(false);
    expect(canTransition("succeeded", "cancelled")).toBe(false);
  });

  it("validates capture job records", () => {
    const job = {
      id: "job_1",
      correlationId: "op_1",
      projectId: "demo",
      source: { kind: "scenario", scenarioId: "boss_intro" },
      preset: "trailer",
      take: 1,
      state: "created",
      createdAt: now,
      updatedAt: now,
    };
    expect(captureJobSchema.parse(job).source).toEqual({ kind: "scenario", scenarioId: "boss_intro", parameters: {} });
    expect(captureJobSchema.safeParse({ ...job, take: 0 }).success).toBe(false);
  });
});

describe("artifact", () => {
  it("requires ownership, size, and a SHA-256 digest", () => {
    const artifact = {
      role: "master",
      path: "captures/cap_1/master.mkv",
      ownership: "managed",
      mediaType: "video/x-matroska",
      bytes: 1024,
      sha256: sha,
      source: { tool: "obs", version: "31.0.0" },
    };
    expect(artifactSchema.parse(artifact).ownership).toBe("managed");
    expect(artifactSchema.safeParse({ ...artifact, ownership: "borrowed" }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...artifact, sha256: "ABC" }).success).toBe(false);
  });
});

describe("manifest", () => {
  const successful: ArtifactManifest = {
    manifestVersion: 1,
    status: "succeeded",
    identity: {
      captureId: "cap_1",
      sessionId: "ses_1",
      take: 1,
      project: { id: "demo", name: "Demo" },
      source: { kind: "scenario", scenarioId: "boss_intro", parameters: {} },
      correlationId: "op_1",
    },
    build: {
      cappyVersion: "0.1.0",
      adapter: { name: "simulator", version: "0.1.0" },
      protocolVersion: "1.0",
      capabilities: ["scenarios"],
    },
    timing: { startedAt: now, endedAt: now, timeline: [] },
    tooling: { obs: { version: "31.0.0" }, preset: { name: "trailer", fingerprint: sha } },
    artifacts: [
      {
        role: "master",
        path: "captures/cap_1/master.mkv",
        ownership: "managed",
        mediaType: "video/x-matroska",
        bytes: 1,
        sha256: sha,
        source: { tool: "obs" },
      },
    ],
    result: { warnings: [], checks: [{ name: "master.probe", passed: true }] },
  };

  it("accepts a fully verified successful manifest", () => {
    expect(manifestSchema.safeParse(successful).success).toBe(true);
  });

  it("cannot mark a capture successful with a failed check, missing master, or error", () => {
    const failedCheck = { ...successful, result: { warnings: [], checks: [{ name: "master.probe", passed: false }] } };
    const noMaster = { ...successful, artifacts: [] };
    const withError = { ...successful, result: { ...successful.result, error: { code: "X", message: "boom" } } };
    const noChecks = { ...successful, result: { warnings: [], checks: [] } };
    for (const manifest of [failedCheck, noMaster, withError, noChecks]) {
      expect(manifestSchema.safeParse(manifest).success).toBe(false);
    }
  });

  it("requires failed and cancelled manifests to record their error", () => {
    const failed = { ...successful, status: "failed", artifacts: [] };
    expect(manifestSchema.safeParse(failed).success).toBe(false);
    expect(manifestSchema.safeParse({ ...failed, result: { ...failed.result, error: { code: "OBS_START_FAILED", message: "no" } } }).success).toBe(
      true,
    );
  });
});
