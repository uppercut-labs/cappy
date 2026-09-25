import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/*
 * Subprocess abstraction for games, FFmpeg/ffprobe, and fixtures. Commands run
 * without a shell; arguments are passed as a list and never interpolated.
 */

const isWindows = process.platform === "win32";

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) {
      return false;
    }
    if (!isWindows) {
      await access(candidate, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command the way the OS would launch it: a path containing a
 * separator is resolved against `cwd`; a bare name is searched on PATH.
 */
export async function resolveExecutable(
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const extensions = isWindows ? ["", ...windowsExtensions(env)] : [""];
  const hasSeparator = command.includes("/") || (isWindows && command.includes("\\"));

  if (hasSeparator || path.isAbsolute(command)) {
    const base = path.resolve(options.cwd, command);
    for (const extension of extensions) {
      if (await isExecutableFile(base + extension)) {
        return base + extension;
      }
    }
    return undefined;
  }

  const searchPath = env["PATH"] ?? env["Path"] ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Windows batch files cannot be spawned directly; run them through cmd.exe. */
function spawnTarget(executable: string, args: readonly string[]): { file: string; args: string[]; verbatim: boolean } {
  if (isWindows && /\.(cmd|bat)$/i.test(executable)) {
    const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const line = [executable, ...args].map(quote).join(" ");
    return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { file: executable, args: [...args], verbatim: false };
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Cap on captured stdout/stderr, in bytes each. */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  /** Exit code, or null when the process was killed. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started at all. */
  readonly spawnError?: string;
}

/** Run a command to completion and capture bounded output. */
export function runProcess(executable: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const target = spawnTarget(executable, args);
    let child: ChildProcess;
    try {
      child = spawn(target.file, target.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: target.verbatim,
      });
    } catch (cause) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: String(cause) });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < limit) {
        out.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < limit) {
        errOut.push(chunk);
        errBytes += chunk.length;
      }
    });
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateTree(child, 0);
          }, options.timeoutMs);
    let spawnError: string | undefined;
    child.on("error", (cause: NodeJS.ErrnoException) => {
      spawnError = cause.code ?? cause.message;
    });
    child.on("close", (exitCode, signal) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString("utf8").slice(0, limit),
        stderr: Buffer.concat(errOut).toString("utf8").slice(0, limit),
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

/**
 * Terminate a child and its descendants. POSIX children are started in their
 * own process group; Windows uses `taskkill /T`.
 */
function terminateTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  if (graceMs <= 0) {
    signalGroup("SIGKILL");
    return;
  }
  signalGroup("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalGroup("SIGKILL");
    }
  }, graceMs).unref();
}

export interface ChildExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: string;
  /** Last few KiB of stderr for diagnostics. */
  readonly stderrTail: string;
}

/** A long-running child process owned by Cappy, such as a launched game. */
export class ManagedProcess {
  private stderrTail = "";
  readonly exited: Promise<ChildExit>;

  private constructor(private readonly child: ChildProcess) {
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.stdout?.resume();
    this.exited = new Promise((resolve) => {
      let spawnError: string | undefined;
      child.on("error", (cause: NodeJS.ErrnoException) => {
        spawnError = cause.code ?? cause.message;
        // A process that never started may not emit "close".
        if (child.pid === undefined) {
          resolve({ exitCode: null, signal: null, stderrTail: this.stderrTail, spawnError });
        }
      });
      child.on("close", (exitCode, signal) => {
        resolve({ exitCode, signal, stderrTail: this.stderrTail, ...(spawnError === undefined ? {} : { spawnError }) });
      });
    });
  }

  static start(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ManagedProcess {
    const target = spawnTarget(executable, args);
    const child = spawn(target.file, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
    });
    return new ManagedProcess(child);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined;
  }

  /**
   * Stop the process tree: wait `graceMs` for a voluntary exit, then signal,
   * then force-kill.
   */
  async stop(graceMs = 2_000): Promise<ChildExit> {
    if (this.running) {
      const voluntary = await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs).unref()),
      ]);
      if (!voluntary) {
        terminateTree(this.child, graceMs);
      }
    }
    return this.exited;
  }
}
