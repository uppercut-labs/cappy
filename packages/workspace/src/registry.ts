import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REGISTRY_FILENAME } from "./paths.js";

const isoTimestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** A file Cappy created inside the managed root and may later delete. */
export const managedEntrySchema = z.strictObject({
  ownership: z.literal("managed"),
  sha256,
  bytes: z.int().nonnegative(),
  createdAt: isoTimestamp,
  role: z.string().min(1).optional(),
});
export type ManagedEntry = z.output<typeof managedEntrySchema>;

/** A file Cappy references but never deletes. */
export const referenceEntrySchema = z.strictObject({
  ownership: z.enum(["imported", "external"]),
  referencedAt: isoTimestamp,
  role: z.string().min(1).optional(),
  sha256: sha256.optional(),
  bytes: z.int().nonnegative().optional(),
});
export type ReferenceEntry = z.output<typeof referenceEntrySchema>;

export const registrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1),
  createdAt: isoTimestamp,
  /** Keyed by normalized path relative to the managed root. */
  managed: z.record(z.string(), managedEntrySchema),
  /** Keyed by absolute host path. */
  references: z.record(z.string(), referenceEntrySchema),
});
export type Registry = z.output<typeof registrySchema>;

export function emptyRegistry(now: string): Registry {
  return { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, createdAt: now, managed: {}, references: {} };
}

export function registryPath(root: string): string {
  return path.join(root, REGISTRY_FILENAME);
}

export type RegistryRead = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "ok"; registry: Registry };

export async function readRegistry(root: string): Promise<RegistryRead> {
  let text: string;
  try {
    text = await readFile(registryPath(root), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw cause;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { kind: "invalid", reason: (cause as Error).message };
  }
  const parsed = registrySchema.safeParse(raw);
  return parsed.success ? { kind: "ok", registry: parsed.data } : { kind: "invalid", reason: parsed.error.message };
}

/** Replace the registry atomically: write a sibling temp file, then rename. */
export async function writeRegistry(root: string, registry: Registry): Promise<void> {
  const target = registryPath(root);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temp, target);
}
