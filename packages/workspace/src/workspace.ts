import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  type CappyConfig,
  type CappyError,
  DEFAULT_WORKSPACE_DIR,
  type Result,
  cappyError,
  err,
  ok,
} from "@cappy/core";
import { hashBytes, hashFile } from "./hash.js";
import {
  PathRejectedError,
  REGISTRY_FILENAME,
  STORAGE_AREAS,
  type StorageArea,
  assertNoLinkedComponents,
  assertRealPathWithin,
  isWithin,
  normalizeManagedPath,
  toHostPath,
  unsafeRootReason,
} from "./paths.js";
import { type ManagedEntry, type ReferenceEntry, type Registry, emptyRegistry, readRegistry, retryTransient, writeRegistry } from "./registry.js";

export interface ManagedFile {
  /** Normalized path relative to the managed root. */
  readonly path: string;
  readonly hostPath: string;
  readonly entry: ManagedEntry;
}

export interface CleanupReport {
  /** Removed paths, or with `dryRun` the paths that would be removed. */
  readonly removed: readonly string[];
  readonly missing: readonly string[];
  readonly rejected: readonly { readonly target: string; readonly reason: string }[];
}

export interface RemoveOptions {
  /** Run every check and report the outcome without deleting or registering anything. */
  readonly dryRun?: boolean;
}

export interface WriteOptions {
  readonly role?: string;
  /**
   * Replace an existing managed file at the same path. Never implied: without
   * it, publishing onto an existing file fails. Only managed files can be
   * replaced.
   */
  readonly replace?: boolean;
}

const OPERATION = "workspace";

/** Exclusive lock around every registry read-modify-write, shared by all Cappy processes. */
const REGISTRY_LOCK = `${REGISTRY_FILENAME}.lock`;
/** A registry update takes milliseconds; a lock this old was left by a crashed command. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

function now(): string {
  return new Date().toISOString();
}

function rejection(error: PathRejectedError): CappyError {
  return cappyError("WORKSPACE_PATH_REJECTED", error.message, OPERATION, {
    details: { target: error.target, reason: error.reason },
    retryable: false,
  });
}

function failure(cause: unknown, target: string): CappyError {
  if (cause instanceof PathRejectedError) {
    return rejection(cause);
  }
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === "EEXIST") {
    return cappyError("WORKSPACE_TARGET_EXISTS", `"${target}" already exists; existing files are never overwritten implicitly`, OPERATION, {
      details: { target },
      retryable: false,
    });
  }
  return cappyError("WORKSPACE_WRITE_FAILED", `could not write managed file "${target}"`, OPERATION, {
    details: { target, cause: code ?? String(cause) },
  });
}

/**
 * Hold `cappy-workspace.json.lock` in a managed root while running an
 * operation. The lock is created exclusively; a lock older than a crashed
 * update is broken, and Windows' transient sharing errors count as "busy".
 */
async function withRegistryLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, REGISTRY_LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: now() }), { flag: "wx" });
      break;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? "";
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(code)) {
        throw cause;
      }
      const held = await stat(lock).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw Object.assign(new Error("the workspace registry is locked by another command"), { code: "EBUSY" });
      }
      await delay(5 + Math.random() * 20);
    }
  }
  try {
    return await operation();
  } finally {
    await retryTransient(() => unlink(lock)).catch(() => undefined);
  }
}

/** Resolve where the managed root lives for a project, without touching disk. */
export function resolveWorkspaceRoot(projectDir: string, config?: Pick<CappyConfig, "workspace">): {
  root: string;
  isDefault: boolean;
} {
  const configured = config?.workspace.root;
  return configured === undefined
    ? { root: path.resolve(projectDir, DEFAULT_WORKSPACE_DIR), isDefault: true }
    : { root: path.resolve(projectDir, configured), isDefault: false };
}

/**
 * A project's managed workspace. Every file Cappy may later delete is
 * recorded in the workspace registry with its hash; imported and external
 * files can be referenced but are never deleted.
 */
export class ManagedWorkspace {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    /** Real (symlink-resolved) absolute path of the managed root. */
    readonly root: string,
    readonly isDefault: boolean,
    private registry: Registry,
  ) {}

  get workspaceId(): string {
    return this.registry.workspaceId;
  }

  /**
   * Open (creating if needed) the managed workspace for a project. With
   * `readOnly`, nothing is created: the root must already exist, missing
   * storage areas stay missing, and a missing registry reads as empty.
   */
  static async open(options: {
    projectDir: string;
    config?: Pick<CappyConfig, "workspace">;
    readOnly?: boolean;
  }): Promise<Result<ManagedWorkspace>> {
    const { root, isDefault } = resolveWorkspaceRoot(options.projectDir, options.config);
    const unsafe = unsafeRootReason(options.projectDir, root);
    if (unsafe !== undefined) {
      return err(
        cappyError("WORKSPACE_PATH_REJECTED", unsafe, OPERATION, { details: { root, reason: "unsafe_root" }, retryable: false }),
      );
    }
    let realRoot: string;
    try {
      if (options.readOnly !== true) {
        await mkdir(root, { recursive: true });
      }
      realRoot = await realpath(root);
      if (!(await stat(realRoot)).isDirectory()) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      if (options.readOnly !== true) {
        for (const area of STORAGE_AREAS) {
          await mkdir(path.join(realRoot, area), { recursive: true });
        }
      }
    } catch (cause) {
      return err(
        cappyError("WORKSPACE_UNAVAILABLE", `managed workspace ${root} is not usable`, OPERATION, {
          details: { root, cause: (cause as NodeJS.ErrnoException).code ?? String(cause) },
        }),
      );
    }

    let read = await readRegistry(realRoot);
    if (read.kind === "missing" && options.readOnly !== true) {
      // Commands opening a new workspace at the same time must agree on one registry.
      try {
        read = await withRegistryLock(realRoot, async () => {
          const current = await readRegistry(realRoot);
          if (current.kind === "missing") {
            const created = emptyRegistry(now());
            await writeRegistry(realRoot, created);
            return { kind: "ok", registry: created } as const;
          }
          return current;
        });
      } catch (cause) {
        return err(
          cappyError("WORKSPACE_UNAVAILABLE", `managed workspace ${realRoot} is not writable`, OPERATION, {
            details: { root: realRoot, cause: (cause as NodeJS.ErrnoException).code ?? String(cause) },
          }),
        );
      }
    }
    if (read.kind === "invalid") {
      return err(
        cappyError("WORKSPACE_REGISTRY_INVALID", `workspace registry in ${realRoot} is unreadable; refusing to guess ownership`, OPERATION, {
          details: { root: realRoot, reason: read.reason },
          retryable: false,
        }),
      );
    }
    // Only a read-only open can still see no registry; it reads as empty.
    const registry: Registry = read.kind === "ok" ? read.registry : emptyRegistry(now());
    return ok(new ManagedWorkspace(realRoot, isDefault, registry));
  }

  /** Host path of a storage area such as `sessions` or `captures`. */
  area(name: StorageArea): string {
    return path.join(this.root, name);
  }

  /** Validate a managed path and return its normalized form and host path. */
  resolve(relativePath: string): Result<{ path: string; hostPath: string }> {
    try {
      const normalized = normalizeManagedPath(relativePath);
      return ok({ path: normalized, hostPath: toHostPath(this.root, normalized) });
    } catch (cause) {
      if (cause instanceof PathRejectedError) {
        return err(rejection(cause));
      }
      throw cause;
    }
  }

  managed(relativePath: string): ManagedFile | undefined {
    const resolved = this.resolve(relativePath);
    if (!resolved.ok) {
      return undefined;
    }
    const entry = this.registry.managed[resolved.value.path];
    return entry === undefined ? undefined : { ...resolved.value, entry };
  }

  /** Managed files, optionally limited to a path prefix such as `cache/`. */
  listManaged(prefix = ""): ManagedFile[] {
    const normalizedPrefix = prefix.replaceAll("\\", "/");
    return Object.entries(this.registry.managed)
      .filter(([key]) => key.startsWith(normalizedPrefix))
      .map(([key, entry]) => ({ path: key, hostPath: toHostPath(this.root, key), entry }));
  }

  /**
   * Create a directory inside the managed root, with the same link and escape
   * checks as a managed write, and return its host path. Tools that must run
   * inside an item's directory use this before writing partial files there.
   */
  async ensureDirectory(relativePath: string): Promise<Result<string>> {
    try {
      const normalized = normalizeManagedPath(relativePath);
      const hostPath = toHostPath(this.root, normalized);
      await assertNoLinkedComponents(this.root, normalized);
      await mkdir(hostPath, { recursive: true });
      await assertRealPathWithin(this.root, hostPath, normalized);
      return ok(hostPath);
    } catch (cause) {
      return err(failure(cause, relativePath));
    }
  }

  /**
   * Why an existing directory in the managed root must not be walked or
   * emptied: a link or junction on its path, or a real location outside the
   * root. Undefined when it is safe or absent.
   */
  async linkedDirectoryReason(relativePath: string): Promise<string | undefined> {
    try {
      const normalized = normalizeManagedPath(relativePath);
      await assertNoLinkedComponents(this.root, normalized);
      const hostPath = toHostPath(this.root, normalized);
      if (await lstat(hostPath).then(() => true, () => false)) {
        await assertRealPathWithin(this.root, hostPath, normalized);
      }
      return undefined;
    } catch (cause) {
      if (cause instanceof PathRejectedError) {
        return cause.reason;
      }
      throw cause;
    }
  }

  reference(hostPath: string): ReferenceEntry | undefined {
    return this.registry.references[path.resolve(hostPath)];
  }

  /** Atomically write bytes to a new managed file. */
  async writeManaged(relativePath: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<Result<ManagedFile>> {
    return this.serialize(async () => {
      let target: { path: string; hostPath: string } | undefined;
      try {
        target = await this.prepareTarget(relativePath, options);
        const temp = this.tempPathFor(target.hostPath);
        await writeFile(temp, data, { flag: "wx" });
        const digest = hashBytes(data);
        await this.publish(temp, target.hostPath, options.replace === true);
        return ok(await this.register(target, digest, options.role));
      } catch (cause) {
        return err(failure(cause, target?.path ?? relativePath));
      }
    });
  }

  /**
   * Publish a file produced elsewhere (for example by FFmpeg or OBS) into the
   * managed root. The source is moved when `move` is set and it is on the same
   * volume; otherwise it is copied and left in place.
   */
  async publishFile(
    sourcePath: string,
    relativePath: string,
    options: WriteOptions & { readonly move?: boolean } = {},
  ): Promise<Result<ManagedFile>> {
    return this.serialize(async () => {
      let target: { path: string; hostPath: string } | undefined;
      try {
        target = await this.prepareTarget(relativePath, options);
        const temp = this.tempPathFor(target.hostPath);
        let moved = false;
        if (options.move === true) {
          try {
            await rename(sourcePath, temp);
            moved = true;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EXDEV") {
              throw cause;
            }
          }
        }
        if (!moved) {
          await copyFile(sourcePath, temp, constants.COPYFILE_EXCL);
        }
        const digest = await hashFile(temp);
        await this.publish(temp, target.hostPath, options.replace === true);
        if (options.move === true && !moved) {
          await unlink(sourcePath);
        }
        return ok(await this.register(target, digest, options.role));
      } catch (cause) {
        return err(failure(cause, target?.path ?? relativePath));
      }
    });
  }

  /** Record an imported or external file. Cappy will never delete it. */
  async referenceFile(
    hostPath: string,
    ownership: "imported" | "external",
    options: { role?: string; hash?: boolean } = {},
  ): Promise<Result<ReferenceEntry>> {
    return this.serialize(async () => {
      const absolute = path.resolve(hostPath);
      try {
        const digest = options.hash === true ? await hashFile(absolute) : undefined;
        const entry: ReferenceEntry = {
          ownership,
          referencedAt: now(),
          ...(options.role === undefined ? {} : { role: options.role }),
          ...(digest === undefined ? {} : { sha256: digest.sha256, bytes: digest.bytes }),
        };
        await this.update((registry) => ({ ...registry, references: { ...registry.references, [absolute]: entry } }));
        return ok(entry);
      } catch (cause) {
        return err(failure(cause, absolute));
      }
    });
  }

  /**
   * Record take numbers as retired for a take group, so they are never
   * reissued. Retired takes are only ever added.
   */
  async retireTakes(group: string, takes: readonly number[]): Promise<Result<readonly number[]>> {
    return this.serialize(async () => {
      try {
        let retired: number[] = [];
        await this.update((registry) => {
          retired = [...new Set([...(registry.retiredTakes[group] ?? []), ...takes])].sort((a, b) => a - b);
          return { ...registry, retiredTakes: { ...registry.retiredTakes, [group]: retired } };
        });
        return ok(retired);
      } catch (cause) {
        return err(failure(cause, REGISTRY_FILENAME));
      }
    });
  }

  /**
   * Take numbers retired for a take group, read from the registry on disk so
   * a take retired by a concurrent command is never reissued.
   */
  async retiredTakes(group: string): Promise<readonly number[]> {
    const current = await readRegistry(this.root).catch(() => undefined);
    const registry = current?.kind === "ok" ? current.registry : this.registry;
    return registry.retiredTakes[group] ?? [];
  }

  /**
   * Delete explicitly selected managed files. Anything that is not a
   * registered managed file inside the root, has been replaced by a link, or
   * no longer matches the recorded hash is rejected and left untouched. With
   * `dryRun`, every check runs but nothing is deleted or unregistered.
   */
  async remove(targets: readonly string[], options: RemoveOptions = {}): Promise<CleanupReport> {
    return this.serialize(async () => {
      const removed: string[] = [];
      const missing: string[] = [];
      const rejected: { target: string; reason: string }[] = [];
      const dropped = new Set<string>();
      const managed = this.registry.managed;

      for (const target of targets) {
        const reason = this.referenceReason(target);
        if (reason !== undefined) {
          rejected.push({ target, reason });
          continue;
        }
        let normalized: string;
        let hostPath: string;
        try {
          normalized = normalizeManagedPath(target);
          hostPath = toHostPath(this.root, normalized);
        } catch (cause) {
          if (cause instanceof PathRejectedError) {
            rejected.push({ target, reason: cause.reason });
            continue;
          }
          throw cause;
        }
        const entry = dropped.has(normalized) ? undefined : managed[normalized];
        if (entry === undefined) {
          rejected.push({ target, reason: "not_managed" });
          continue;
        }
        try {
          await assertNoLinkedComponents(this.root, normalized);
          const stats = await lstat(hostPath);
          if (!stats.isFile()) {
            throw new PathRejectedError("not_a_file", normalized);
          }
          await assertRealPathWithin(this.root, path.dirname(hostPath), normalized);
          const digest = await hashFile(hostPath);
          if (digest.sha256 !== entry.sha256 || digest.bytes !== entry.bytes) {
            rejected.push({ target, reason: "modified_since_managed_write" });
            continue;
          }
          if (options.dryRun !== true) {
            await unlink(hostPath);
          }
          removed.push(normalized);
        } catch (cause) {
          if (cause instanceof PathRejectedError) {
            rejected.push({ target, reason: cause.reason });
            continue;
          }
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            missing.push(normalized);
          } else {
            rejected.push({ target, reason: (cause as NodeJS.ErrnoException).code ?? "unknown_error" });
            continue;
          }
        }
        dropped.add(normalized);
      }

      if (dropped.size > 0 && options.dryRun !== true) {
        await this.update((registry) => ({
          ...registry,
          managed: Object.fromEntries(Object.entries(registry.managed).filter(([key]) => !dropped.has(key))),
        }));
      }
      return { removed, missing, rejected };
    });
  }

  /** Explain why a target is a protected reference, if it is one. */
  private referenceReason(target: string): string | undefined {
    if (!path.isAbsolute(target)) {
      return undefined;
    }
    const entry = this.registry.references[path.resolve(target)];
    if (entry !== undefined) {
      return `${entry.ownership}_files_are_never_deleted`;
    }
    return isWithin(this.root, path.resolve(target)) ? "absolute" : "outside_managed_root";
  }

  private async prepareTarget(relativePath: string, options: WriteOptions): Promise<{ path: string; hostPath: string }> {
    const normalized = normalizeManagedPath(relativePath);
    const hostPath = toHostPath(this.root, normalized);
    await assertNoLinkedComponents(this.root, normalized);
    const existing = this.registry.managed[normalized];
    if (options.replace === true && existing === undefined) {
      const occupied = await lstat(hostPath).then(
        () => true,
        () => false,
      );
      if (occupied) {
        throw Object.assign(new Error(`"${normalized}" exists and is not managed`), { code: "EEXIST" });
      }
    }
    await mkdir(path.dirname(hostPath), { recursive: true });
    await assertRealPathWithin(this.root, path.dirname(hostPath), normalized);
    return { path: normalized, hostPath };
  }

  private tempPathFor(hostPath: string): string {
    return path.join(path.dirname(hostPath), `.${path.basename(hostPath)}.${randomUUID()}.tmp`);
  }

  /**
   * Move a completed temp file into place. Without `replace`, a hard link
   * gives atomic no-clobber publication; filesystems without hard links fall
   * back to an exclusive copy.
   */
  private async publish(temp: string, hostPath: string, replace: boolean): Promise<void> {
    try {
      if (replace) {
        await rename(temp, hostPath);
        return;
      }
      try {
        await link(temp, hostPath);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          throw cause;
        }
        await copyFile(temp, hostPath, constants.COPYFILE_EXCL);
      }
      await unlink(temp);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
  }

  private async register(
    target: { path: string; hostPath: string },
    digest: { sha256: string; bytes: number },
    role: string | undefined,
  ): Promise<ManagedFile> {
    const entry: ManagedEntry = {
      ownership: "managed",
      sha256: digest.sha256,
      bytes: digest.bytes,
      createdAt: now(),
      ...(role === undefined ? {} : { role }),
    };
    await this.update((registry) => ({ ...registry, managed: { ...registry.managed, [target.path]: entry } }));
    return { ...target, entry };
  }

  /**
   * Apply a change to the registry as it is on disk now, not to this
   * instance's copy, while holding the registry lock, so concurrent commands
   * never drop each other's entries or retired takes.
   */
  private async update(change: (registry: Registry) => Registry): Promise<void> {
    await withRegistryLock(this.root, async () => {
      const current = await readRegistry(this.root);
      if (current.kind === "invalid") {
        throw new Error(`workspace registry became unreadable: ${current.reason}`);
      }
      const next = change(current.kind === "ok" ? current.registry : this.registry);
      await writeRegistry(this.root, next);
      this.registry = next;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
