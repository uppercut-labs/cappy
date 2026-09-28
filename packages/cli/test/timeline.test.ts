import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "@uppercut-labs/cappy-internal-cli";
import { type Harness, configure, createHarness, disposeHarness, repoRoot, runCli } from "./support.js";

let harness: Harness;

/** A scenario whose payloads need quoting in CSV and escaping in WebVTT. */
const AWKWARD = {
  id: "notes",
  name: "Notes",
  events: [
    { event: "NOTE", t: 100, payload: { text: 'a, "quoted"\nline', level: 2 } },
    { event: "MARK", t: 2500, durationMs: 1800, payload: { tag: "<b>&" } },
  ],
};

beforeEach(async () => {
  harness = await createHarness("cappy-timeline-");
  await configure(harness);
});

afterEach(async () => {
  await disposeHarness(harness);
});

async function exportOf(args: string[]): Promise<{ code: number; result: Record<string, any> }> {
  return runCli(harness, ["timeline", "export", ...args]);
}

async function schema(name: string): Promise<object> {
  return JSON.parse(await readFile(path.join(repoRoot, "docs/schemas", name), "utf8")) as object;
}

describe("cappy timeline export", () => {
  it("exports a capture's timeline on the master clock as JSON that matches the published schema", async () => {
    const run = (await runCli(harness, ["run", "boss_intro"])).result["data"];
    const manifest = JSON.parse(await readFile(path.join(harness.project, ".cappy", run["manifest"]), "utf8")) as Record<string, any>;
    const { code, result } = await exportOf([run["captureId"]]);
    expect(code).toBe(0);
    expect(result["data"]).toMatchObject({ format: "json", source: { kind: "capture", id: run["captureId"] }, events: manifest["timing"]["timeline"].length });
    const exported = JSON.parse(result["data"]["content"]) as Record<string, any>;
    expect(exported).toEqual({
      timelineExportVersion: 1,
      source: { kind: "capture", id: run["captureId"] },
      clock: "master",
      sync: manifest["timing"]["sync"],
      events: manifest["timing"]["timeline"],
    });
    const validate = new Ajv({ allErrors: true }).compile(await schema("timeline-export.schema.json"));
    expect(validate(exported), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...exported, clock: "wall" })).toBe(false);
  });

  it("exports a freeform session's timeline on the session clock", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const stored = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", sessionId, "timeline.json"), "utf8")) as unknown[];
    const exported = JSON.parse((await exportOf([sessionId])).result["data"]["content"]) as Record<string, any>;
    expect(exported).toEqual({ timelineExportVersion: 1, source: { kind: "session", id: sessionId }, clock: "session", events: stored });
  });

  it("writes CSV with RFC 4180 quoting and WebVTT cues a player can show", async () => {
    const run = (await runCli(harness, ["run", "notes"], { sim: { scenarios: [AWKWARD] } })).result["data"];
    const csv = (await exportOf([run["captureId"], "-fo", "csv"])).result["data"]["content"] as string;
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("seq,t_ms,type,source,duration_ms,id,payload");
    expect(csv).toContain(`,NOTE,adapter,,`);
    expect(csv).toContain(`"{""text"":""a, \\""quoted\\""\\nline"",""level"":2}"`);
    expect(csv.endsWith("\r\n")).toBe(true);

    const vtt = (await exportOf([run["captureId"], "--format", "vtt"])).result["data"]["content"] as string;
    const [header, ...cues] = vtt.trimEnd().split("\n\n");
    expect(header).toBe("WEBVTT");
    expect(cues).toHaveLength(run["events"].length + 4);
    for (const cue of cues) {
      const [id, timing, text] = cue.split("\n");
      expect(id).toMatch(/^evt_/);
      const match = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})$/.exec(timing ?? "");
      expect(match, timing).not.toBeNull();
      const [, ...parts] = (match as RegExpExecArray).map(Number);
      const ms = (h = 0, m = 0, s = 0, f = 0) => ((h * 60 + m) * 60 + s) * 1000 + f;
      expect(ms(...parts.slice(4, 8)) - ms(...parts.slice(0, 4))).toBeGreaterThanOrEqual(999);
      expect(text).not.toContain("-->");
    }
    expect(vtt).toMatch(/\nNOTE text=a, "quoted" line level=2\n/);
    expect(vtt).toContain("MARK tag=&lt;b&gt;&amp;");
  });

  it("writes a new file with --out, never overwriting, and never manages it", async () => {
    const run = (await runCli(harness, ["run", "boss_intro"])).result["data"];
    const registryBefore = await readFile(path.join(harness.project, ".cappy/cappy-workspace.json"), "utf8");
    const written = await exportOf([run["captureId"], "-fo", "vtt", "-o", "events.vtt"]);
    expect(written.code).toBe(0);
    expect(written.result["data"]).toMatchObject({ format: "vtt", path: path.join(harness.project, "events.vtt") });
    expect(written.result["data"]["content"]).toBeUndefined();
    expect((await readFile(path.join(harness.project, "events.vtt"), "utf8")).startsWith("WEBVTT")).toBe(true);
    expect(await readFile(path.join(harness.project, ".cappy/cappy-workspace.json"), "utf8")).toBe(registryBefore);

    await writeFile(path.join(harness.project, "mine.csv"), "keep");
    const refused = await exportOf([run["captureId"], "-fo", "csv", "--out", "mine.csv"]);
    expect(refused.code).toBe(1);
    expect(refused.result["error"]["code"]).toBe("EXPORT_TARGET_EXISTS");
    expect(await readFile(path.join(harness.project, "mine.csv"), "utf8")).toBe("keep");
  });

  it("prints the export itself in human mode, so it can be piped", async () => {
    const run = (await runCli(harness, ["run", "boss_intro"])).result["data"];
    let stdout = "";
    const code = await main(["timeline", "export", run["captureId"], "-fo", "csv", "-C", harness.project], {
      cwd: repoRoot,
      env: process.env,
      write: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout.startsWith("seq,t_ms,type,source,duration_ms,id,payload\r\n")).toBe(true);
  });

  it("reports unknown items and bad arguments", async () => {
    const cases: [string[], number, string][] = [
      [["timeline", "export", "cap_00000000-0000-0000-0000-000000000000"], 2, "CAPTURE_NOT_FOUND"],
      [["timeline", "export", "ses_00000000-0000-0000-0000-000000000000"], 2, "SESSION_NOT_FOUND"],
      [["timeline", "export", "notes.json"], 2, "USAGE_INVALID"],
      [["timeline", "export", "cap_x", "--format", "xml"], 2, "USAGE_INVALID"],
      [["timeline", "import", "cap_x"], 2, "USAGE_INVALID"],
      [["timeline"], 2, "USAGE_INVALID"],
    ];
    for (const [args, exit, errorCode] of cases) {
      const { code, result } = await runCli(harness, args);
      expect([code, result["error"]["code"]], args.join(" ")).toEqual([exit, errorCode]);
    }
  });
});

describe.runIf(process.env["CAPPY_REAL_TOOLS"] === "1")("real FFmpeg and WebVTT", () => {
  it("accepts an exported WebVTT file as subtitles", async () => {
    const run = (await runCli(harness, ["run", "notes"], { sim: { scenarios: [AWKWARD] } })).result["data"];
    await exportOf([run["captureId"], "-fo", "vtt", "-o", "events.vtt"]);
    const srt = execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", path.join(harness.project, "events.vtt"), "-f", "srt", "-"], {
      encoding: "utf8",
    });
    expect(srt).toContain("NOTE text=");
    expect(srt.match(/-->/g)?.length).toBe(run["events"].length + 4);
  });
});
