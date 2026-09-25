import { readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { type CaptureSource, type CommandResult, cappyError, commandFailure, commandSuccess, loadConfig } from "@cappy/core";
import { ManagedWorkspace } from "@cappy/workspace";
import type { CommandContext } from "../context.js";
import { type ItemKind, type WorkspaceItem, filesOnDisk, readInventory } from "../inventory.js";
import { liveCorrelationIds } from "../log.js";
import { sourceKey } from "../manifest.js";

export interface CleanReport {
  readonly dryRun: boolean;
  readonly items: readonly { readonly id: string; readonly kind: ItemKind; readonly files: readonly string[]; readonly bytes: number }[];
  /** Paths removed, or with `dryRun` the paths that would be removed. */
  readonly removed: readonly string[];
  readonly missing: readonly string[];
  readonly refused: readonly { readonly target: string; readonly reason: string }[];
  readonly kept: readonly { readonly path: string; readonly reason: string }[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly retiredTakes: readonly { readonly source: CaptureSource; readonly take: number }[];
  readonly bytesFreed: number;
}

const COMMAND = "clean";
const AGE = /^([1-9][0-9]*)([mhdw])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

function usage(message: string, correlationId: string): CommandResult<CleanReport> {
  return commandFailure(
    COMMAND,
    cappyError("USAGE_INVALID", message, COMMAND, {
      details: { usage: "cappy clean [<id>...] [--failed] [--older-than <age>] [--logs] [--all] [--dry-run]" },
      retryable: false,
    }),
    { correlationId },
  );
}

/** Parse an age such as `90m`, `12h`, `7d`, or `2w` into milliseconds. */
export function parseAge(value: string): number | undefined {
  const match = AGE.exec(value);
  return match === null ? undefined : Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * Delete selected managed items immediately, or with `--dry-run` report what
 * would happen. Ownership and hash checks come from the workspace; this
 * command decides what is selected and what is protected (SPEC 11.7).
 */
export async function clean(context: CommandContext): Promise<CommandResult<CleanReport>> {
  const flag = (name: string): boolean => context.flags[name] === true;
  const ids = [...new Set(context.positionals)];
  const olderThanFlag = context.flags["older-than"];
  const bulk = { failed: flag("failed"), logs: flag("logs"), all: flag("all") };
  const dryRun = flag("dry-run");
  if (ids.length === 0 && !bulk.failed && !bulk.logs && !bulk.all && olderThanFlag === undefined) {
    return usage("choose what to clean: item IDs, --failed, --logs, --all, or --older-than <age>", context.correlationId);
  }
  let maxAgeMs: number | undefined;
  if (typeof olderThanFlag === "string") {
    if (ids.length > 0) {
      return usage("--older-than filters bulk selectors and cannot be combined with item IDs", context.correlationId);
    }
    maxAgeMs = parseAge(olderThanFlag);
    if (maxAgeMs === undefined) {
      return usage(`--older-than needs a positive age such as 90m, 12h, 7d, or 2w, not "${olderThanFlag}"`, context.correlationId);
    }
  }

  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure(COMMAND, loaded.error, { correlationId: context.correlationId });
  }
  const opened = await ManagedWorkspace.open({ projectDir: loaded.value.projectDir, config: loaded.value.config });
  if (!opened.ok) {
    return commandFailure(COMMAND, opened.error, { correlationId: context.correlationId });
  }
  const workspace = opened.value;
  const live = await liveCorrelationIds(workspace, { prune: !dryRun });
  const inventory = await readInventory(workspace);
  const byId = new Map(inventory.map((item) => [item.id, item]));

  /** Whether a live command may still be writing this item. */
  const inProgress = (item: WorkspaceItem): boolean => {
    switch (item.kind) {
      case "session":
        return item.record.state === "ok" && item.record.status === "active" && live.has(item.record.correlationId);
      case "capture":
        return item.record.state === "none" && live.size > 0;
      case "log":
        return live.has(item.id);
    }
  };
  const failed = (item: WorkspaceItem): boolean => {
    switch (item.kind) {
      case "capture":
        return item.record.state === "none" || (item.record.state === "ok" && item.record.status !== "succeeded");
      case "session":
        return item.record.state === "ok" && item.record.status !== "completed";
      case "log":
        return false;
    }
  };

  const selected = new Map<string, WorkspaceItem>();
  const refused: { target: string; reason: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined || item.kind === "log") {
      refused.push({ target: id, reason: "not_found" });
    } else if (inProgress(item)) {
      refused.push({ target: id, reason: "in_progress" });
    } else {
      selected.set(id, item);
    }
  }

  const everything = bulk.all || (maxAgeMs !== undefined && !bulk.failed && !bulk.logs);
  const now = Date.now();
  for (const item of inventory) {
    const chosen = everything || (bulk.failed && failed(item)) || (bulk.logs && item.kind === "log");
    if (!chosen || selected.has(item.id) || (maxAgeMs !== undefined && now - item.createdAt.getTime() <= maxAgeMs)) {
      continue;
    }
    if (inProgress(item)) {
      skipped.push({ id: item.id, reason: "in_progress" });
    } else {
      selected.set(item.id, item);
    }
  }
  const unreadable = inventory.filter((item) => bulk.failed && !bulk.all && item.kind === "capture" && item.record.state === "unreadable");
  if (unreadable.length > 0) {
    warnings.push(`--failed skipped capture(s) with an unreadable manifest: ${unreadable.map((item) => item.id).join(", ")}`);
  }

  // A scenario capture takes the scenario session it created with it.
  for (const item of [...selected.values()]) {
    if (item.kind !== "capture" || item.record.state !== "ok" || item.record.source.kind !== "scenario") {
      continue;
    }
    const session = byId.get(item.record.sessionId);
    if (session?.kind !== "session" || selected.has(session.id) || session.record.state !== "ok" || session.record.origin !== "scenario") {
      continue;
    }
    if (inProgress(session)) {
      skipped.push({ id: session.id, reason: "in_progress" });
    } else {
      selected.set(session.id, session);
    }
  }

  // Replay captures of a removed session stay, but can no longer be re-captured.
  for (const item of selected.values()) {
    if (item.kind !== "session") {
      continue;
    }
    const replays = inventory.filter(
      (other) =>
        other.kind === "capture" &&
        !selected.has(other.id) &&
        other.record.state === "ok" &&
        other.record.source.kind === "replay" &&
        other.record.source.sessionId === item.id,
    );
    if (replays.length > 0) {
      warnings.push(`session ${item.id} is replayed by ${replays.map((other) => other.id).join(", ")}, which remain but can no longer be re-captured`);
    }
  }

  // Retire takes before anything is deleted, so a partial failure never frees a take number.
  const retiredTakes: { source: CaptureSource; take: number }[] = [];
  const retiring = new Map<string, number[]>();
  for (const item of selected.values()) {
    if (item.kind === "capture" && item.record.state === "ok" && item.record.status === "succeeded") {
      retiredTakes.push({ source: item.record.source, take: item.record.take });
      const key = sourceKey(item.record.source);
      retiring.set(key, [...(retiring.get(key) ?? []), item.record.take]);
    }
  }
  if (!dryRun) {
    for (const [key, takes] of retiring) {
      const retired = await workspace.retireTakes(key, takes);
      if (!retired.ok) {
        return commandFailure(COMMAND, retired.error, { correlationId: context.correlationId });
      }
    }
  }

  const items = [...selected.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const outcome = await workspace.remove(
    items.flatMap((item) => item.files.map((file) => file.path)),
    { dryRun },
  );
  refused.push(...outcome.rejected);

  // Unregistered leftovers stay; directories that end up empty go.
  const kept: { path: string; reason: string }[] = [];
  for (const item of items) {
    if (item.directory === undefined) {
      continue;
    }
    const owned = new Set(item.files.map((file) => file.path));
    for (const file of await filesOnDisk(workspace.root, item.directory)) {
      if (!owned.has(file)) {
        kept.push({ path: file, reason: "not_managed" });
      }
    }
    if (!dryRun) {
      await removeEmptyDirectories(workspace.root, item.directory);
    }
  }
  if (kept.length > 0) {
    warnings.push(`kept ${kept.length} unregistered file(s) Cappy did not create; their directories stay`);
  }
  if (skipped.length > 0) {
    warnings.push(`skipped ${skipped.length} item(s) a running command may still be writing: ${skipped.map((entry) => entry.id).join(", ")}`);
  }

  const removed = new Set(outcome.removed);
  const report: CleanReport = {
    dryRun,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      files: item.files.map((file) => file.path),
      bytes: item.files.reduce((total, file) => total + file.entry.bytes, 0),
    })),
    removed: outcome.removed,
    missing: outcome.missing,
    refused,
    kept,
    skipped,
    retiredTakes,
    bytesFreed: items.flatMap((item) => item.files).reduce((total, file) => total + (removed.has(file.path) ? file.entry.bytes : 0), 0),
  };
  if (refused.length > 0) {
    return commandFailure(
      COMMAND,
      cappyError("CLEAN_INCOMPLETE", `${refused.length} target(s) were refused and left in place`, COMMAND, {
        details: { refused, removed: outcome.removed.length, dryRun },
        retryable: false,
      }),
      { correlationId: context.correlationId, warnings, data: report },
    );
  }
  return commandSuccess(COMMAND, report, { correlationId: context.correlationId, warnings });
}

/** Remove a directory tree's empty directories, deepest first; never a directory that still holds anything. */
async function removeEmptyDirectories(root: string, directory: string): Promise<void> {
  const walk = async (relative: string): Promise<void> => {
    const host = path.join(root, relative);
    const entries = await readdir(host, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(`${relative}/${entry.name}`);
      }
    }
    await rmdir(host).catch(() => undefined);
  };
  await walk(directory);
}
