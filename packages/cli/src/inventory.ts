import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { captureSourceSchema } from "@uppercut-labs/cappy-internal-core";
import type { ManagedFile, ManagedWorkspace } from "@uppercut-labs/cappy-internal-workspace";
import { z } from "zod";

/** The units `cappy clean` selects (SPEC 11.7). */
export type ItemKind = "capture" | "session" | "comparison" | "log";

/** What a capture's manifest says, read leniently so a newer or damaged manifest is still recognized. */
export type CaptureRecord =
  | { readonly state: "none" }
  | { readonly state: "unreadable" }
  | {
      readonly state: "ok";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly source: z.output<typeof captureSourceSchema>;
      readonly take: number;
      readonly sessionId: string;
      readonly startedAt: string;
    };

export type SessionRecord =
  | { readonly state: "none" }
  | { readonly state: "unreadable" }
  | {
      readonly state: "ok";
      readonly status: "active" | "completed" | "failed" | "cancelled";
      readonly origin: "scenario" | "freeform";
      readonly startedAt: string;
      readonly correlationId: string;
    };

export type ComparisonRecord =
  | { readonly state: "none" }
  | { readonly state: "unreadable" }
  | { readonly state: "ok"; readonly status: "succeeded" | "regressed" | "failed"; readonly createdAt: string };

interface ItemBase {
  readonly id: string;
  /** Root-relative directory of a capture or session; logs have none. */
  readonly directory?: string;
  /** Managed files that belong to the item. */
  readonly files: readonly ManagedFile[];
  /** When Cappy created the item, for `--older-than`. */
  readonly createdAt: Date;
}

export type WorkspaceItem =
  | (ItemBase & { readonly kind: "capture"; readonly directory: string; readonly record: CaptureRecord })
  | (ItemBase & { readonly kind: "session"; readonly directory: string; readonly record: SessionRecord })
  | (ItemBase & { readonly kind: "comparison"; readonly directory: string; readonly record: ComparisonRecord })
  | (ItemBase & { readonly kind: "log" });

const leniently = z.iso.datetime({ offset: true });

const captureManifest = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  identity: z.object({ take: z.int().positive(), source: captureSourceSchema, sessionId: z.string().min(1) }),
  timing: z.object({ startedAt: leniently }),
});

const comparisonManifest = z.object({
  status: z.enum(["succeeded", "regressed", "failed"]),
  createdAt: leniently,
});

const sessionMetadata = z.object({
  status: z.enum(["active", "completed", "failed", "cancelled"]),
  origin: z.enum(["scenario", "freeform"]),
  startedAt: leniently,
  correlationId: z.string().min(1),
});

async function readJson<T>(file: ManagedFile | undefined, schema: z.ZodType<T>): Promise<{ state: "none" } | { state: "unreadable" } | ({ state: "ok" } & T)> {
  if (file === undefined) {
    return { state: "none" };
  }
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file.hostPath, "utf8")));
    return parsed.success ? { state: "ok", ...parsed.data } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

const ITEM_PREFIX = { captures: "cap", sessions: "ses", comparisons: "cmp" } as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Item directories under an area: those on disk plus those the registry
 * still lists. Only names Cappy itself generates (`cap_<uuid>` and so on)
 * are items, so a folder someone else put there is never selected.
 */
async function itemIds(workspace: ManagedWorkspace, area: keyof typeof ITEM_PREFIX): Promise<string[]> {
  const shaped = new RegExp(`^${ITEM_PREFIX[area]}_${UUID}$`);
  const ids = new Set<string>();
  const entries = await readdir(workspace.area(area), { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      ids.add(entry.name);
    }
  }
  for (const file of workspace.listManaged(`${area}/`)) {
    const id = file.path.split("/")[1];
    if (id !== undefined && file.path.split("/").length > 2) {
      ids.add(id);
    }
  }
  return [...ids].filter((id) => shaped.test(id)).sort();
}

/** Earliest registry creation time among the files, else the directory's modification time. */
async function fallbackCreatedAt(workspace: ManagedWorkspace, files: readonly ManagedFile[], directory?: string): Promise<Date> {
  const times = files.map((file) => Date.parse(file.entry.createdAt)).filter((time) => !Number.isNaN(time));
  if (times.length > 0) {
    return new Date(Math.min(...times));
  }
  if (directory !== undefined) {
    const stats = await lstat(path.join(workspace.root, directory)).catch(() => undefined);
    if (stats !== undefined) {
      return stats.mtime;
    }
  }
  return new Date();
}

/** Every capture, session, comparison, and command log in the workspace. */
export async function readInventory(workspace: ManagedWorkspace): Promise<WorkspaceItem[]> {
  const items: WorkspaceItem[] = [];
  for (const id of await itemIds(workspace, "captures")) {
    const directory = `captures/${id}`;
    const files = workspace.listManaged(`${directory}/`);
    const record: CaptureRecord = await readJson(workspace.managed(`${directory}/manifest.json`), captureManifest).then((read) =>
      read.state === "ok"
        ? { state: "ok", status: read.status, source: read.identity.source, take: read.identity.take, sessionId: read.identity.sessionId, startedAt: read.timing.startedAt }
        : read,
    );
    const createdAt = record.state === "ok" ? new Date(record.startedAt) : await fallbackCreatedAt(workspace, files, directory);
    items.push({ id, kind: "capture", directory, files, createdAt, record });
  }
  for (const id of await itemIds(workspace, "sessions")) {
    const directory = `sessions/${id}`;
    const files = workspace.listManaged(`${directory}/`);
    const record: SessionRecord = await readJson(workspace.managed(`${directory}/session.json`), sessionMetadata);
    const createdAt = record.state === "ok" ? new Date(record.startedAt) : await fallbackCreatedAt(workspace, files, directory);
    items.push({ id, kind: "session", directory, files, createdAt, record });
  }
  for (const id of await itemIds(workspace, "comparisons")) {
    const directory = `comparisons/${id}`;
    const files = workspace.listManaged(`${directory}/`);
    const record: ComparisonRecord = await readJson(workspace.managed(`${directory}/manifest.json`), comparisonManifest);
    const createdAt = record.state === "ok" ? new Date(record.createdAt) : await fallbackCreatedAt(workspace, files, directory);
    items.push({ id, kind: "comparison", directory, files, createdAt, record });
  }
  for (const file of workspace.listManaged("logs/")) {
    const name = file.path.slice("logs/".length);
    if (name.endsWith(".jsonl") && !name.includes("/")) {
      items.push({ id: name.slice(0, -".jsonl".length), kind: "log", files: [file], createdAt: await fallbackCreatedAt(workspace, [file]) });
    }
  }
  return items;
}

/**
 * Files on disk under a directory, without following links; links are listed
 * but not entered. Callers first confirm the directory itself is not reached
 * through a link (`ManagedWorkspace.linkedDirectoryReason`).
 */
export async function filesOnDisk(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        found.push(child);
      }
    }
  };
  await walk(directory);
  return found.sort();
}
