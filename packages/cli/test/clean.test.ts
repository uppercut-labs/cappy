import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, newId } from "@uppercut-labs/cappy-internal-core";
import { SessionStore, acquireRunLock, main } from "@uppercut-labs/cappy-internal-cli";
import { ManagedWorkspace } from "@uppercut-labs/cappy-internal-workspace";
import { type Harness, configure, createHarness, disposeHarness, repoRoot, runCli } from "./support.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness("cappy-clean-");
  await configure(harness, {}, {
    presets: {
      trailer: { scene: "Capture" },
      broken: { scene: "Capture", derivatives: [{ kind: "mp4", role: "fail-mp4" }] },
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await disposeHarness(harness);
});

const root = (): string => path.join(harness.project, ".cappy");

async function workspace(): Promise<ManagedWorkspace> {
  const opened = await ManagedWorkspace.open({ projectDir: harness.project });
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  return opened.value;
}

async function registry(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root(), "cappy-workspace.json"), "utf8")) as Record<string, any>;
}

/** Every file under the managed root with its content hash, except run locks. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root(), relative), { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        files[`${child}/`] = "dir";
        await walk(child);
      } else if (!child.startsWith("cache/running/")) {
        files[child] = createHash("sha256").update(await readFile(path.join(root(), child))).digest("hex");
      }
    }
  };
  await walk("");
  return files;
}

async function capture(args: string[] = ["run", "boss_intro"]): Promise<Record<string, any>> {
  const { result } = await runCli(harness, args);
  return result;
}

async function recordSession(): Promise<string> {
  const { result } = await runCli(harness, ["record", "--duration", "0.2"]);
  return result["data"]["session"]["id"] as string;
}

/** A session written directly, for states a real command only leaves behind after a crash. */
async function writeSession(status: Session["status"], correlationId: string): Promise<string> {
  const id = newId("ses");
  const store = new SessionStore(await workspace());
  const saved = await store.save({
    schemaVersion: 1,
    id,
    projectId: "sim",
    origin: "freeform",
    startedAt: new Date().toISOString(),
    ...(status === "active" ? {} : { endedAt: new Date().toISOString() }),
    adapter: { name: "cappy-simulator", version: "1.0.0" },
    capabilities: ["freeform_recording"],
    status,
    correlationId,
  });
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }
  return id;
}

async function clean(args: string[]): Promise<{ code: number; result: Record<string, any> }> {
  return runCli(harness, ["clean", ...args]);
}

// Several tests make multiple simulator captures; allow for slow, heavily loaded hosts.
describe("cappy clean", { timeout: 30_000 }, () => {
  it("removes a scenario capture with the scenario session it created and retires its take", async () => {
    const first = await capture();
    const kept = await capture();
    const { captureId, sessionId } = first["data"];

    const { code, result } = await clean([captureId]);
    expect(code).toBe(0);
    const data = result["data"];
    expect(data["items"].map((item: { id: string; kind: string }) => [item.kind, item.id])).toEqual([
      ["capture", captureId],
      ["session", sessionId],
    ]);
    expect(data["removed"]).toEqual(expect.arrayContaining([`captures/${captureId}/master.mkv`, `captures/${captureId}/manifest.json`, `sessions/${sessionId}/session.json`]));
    expect(data["bytesFreed"]).toBe(data["items"].reduce((total: number, item: { bytes: number }) => total + item.bytes, 0));
    expect(data["bytesFreed"]).toBeGreaterThan(2048);
    expect(data["retiredTakes"]).toEqual([{ source: { kind: "scenario", scenarioId: "boss_intro", parameters: { difficulty: 2 } }, take: 1 }]);
    expect(existsSync(path.join(root(), "captures", captureId))).toBe(false);
    expect(existsSync(path.join(root(), "sessions", sessionId))).toBe(false);
    expect(existsSync(path.join(root(), "captures", kept["data"]["captureId"]))).toBe(true);
    const managed = Object.keys((await registry())["managed"]);
    expect(managed.some((key) => key.includes(captureId) || key.includes(sessionId))).toBe(false);

    // Take 1 is retired: explicit reuse is refused and numbering continues past the highest take.
    const reuse = await runCli(harness, ["run", "boss_intro", "--take", "1"]);
    expect(reuse.code).toBe(2);
    expect(reuse.result["error"]).toMatchObject({ code: "TAKE_EXISTS", details: { take: 1, retired: true } });
    await clean([kept["data"]["captureId"]]);
    expect((await capture())["data"]["take"]).toBe(3);
  });

  it("keeps a replayed session when its capture is cleaned, and warns when the session itself is cleaned", async () => {
    const sessionId = await recordSession();
    const replayed = await capture(["replay", sessionId]);
    const captureId = replayed["data"]["captureId"] as string;

    const cleanedCapture = await clean([captureId]);
    expect(cleanedCapture.result["data"]["items"].map((item: { id: string }) => item.id)).toEqual([captureId]);
    expect(existsSync(path.join(root(), "sessions", sessionId, "session.json"))).toBe(true);

    const again = await capture(["replay", sessionId]);
    expect(again["data"]["take"]).toBe(2);
    const cleanedSession = await clean([sessionId]);
    expect(cleanedSession.code).toBe(0);
    expect(cleanedSession.result["data"]["items"].map((item: { id: string }) => item.id)).toEqual([sessionId]);
    expect(cleanedSession.result["warnings"]).toEqual([expect.stringContaining(`replayed by ${again["data"]["captureId"]}`)]);
    expect(existsSync(path.join(root(), "captures", again["data"]["captureId"], "manifest.json"))).toBe(true);
  });

  it("selects failed, cancelled, interrupted, and orphaned items with --failed", async () => {
    const succeeded = (await capture())["data"];
    const failedRun = await runCli(harness, ["run", "boss_intro", "--preset", "broken"]);
    expect(failedRun.result["data"]["state"]).toBe("failed");
    const failedCapture = failedRun.result["data"]["captureId"] as string;
    const completed = await recordSession();
    const cancelled = await writeSession("cancelled", "op_gone");
    const orphaned = await writeSession("active", "op_crashed");
    const interrupted = `cap_${"0".repeat(8)}-0000-0000-0000-000000000000`;
    await mkdir(path.join(root(), "captures", interrupted));

    const { code, result } = await clean(["--failed"]);
    expect(code).toBe(0);
    const ids = result["data"]["items"].map((item: { id: string }) => item.id).sort();
    expect(ids).toEqual([failedCapture, interrupted, failedRun.result["data"]["sessionId"], cancelled, orphaned].sort());
    expect(existsSync(path.join(root(), "captures", interrupted))).toBe(false);
    expect(existsSync(path.join(root(), "captures", succeeded["captureId"]))).toBe(true);
    expect(existsSync(path.join(root(), "sessions", completed))).toBe(true);
    // Failed captures never consumed a take, so none is retired.
    expect(result["data"]["retiredTakes"]).toEqual([]);
  });

  it("selects only logs with --logs and every item with --all", async () => {
    const run = (await capture())["data"];
    const logs = await clean(["-l"]);
    expect(logs.result["data"]["items"]).toEqual([expect.objectContaining({ kind: "log", id: run["correlationId"] ?? expect.any(String) })]);
    expect(await readdir(path.join(root(), "logs"))).toEqual([]);
    expect(existsSync(path.join(root(), "captures", run["captureId"]))).toBe(true);

    await recordSession();
    const all = await clean(["-a"]);
    expect(all.code).toBe(0);
    expect(new Set(all.result["data"]["items"].map((item: { kind: string }) => item.kind))).toEqual(new Set(["capture", "session", "log"]));
    expect(await readdir(path.join(root(), "captures"))).toEqual([]);
    expect(await readdir(path.join(root(), "sessions"))).toEqual([]);
    expect(await readdir(path.join(root(), "logs"))).toEqual([]);
    expect(Object.keys((await registry())["managed"])).toEqual([]);
  });

  it("filters bulk selections by age with --older-than", async () => {
    const run = (await capture())["data"];
    const young = await clean(["--older-than", "7d"]);
    expect(young.result["data"]["items"]).toEqual([]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect((await clean(["-f", "-ot", "7d"])).result["data"]["items"]).toEqual([]);
    const old = await clean(["-ot", "7d"]);
    expect(old.result["data"]["items"].map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([run["captureId"], run["sessionId"]]),
    );
    expect(old.result["data"]["items"].some((item: { kind: string }) => item.kind === "log")).toBe(true);
  });

  it("rejects missing selectors, IDs with --older-than, and malformed ages with exit code 2", async () => {
    for (const args of [[], ["cap_x", "--older-than", "7d"], ["--older-than", "7x"], ["--older-than", "0d"], ["-ot", "-1d"]]) {
      const { code, result } = await clean(args);
      expect(code, args.join(" ")).toBe(2);
      expect(result["error"]["code"]).toBe("USAGE_INVALID");
    }
  });

  it("previews with --dry-run and changes nothing", async () => {
    const run = (await capture())["data"];
    await runCli(harness, ["run", "boss_intro", "--preset", "broken"]);
    await writeSession("active", "op_crashed");
    const before = await snapshot();

    const preview = await clean(["--all", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.result["data"]["dryRun"]).toBe(true);
    expect(preview.result["data"]["removed"].length).toBeGreaterThan(0);
    expect(preview.result["data"]["retiredTakes"]).toEqual([expect.objectContaining({ take: 1 })]);
    expect(await snapshot()).toEqual(before);

    const real = await clean(["--all"]);
    const { dryRun: _preview, ...previewed } = preview.result["data"];
    const { dryRun: _real, ...done } = real.result["data"];
    expect(done).toEqual(previewed);
    expect(existsSync(path.join(root(), "captures", run["captureId"]))).toBe(false);
  });

  it("never deletes modified, linked, unregistered, or referenced files, and exits 1 when anything is refused", async () => {
    const edited = (await capture())["data"];
    const linked = (await capture())["data"];
    const leftover = (await capture())["data"];
    const referenced = (await capture())["data"];

    await writeFile(path.join(root(), "captures", edited["captureId"], "manifest.json"), "{}\n");
    const victim = path.join(harness.project, "victim.bin");
    await writeFile(victim, "keep me");
    await unlink(path.join(root(), "captures", linked["captureId"], "master.mkv"));
    await symlink(victim, path.join(root(), "captures", linked["captureId"], "master.mkv"));
    const partial = `captures/${leftover["captureId"]}/.master.partial.mkv`;
    await writeFile(path.join(root(), partial), "partial");
    const external = path.join(root(), "captures", referenced["captureId"], "notes.txt");
    await writeFile(external, "mine");
    const ws = await workspace();
    expect((await ws.referenceFile(external, "external")).ok).toBe(true);

    const { code, result } = await clean([edited["captureId"], linked["captureId"], leftover["captureId"], referenced["captureId"], "cap_missing"]);
    expect(code).toBe(1);
    expect(result["error"]["code"]).toBe("CLEAN_INCOMPLETE");
    expect(result["data"]["refused"]).toEqual(
      expect.arrayContaining([
        { target: "cap_missing", reason: "not_found" },
        { target: `captures/${edited["captureId"]}/manifest.json`, reason: "modified_since_managed_write" },
        { target: `captures/${linked["captureId"]}/master.mkv`, reason: "symlink" },
      ]),
    );
    expect(result["data"]["kept"]).toEqual(
      expect.arrayContaining([
        { path: partial, reason: "not_managed" },
        { path: `captures/${referenced["captureId"]}/notes.txt`, reason: "not_managed" },
      ]),
    );
    expect(await readFile(victim, "utf8")).toBe("keep me");
    expect(await readFile(external, "utf8")).toBe("mine");
    expect(existsSync(path.join(root(), partial))).toBe(true);
    // Everything else selected was still removed.
    expect(existsSync(path.join(root(), "captures", edited["captureId"], "master.mkv"))).toBe(false);
    expect(existsSync(path.join(root(), "captures", leftover["captureId"], "manifest.json"))).toBe(false);
  });

  it("never walks or empties an item reached through a link or junction", async () => {
    const run = (await capture())["data"];
    const outside = path.join(harness.project, "elsewhere");
    await mkdir(outside);
    // The capture directory was moved to another disk and linked back.
    const moved = path.join(outside, "moved-capture");
    await rename(path.join(root(), "captures", run["captureId"]), moved);
    await mkdir(path.join(moved, "empty"));
    await symlink(moved, path.join(root(), "captures", run["captureId"]), "junction");

    const named = await clean([run["captureId"]]);
    expect(named.code).toBe(1);
    expect(named.result["data"]["refused"]).toEqual([{ target: run["captureId"], reason: "symlink" }]);
    expect((await readdir(moved)).sort()).toEqual(["empty", "manifest.json", "master.mkv"]);

    // A whole storage area linked elsewhere: nothing in it is touched, and only Cappy-shaped names are items.
    const area = path.join(outside, "comparisons");
    const shaped = `cmp_${"2".repeat(8)}-0000-0000-0000-000000000000`;
    await mkdir(path.join(area, shaped, "empty"), { recursive: true });
    await mkdir(path.join(area, "my-folder", "empty"), { recursive: true });
    await rm(path.join(root(), "comparisons"), { recursive: true });
    await symlink(area, path.join(root(), "comparisons"), "junction");
    await mkdir(path.join(root(), "captures", "notes", "empty"), { recursive: true });

    const bulk = await clean(["--failed"]);
    expect(bulk.result["data"]["refused"]).toEqual(expect.arrayContaining([{ target: shaped, reason: "symlink" }]));
    expect(bulk.result["data"]["items"].map((item: { id: string }) => item.id)).not.toContain("my-folder");
    expect(bulk.result["data"]["items"].map((item: { id: string }) => item.id)).not.toContain("notes");
    expect(await readdir(path.join(area, shaped))).toEqual(["empty"]);
    expect(await readdir(path.join(area, "my-folder"))).toEqual(["empty"]);
    expect(await readdir(path.join(root(), "captures", "notes"))).toEqual(["empty"]);
  });

  it("creates nothing on a dry run, even without a workspace", async () => {
    const fresh = path.join(harness.project, "fresh");
    await mkdir(fresh);
    await writeFile(path.join(fresh, "cappy.config.json"), await readFile(path.join(harness.project, "cappy.config.json"), "utf8"));
    const none = await runCli({ ...harness, project: fresh }, ["clean", "--all", "--dry-run"]);
    expect(none.code).toBe(0);
    expect(none.result["data"]["items"]).toEqual([]);
    expect(await readdir(fresh)).toEqual(["cappy.config.json"]);

    await capture();
    await rm(path.join(root(), "comparisons"), { recursive: true });
    const before = await snapshot();
    expect((await clean(["--all", "-dr"])).code).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("protects items a running command may still be writing", async () => {
    const ws = await workspace();
    const release = await acquireRunLock(ws, "op_live");
    try {
      const active = await writeSession("active", "op_live");
      // Any live command may be reconciling other active sessions, so they wait too.
      const otherActive = await writeSession("active", "op_other");
      const unfinished = `cap_${"1".repeat(8)}-0000-0000-0000-000000000000`;
      await mkdir(path.join(root(), "captures", unfinished));
      await ws.writeManaged("logs/op_live.jsonl", "{}\n", { role: "log" });

      const named = await clean([active]);
      expect(named.code).toBe(1);
      expect(named.result["data"]["refused"]).toEqual([{ target: active, reason: "in_progress" }]);

      const bulk = await clean(["--all"]);
      expect(bulk.code).toBe(0);
      expect(bulk.result["data"]["skipped"].map((entry: { id: string }) => entry.id).sort()).toEqual([active, otherActive, unfinished, "op_live"].sort());
      expect(bulk.result["warnings"]).toEqual(expect.arrayContaining([expect.stringContaining("skipped 4 item(s)")]));
      expect(existsSync(path.join(root(), "sessions", active, "session.json"))).toBe(true);
      expect(existsSync(path.join(root(), "captures", unfinished))).toBe(true);
      expect(existsSync(path.join(root(), "logs/op_live.jsonl"))).toBe(true);
    } finally {
      await release();
    }
  });

  it("upgrades a version 1 registry when it retires a take", async () => {
    const run = (await capture())["data"];
    const file = path.join(root(), "cappy-workspace.json");
    const v1 = await registry();
    delete v1["retiredTakes"];
    v1["schemaVersion"] = 1;
    await writeFile(file, JSON.stringify(v1));

    expect((await clean([run["captureId"]])).code).toBe(0);
    expect(await registry()).toMatchObject({ schemaVersion: 2, retiredTakes: { 'scenario:boss_intro:{"difficulty":2}': [1] } });
  });

  it("renders a human report", async () => {
    const run = (await capture())["data"];
    let stdout = "";
    const code = await main(["clean", run["captureId"], "-dr", "-C", harness.project], {
      cwd: repoRoot,
      env: process.env,
      write: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Would remove");
    expect(stdout).toContain("(dry run; nothing was changed)");
    expect(stdout).toMatch(new RegExp(`capture +${run["captureId"]}`));
    expect(stdout).toContain("Would retire take 1 of scenario boss_intro");
  });
});
