import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagedWorkspace, REGISTRY_FILENAME, checkGitIgnore, hashFile, resolveWorkspaceRoot, unsafeRootReason } from "@cappy/workspace";

let base: string;
let project: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-ws-")));
  project = path.join(base, "project");
  outside = path.join(base, "outside");
  await mkdir(project);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function open(config?: { workspace: { root?: string } }): Promise<ManagedWorkspace> {
  const result = await ManagedWorkspace.open({ projectDir: project, ...(config === undefined ? {} : { config }) });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("workspace root", () => {
  it("defaults to .cappy/ inside the project with semantic storage areas", async () => {
    const workspace = await open();
    expect(workspace.root).toBe(path.join(project, ".cappy"));
    expect(workspace.isDefault).toBe(true);
    for (const area of ["sessions", "captures", "cache", "logs"] as const) {
      expect(existsSync(workspace.area(area))).toBe(true);
    }
    expect(existsSync(path.join(workspace.root, REGISTRY_FILENAME))).toBe(true);
  });

  it("honors a configured external artifact root", async () => {
    const external = path.join(base, "artifacts");
    expect(resolveWorkspaceRoot(project, { workspace: { root: external } })).toEqual({ root: external, isDefault: false });
    const workspace = await open({ workspace: { root: external } });
    expect(workspace.root).toBe(external);
    expect(workspace.isDefault).toBe(false);
  });

  it.each([
    ["the project directory", "."],
    ["an ancestor of the project", ".."],
    ["a filesystem root", "/"],
  ])("refuses %s as the managed root", async (_label, root) => {
    const result = await ManagedWorkspace.open({ projectDir: project, config: { workspace: { root } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "WORKSPACE_PATH_REJECTED", details: { reason: "unsafe_root" } });
  });

  it("refuses the home directory as the managed root", () => {
    expect(unsafeRootReason(project, base, base)).toContain("home directory");
    expect(unsafeRootReason(project, path.join(project, ".cappy"), base)).toBeUndefined();
  });

  it("fails clearly when the root is a file", async () => {
    await writeFile(path.join(project, ".cappy"), "not a directory");
    const result = await ManagedWorkspace.open({ projectDir: project });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("WORKSPACE_UNAVAILABLE");
  });

  it("refuses to guess ownership when the registry is corrupt", async () => {
    await mkdir(path.join(project, ".cappy"));
    await writeFile(path.join(project, ".cappy", REGISTRY_FILENAME), "{ corrupt");
    const result = await ManagedWorkspace.open({ projectDir: project });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("WORKSPACE_REGISTRY_INVALID");
  });

  it("persists ownership records across reopen", async () => {
    const first = await open();
    await first.writeManaged("sessions/ses_1/session.json", "{}");
    const second = await open();
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.managed("sessions/ses_1/session.json")?.entry.ownership).toBe("managed");
  });
});

describe("managed writes", () => {
  it("writes atomically and records SHA-256 and size", async () => {
    const workspace = await open();
    const result = await workspace.writeManaged("captures/cap_1/manifest.json", '{"ok":true}', { role: "manifest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe("captures/cap_1/manifest.json");
    expect(await readFile(result.value.hostPath, "utf8")).toBe('{"ok":true}');
    expect(result.value.entry).toMatchObject({ ownership: "managed", bytes: 11, role: "manifest" });
    expect(result.value.entry.sha256).toBe((await hashFile(result.value.hostPath)).sha256);
  });

  it("normalizes Windows-style separators", async () => {
    const workspace = await open();
    const result = await workspace.writeManaged("cache\\thumbs\\a.png", "x");
    expect(result.ok && result.value.path).toBe("cache/thumbs/a.png");
  });

  it.each([
    ["../escape.txt", "escapes_root"],
    ["sessions/../../escape.txt", "escapes_root"],
    ["/etc/passwd", "absolute"],
    ["C:\\Windows\\evil.txt", "absolute"],
    ["", "empty"],
    ["cache/\u0000bad", "invalid_characters"],
    [REGISTRY_FILENAME, "reserved"],
  ])("rejects %j (%s)", async (target, reason) => {
    const workspace = await open();
    const result = await workspace.writeManaged(target, "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "WORKSPACE_PATH_REJECTED", details: { reason } });
    expect(existsSync(path.join(base, "escape.txt"))).toBe(false);
  });

  it("rejects writes through a symlinked directory that points outside the root", async () => {
    const workspace = await open();
    await symlink(outside, path.join(workspace.root, "cache", "linked"), "junction");
    const result = await workspace.writeManaged("cache/linked/owned.txt", "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "WORKSPACE_PATH_REJECTED", details: { reason: "symlink" } });
    expect(existsSync(path.join(outside, "owned.txt"))).toBe(false);
  });

  it("never overwrites an existing artifact implicitly", async () => {
    const workspace = await open();
    await workspace.writeManaged("captures/cap_1/master.mkv", "original");
    const second = await workspace.writeManaged("captures/cap_1/master.mkv", "replacement");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("WORKSPACE_TARGET_EXISTS");
    expect(await readFile(path.join(workspace.root, "captures/cap_1/master.mkv"), "utf8")).toBe("original");
  });

  it("does not clobber an unmanaged file that already occupies the path", async () => {
    const workspace = await open();
    await mkdir(path.join(workspace.root, "captures"), { recursive: true });
    await writeFile(path.join(workspace.root, "captures", "user.txt"), "user data");
    for (const replace of [false, true]) {
      const result = await workspace.writeManaged("captures/user.txt", "cappy", { replace });
      expect(result.ok).toBe(false);
    }
    expect(await readFile(path.join(workspace.root, "captures", "user.txt"), "utf8")).toBe("user data");
  });

  it("replaces a managed file only when explicitly asked", async () => {
    const workspace = await open();
    await workspace.writeManaged("cache/index.json", "v1");
    const replaced = await workspace.writeManaged("cache/index.json", "v2", { replace: true });
    expect(replaced.ok).toBe(true);
    expect(await readFile(path.join(workspace.root, "cache/index.json"), "utf8")).toBe("v2");
    expect(workspace.managed("cache/index.json")?.entry.bytes).toBe(2);
  });

  it("publishes a tool-produced file by moving it into the managed root", async () => {
    const workspace = await open();
    const produced = path.join(outside, "render.mp4");
    await writeFile(produced, "video bytes");
    const result = await workspace.publishFile(produced, "captures/cap_1/delivery.mp4", { move: true, role: "delivery" });
    expect(result.ok).toBe(true);
    expect(existsSync(produced)).toBe(false);
    expect(await readFile(path.join(workspace.root, "captures/cap_1/delivery.mp4"), "utf8")).toBe("video bytes");
  });

  it("leaves no temp files behind after a rejected publish", async () => {
    const workspace = await open();
    await workspace.writeManaged("cache/a.txt", "a");
    await workspace.writeManaged("cache/a.txt", "b");
    expect(workspace.listManaged("cache/").map((file) => file.path)).toEqual(["cache/a.txt"]);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.join(workspace.root, "cache"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("safe cleanup", () => {
  it("removes only registered managed files and reports exactly what happened", async () => {
    const workspace = await open();
    await workspace.writeManaged("cache/a.txt", "a");
    await workspace.writeManaged("cache/b.txt", "b");
    await unlink(path.join(workspace.root, "cache/b.txt"));
    await writeFile(path.join(workspace.root, "cache/unmanaged.txt"), "keep");

    const report = await workspace.remove(["cache/a.txt", "cache/b.txt", "cache/unmanaged.txt"]);
    expect(report).toEqual({
      removed: ["cache/a.txt"],
      missing: ["cache/b.txt"],
      rejected: [{ target: "cache/unmanaged.txt", reason: "not_managed" }],
    });
    expect(existsSync(path.join(workspace.root, "cache/unmanaged.txt"))).toBe(true);
    expect(workspace.listManaged()).toEqual([]);
  });

  it("references imported and external files but never deletes them", async () => {
    const workspace = await open();
    const imported = path.join(outside, "reference.mp4");
    const external = path.join(outside, "obs-output.mkv");
    await writeFile(imported, "imported");
    await writeFile(external, "external");
    expect((await workspace.referenceFile(imported, "imported", { hash: true })).ok).toBe(true);
    expect((await workspace.referenceFile(external, "external")).ok).toBe(true);
    expect(workspace.reference(imported)).toMatchObject({ ownership: "imported", bytes: 8 });

    const report = await workspace.remove([imported, external]);
    expect(report.removed).toEqual([]);
    expect(report.rejected).toEqual([
      { target: imported, reason: "imported_files_are_never_deleted" },
      { target: external, reason: "external_files_are_never_deleted" },
    ]);
    expect(existsSync(imported)).toBe(true);
    expect(existsSync(external)).toBe(true);
  });

  it("rejects path-traversal and out-of-root cleanup targets", async () => {
    const workspace = await open();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "keep");
    const report = await workspace.remove(["../outside/victim.txt", "cache/../../../outside/victim.txt", victim]);
    expect(report.removed).toEqual([]);
    expect(report.rejected.map((entry) => entry.reason)).toEqual(["escapes_root", "escapes_root", "outside_managed_root"]);
    expect(existsSync(victim)).toBe(true);
  });

  it("rejects cleanup when a managed file was replaced by a symlink", async () => {
    const workspace = await open();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "keep");
    await workspace.writeManaged("cache/a.txt", "keep");
    await unlink(path.join(workspace.root, "cache/a.txt"));
    await symlink(victim, path.join(workspace.root, "cache/a.txt"));

    const report = await workspace.remove(["cache/a.txt"]);
    expect(report.rejected).toEqual([{ target: "cache/a.txt", reason: "symlink" }]);
    expect(existsSync(victim)).toBe(true);
  });

  it("rejects cleanup when a managed parent directory was replaced by a symlink", async () => {
    const workspace = await open();
    await workspace.writeManaged("cache/dir/a.txt", "keep");
    await writeFile(path.join(outside, "a.txt"), "keep");
    await rm(path.join(workspace.root, "cache/dir"), { recursive: true });
    await symlink(outside, path.join(workspace.root, "cache/dir"), "junction");

    const report = await workspace.remove(["cache/dir/a.txt"]);
    expect(report.rejected).toEqual([{ target: "cache/dir/a.txt", reason: "symlink" }]);
    expect(existsSync(path.join(outside, "a.txt"))).toBe(true);
  });

  it("rejects cleanup of a managed path whose content changed since Cappy wrote it", async () => {
    const workspace = await open();
    await workspace.writeManaged("cache/a.txt", "cappy");
    await writeFile(path.join(workspace.root, "cache/a.txt"), "user edited");
    const report = await workspace.remove(["cache/a.txt"]);
    expect(report.rejected).toEqual([{ target: "cache/a.txt", reason: "modified_since_managed_write" }]);
    expect(existsSync(path.join(workspace.root, "cache/a.txt"))).toBe(true);
  });
});

describe("git-ignore warning", () => {
  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: project, stdio: "ignore" });
  }

  it("warns when the default workspace is not ignored and never edits .gitignore", async () => {
    git("init", "--quiet");
    const workspace = await open();
    const check = await checkGitIgnore(project, workspace.root);
    expect(check.status).toBe("not_ignored");
    expect(check.warning).toContain(".cappy/");
    expect(existsSync(path.join(project, ".gitignore"))).toBe(false);
  });

  it("is satisfied when .cappy/ is ignored", async () => {
    git("init", "--quiet");
    await writeFile(path.join(project, ".gitignore"), ".cappy/\n");
    const workspace = await open();
    expect(await checkGitIgnore(project, workspace.root)).toEqual({ status: "ignored" });
  });

  it("does not warn outside a repository or for an external root", async () => {
    const workspace = await open();
    expect((await checkGitIgnore(project, workspace.root)).status).toBe("not_a_repository");
    expect((await checkGitIgnore(project, outside)).status).toBe("outside_project");
  });
});
