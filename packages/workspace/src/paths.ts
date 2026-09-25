import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Semantic storage areas inside a managed root (SPEC section 7). */
export const STORAGE_AREAS = ["sessions", "captures", "cache", "logs"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];

export const REGISTRY_FILENAME = "cappy-workspace.json";

/** Why a managed path was refused. */
export type PathRejection =
  | "empty"
  | "absolute"
  | "invalid_characters"
  | "escapes_root"
  | "reserved"
  | "symlink"
  | "not_a_file";

export class PathRejectedError extends Error {
  constructor(
    readonly reason: PathRejection,
    readonly target: string,
  ) {
    super(`managed path "${target}" rejected: ${reason.replaceAll("_", " ")}`);
    this.name = "PathRejectedError";
  }
}

/** True when `candidate` is `root` itself or lies inside it. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Lexically validate a managed path and return its normalized form, using
 * forward slashes so registry keys are identical on Windows and macOS.
 */
export function normalizeManagedPath(relativePath: string): string {
  if (relativePath.trim() === "") {
    throw new PathRejectedError("empty", relativePath);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(relativePath)) {
    throw new PathRejectedError("invalid_characters", relativePath);
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new PathRejectedError("absolute", relativePath);
  }
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new PathRejectedError("escapes_root", relativePath);
  }
  if (segments.length === 0) {
    throw new PathRejectedError("empty", relativePath);
  }
  const normalized = segments.join("/");
  if (normalized === REGISTRY_FILENAME) {
    throw new PathRejectedError("reserved", relativePath);
  }
  return normalized;
}

/** Map a normalized managed path onto the host filesystem under `root`. */
export function toHostPath(root: string, normalized: string): string {
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!isWithin(root, resolved) || resolved === root) {
    throw new PathRejectedError("escapes_root", normalized);
  }
  return resolved;
}

/**
 * Reject a managed path when any existing component below the root is a
 * symbolic link or junction, so writes and cleanup can never be redirected
 * outside the managed root.
 */
export async function assertNoLinkedComponents(root: string, normalized: string): Promise<void> {
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw cause;
    }
    if (stats.isSymbolicLink()) {
      throw new PathRejectedError("symlink", normalized);
    }
  }
}

/** Confirm the real location of an existing directory stays inside the root. */
export async function assertRealPathWithin(realRoot: string, directory: string, target: string): Promise<void> {
  const real = await realpath(directory);
  if (!isWithin(realRoot, real)) {
    throw new PathRejectedError("escapes_root", target);
  }
}

/**
 * Why a managed root would be unsafe, or undefined when it is acceptable.
 * Cleanup is confined to the root, so the root itself must never contain the
 * project or the user's home directory, or be a filesystem root.
 */
export function unsafeRootReason(projectDir: string, root: string, home = homedir()): string | undefined {
  const project = path.resolve(projectDir);
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved) {
    return "the managed root cannot be a filesystem root";
  }
  if (resolved === path.resolve(home) || isWithin(resolved, path.resolve(home))) {
    return "the managed root cannot be the home directory or one of its ancestors";
  }
  if (isWithin(resolved, project)) {
    return "the managed root cannot be the project directory or one of its ancestors";
  }
  return undefined;
}
