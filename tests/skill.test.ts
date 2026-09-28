import { existsSync } from "node:fs";
import { readFile as readRaw, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELP } from "@uppercut-labs/cappy-internal-cli";
import { ERROR_CODES, EXIT_CODES, parseConfig } from "@uppercut-labs/cappy-internal-core";
import { FLAGS } from "../packages/cli/src/flags.js";
import { type Harness, configure, createHarness, disposeHarness, runCli, simulatorBin } from "../packages/cli/test/support.js";

/*
 * The public agent skill in .agents/skills/cappy must stay true to the code:
 * package shape, links, commands, flags, error and exit codes, the Godot
 * addon API, and the first steps it prescribes.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows checkouts may convert line endings; the checks below expect LF.
async function readFile(file: string, encoding: "utf8"): Promise<string> {
  return (await readRaw(file, encoding)).replace(/\r\n/g, "\n");
}

const skillDir = path.join(repoRoot, ".agents/skills/cappy");
const addonDir = path.join(repoRoot, "adapters/godot/addons/cappy");

async function skillDocuments(): Promise<Map<string, string>> {
  const entries = await readdir(skillDir, { withFileTypes: true, recursive: true });
  const documents = new Map<string, string>();
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
    const file = path.join(entry.parentPath, entry.name);
    documents.set(path.relative(skillDir, file), await readFile(file, "utf8"));
  }
  return documents;
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(match, "SKILL.md starts with frontmatter").not.toBeNull();
  return Object.fromEntries(
    (match?.[1] ?? "").split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

/** Inline code spans and fenced code blocks: where the skill quotes commands and identifiers. */
function codeSpans(text: string): string[] {
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  return [...fenced, ...inline];
}

/** Each Cappy invocation the skill quotes, from `cappy` to the end of its line. */
function cappyInvocations(documents: Map<string, string>): string[] {
  return [...documents.values()].flatMap((text) =>
    codeSpans(text).flatMap((span) => span.split("\n").flatMap((line) => [...line.matchAll(/(?:^|npx\s+)cappy\s+([^#…]+)/g)].map((match) => (match[1] ?? "").trim()))),
  );
}

describe("cappy skill package", () => {
  it("has an entry point whose frontmatter names its folder and says when to use it", async () => {
    const text = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const fields = frontmatter(text);
    expect(fields["name"]).toBe(path.basename(skillDir));
    expect(fields["description"]?.length ?? 0).toBeGreaterThan(40);
    expect(fields["description"]?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(fields["description"]).not.toMatch(/[<>]/);
    expect(text.split("\n").length).toBeLessThan(500);
  });

  it("ships agent metadata and a README", () => {
    expect(existsSync(path.join(skillDir, "agents/openai.yaml"))).toBe(true);
    expect(existsSync(path.join(skillDir, "README.md"))).toBe(true);
  });

  it("links only to files inside the skill, so it works when copied on its own", async () => {
    const broken: string[] = [];
    for (const [name, text] of await skillDocuments()) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = (match[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z]+:/i.test(target)) {
          continue;
        }
        const resolved = path.resolve(skillDir, path.dirname(name), decodeURIComponent(target));
        if (!resolved.startsWith(skillDir + path.sep) || !existsSync(resolved)) {
          broken.push(`${name}: ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("points people at the npm package, never at Cappy's private source repository", async () => {
    const offenders: string[] = [];
    for (const [name, text] of await skillDocuments()) {
      for (const pattern of [/github\.com/i, /git clone/i, /\bcheckout\b/i, /\bnpm run build\b/]) {
        if (pattern.test(text)) {
          offenders.push(`${name}: ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no machine-specific paths or secret values", async () => {
    const offenders: string[] = [];
    for (const [name, text] of await skillDocuments()) {
      if (/\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s<]+\\/.test(text)) {
        offenders.push(`${name}: home path`);
      }
      if (/"password"\s*:/.test(text)) {
        offenders.push(`${name}: password in config`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("cappy skill matches the CLI", () => {
  it("names only commands the CLI has", async () => {
    const commands = new Set([...HELP.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map((match) => match[1]));
    const invocations = cappyInvocations(await skillDocuments());
    expect(invocations.length).toBeGreaterThan(10);
    const unknown = invocations.map((invocation) => invocation.split(/\s+/)[0] ?? "").filter((name) => !name.startsWith("-") && !commands.has(name));
    expect(unknown).toEqual([]);
  });

  it("uses only flags and shorthands the CLI accepts", async () => {
    // Godot's own launch flags, and the grouped shorthand the skill warns against.
    const notCappy = new Set(["--headless", "--path", "-jh"]);
    const longs = new Set<string>(Object.keys(FLAGS));
    const shorts = new Set<string>(Object.values(FLAGS).map((spec) => spec.short));
    const unknown: string[] = [];
    const documents = await skillDocuments();
    const flagTokens = [
      ...cappyInvocations(documents).flatMap((invocation) => invocation.split(/\s+/)),
      // Flags quoted on their own in prose, such as `--json` (`-j`).
      ...[...documents.values()].flatMap((text) => codeSpans(text).filter((span) => /^-{1,2}[a-zA-Z][\w-]*( <[^>]+>)?$/.test(span)).map((span) => span.split(" ")[0] ?? "")),
    ];
    for (const token of flagTokens.filter((item) => !notCappy.has(item))) {
      const long = /^--([a-z][a-z-]*)(=.*)?$/.exec(token);
      const short = /^-([a-zA-Z]+)$/.exec(token);
      if (long !== null && !longs.has(long[1] ?? "")) {
        unknown.push(token);
      } else if (short !== null && !shorts.has(short[1] ?? "")) {
        unknown.push(token);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("explains only error codes the code base defines", async () => {
    const troubleshooting = (await skillDocuments()).get("references/troubleshooting.md") ?? "";
    const rows = [...troubleshooting.matchAll(/^\| (`[A-Z_]+`(?:, `[A-Z_]+`)*) \|/gm)].flatMap((match) => [...(match[1] ?? "").matchAll(/`([A-Z_]+)`/g)].map((code) => code[1] ?? ""));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((code) => !(code in ERROR_CODES))).toEqual([]);
  });

  it("states the CLI's exit codes exactly", async () => {
    const expected = `0 success, 1 operation failed, 2 invalid usage, 3 configuration, 4 missing dependency, 70 internal error, 130 cancelled`;
    expect(EXIT_CODES).toEqual({ success: 0, operation: 1, usage: 2, configuration: 3, dependency: 4, internal: 70, cancelled: 130 });
    const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain(expected);
  });

  it("gives a starting configuration the schema accepts", async () => {
    const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const block = /```json\n([\s\S]*?)```/.exec(skill)?.[1];
    expect(block).toBeDefined();
    const parsed = parseConfig(JSON.parse(block ?? ""));
    expect(parsed.ok).toBe(true);
  });
});

describe("cappy skill matches the Godot addon", () => {
  it("refers only to addon members that exist", async () => {
    const addon = (await Promise.all(["cappy_adapter.gd", "cappy_operation.gd"].map((file) => readFile(path.join(addonDir, file), "utf8")))).join("\n");
    const members = new Set([...addon.matchAll(/^(?:static )?(?:func|var|signal|const) ([a-z_][a-z0-9_]*)/gm)].map((match) => match[1]));
    const guide = (await skillDocuments()).get("references/godot-adapter.md") ?? "";
    const skill = [...(await skillDocuments()).values()].join("\n");
    const used = [...skill.matchAll(/\b(?:Cappy|op)\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1] ?? "");
    expect(guide).not.toBe("");
    expect(used.length).toBeGreaterThan(10);
    expect([...new Set(used.filter((member) => !members.has(member)))]).toEqual([]);
  });

  it("names the addon's release-build setting as the addon reads it", async () => {
    const adapter = await readFile(path.join(addonDir, "cappy_adapter.gd"), "utf8");
    const setting = /const ALLOW_RELEASE_SETTING := "([^"]+)"/.exec(adapter)?.[1];
    expect(setting).toBeDefined();
    const [section, key] = (setting ?? "").split("/");
    const guide = (await skillDocuments()).get("references/godot-adapter.md") ?? "";
    expect(guide).toContain(`\`${setting ?? ""}\``);
    expect(guide).toContain(`[${section ?? ""}]\n\n${key ?? ""}=true`);
  });

  it("lists the addon's files as they are", async () => {
    const guide = (await skillDocuments()).get("references/godot-adapter.md") ?? "";
    const files = (await readdir(addonDir)).filter((file) => !file.endsWith(".uid")).sort();
    expect(guide).toContain(`It is ${files.length === 4 ? "four" : String(files.length)} files`);
    for (const file of files) {
      expect(guide).toContain(`\`${file}\``);
    }
  });
});

describe("cappy skill first steps", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness("cappy-skill-");
  });

  afterEach(async () => {
    await disposeHarness(harness);
  });

  it("reports a missing configuration as CONFIG_NOT_FOUND with exit 3, as troubleshooting says", async () => {
    const { code, result } = await runCli(harness, ["doctor"]);
    expect(code).toBe(3);
    expect(result["error"]["code"]).toBe("CONFIG_NOT_FOUND");
  });

  it("runs doctor, scenarios, record, and replay --no-capture from the skill's starting configuration", async () => {
    await configure(harness, { password: "not-a-real-password" });
    const skill = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const config = JSON.parse(/```json\n([\s\S]*?)```/.exec(skill)?.[1] ?? "") as Record<string, any>;
    config["game"] = { command: process.execPath, args: [simulatorBin] };
    config["obs"] = { ...config["obs"], url: harness.obs.url };
    config["tools"] = harness.tools;
    config["timeouts"] = { connectMs: 5_000, readyMs: 5_000, obsMs: 1_000 };
    await writeFile(path.join(harness.project, "cappy.config.json"), JSON.stringify(config));
    await writeFile(path.join(harness.project, ".gitignore"), ".cappy/\n");
    const env = { [config["obs"]["passwordEnv"] as string]: "not-a-real-password" };

    const doctor = await runCli(harness, ["doctor"], { env });
    expect(doctor.result["ok"]).toBe(true);
    expect(doctor.code).toBe(0);

    const scenarios = await runCli(harness, ["scenarios"], { env });
    expect(scenarios.code).toBe(0);

    const recorded = await runCli(harness, ["record", "--duration", "0.2"], { env });
    expect(recorded.code).toBe(0);
    const sessionId = recorded.result["data"]["session"]["id"] as string;

    const replayed = await runCli(harness, ["replay", sessionId, "--no-capture"], { env });
    expect(replayed.code).toBe(0);
    expect(replayed.result["ok"]).toBe(true);
  });
});
