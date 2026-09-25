import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { boundDetails } from "@cappy/core";
import type { ManagedWorkspace } from "@cappy/workspace";

export interface LogEntry {
  readonly at: string;
  readonly correlationId: string;
  readonly event: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Structured diagnostic log for one command, written to
 * `logs/<correlationId>.jsonl`. Entries carry only codes, IDs, paths, and
 * states that callers pass explicitly; never environment values or replay
 * contents.
 */
export class CommandLog {
  private readonly entries: LogEntry[] = [];

  constructor(readonly correlationId: string) {}

  record(event: string, details?: Record<string, unknown>): void {
    this.entries.push({
      at: new Date().toISOString(),
      correlationId: this.correlationId,
      event,
      ...(details === undefined ? {} : { details: boundDetails(details) }),
    });
  }

  get path(): string {
    return `logs/${this.correlationId}.jsonl`;
  }

  async flush(workspace: ManagedWorkspace): Promise<void> {
    if (this.entries.length === 0) {
      return;
    }
    await workspace.writeManaged(this.path, `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { role: "log" });
  }
}

interface RunLock {
  readonly correlationId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
}

/** Directory of run locks: one file per in-flight command that may leave active state behind. */
function lockDirectory(workspace: ManagedWorkspace): string {
  return path.join(workspace.area("cache"), "running");
}

/**
 * Mark a command as running so a later command can tell a crash from work in
 * progress. Locks are transient, unregistered bookkeeping inside the managed
 * cache; each command removes its own.
 */
export async function acquireRunLock(workspace: ManagedWorkspace, correlationId: string): Promise<() => Promise<void>> {
  const directory = lockDirectory(workspace);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${correlationId}.json`);
  const lock: RunLock = { correlationId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(lock), { flag: "wx" });
  return () => unlink(file).catch(() => undefined);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Correlation IDs of commands on this host that are still running. */
export async function liveCorrelationIds(workspace: ManagedWorkspace): Promise<Set<string>> {
  const directory = lockDirectory(workspace);
  const live = new Set<string>();
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(directory, name);
    try {
      const lock = JSON.parse(await readFile(file, "utf8")) as RunLock;
      // A lock from another host cannot be checked; treat it as live.
      if (lock.host !== hostname() || alive(lock.pid)) {
        live.add(lock.correlationId);
      } else {
        await unlink(file).catch(() => undefined);
      }
    } catch {
      // Unreadable lock: leave it for inspection and do not reconcile against it.
      live.add(name.slice(0, -".json".length));
    }
  }
  return live;
}
