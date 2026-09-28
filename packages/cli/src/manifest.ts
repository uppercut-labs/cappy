import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ArtifactManifest,
  type CapturePreset,
  type CaptureSource,
  type Result,
  cappyError,
  err,
  manifestSchema,
  ok,
} from "@uppercut-labs/cappy-internal-core";
import type { ManagedFile, ManagedWorkspace } from "@uppercut-labs/cappy-internal-workspace";

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable SHA-256 of a capture preset's effective configuration. */
export function presetFingerprint(preset: CapturePreset): string {
  return createHash("sha256").update(canonicalJson(preset)).digest("hex");
}

/** Groups captures of the same intended moment for take numbering. */
export function sourceKey(source: CaptureSource): string {
  return source.kind === "scenario" ? `scenario:${source.scenarioId}:${canonicalJson(source.parameters)}` : `replay:${source.sessionId}`;
}

async function readManifest(file: ManagedFile): Promise<ArtifactManifest | undefined> {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(file.hostPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Successful manifests in this workspace. Unreadable or invalid manifests are ignored. */
export async function successfulManifests(workspace: ManagedWorkspace): Promise<ArtifactManifest[]> {
  const files = workspace.listManaged("captures/").filter((file) => file.path.endsWith("/manifest.json"));
  const manifests = await Promise.all(files.map(readManifest));
  return manifests.filter((manifest): manifest is ArtifactManifest => manifest?.status === "succeeded");
}

/** The next take number for a source: one past the highest successful or retired take. */
export async function nextTake(workspace: ManagedWorkspace, source: CaptureSource): Promise<number> {
  const key = sourceKey(source);
  const takes = (await successfulManifests(workspace))
    .filter((manifest) => sourceKey(manifest.identity.source) === key)
    .map((manifest) => manifest.identity.take);
  return Math.max(0, ...takes, ...(await workspace.retiredTakes(key))) + 1;
}

/**
 * Validate and write `captures/<id>/manifest.json`. The manifest is refused
 * if it fails schema validation or contains any supplied secret value.
 */
export async function writeManifest(
  workspace: ManagedWorkspace,
  directory: string,
  manifest: ArtifactManifest,
  secrets: readonly string[],
): Promise<Result<ArtifactManifest>> {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return err(cappyError("MANIFEST_INVALID", "capture manifest failed validation", "manifest", { details: { reason: parsed.error.message } }));
  }
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  if (secrets.some((secret) => secret.length > 0 && text.includes(secret))) {
    return err(cappyError("MANIFEST_INVALID", "refusing to write a manifest that contains a secret value", "manifest"));
  }
  const written = await workspace.writeManaged(`${directory}/manifest.json`, text, { role: "manifest" });
  return written.ok ? ok(parsed.data) : written;
}
