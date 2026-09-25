/** Operator requests that end a long-running command. */
export interface Interrupts {
  /** Finish normally, such as stopping a freeform recording. */
  readonly stop: Promise<void>;
  /** Abort; the operation ends cancelled, never successful. */
  readonly cancel: Promise<void>;
  dispose(): void;
}

/** What every command receives from the CLI shell. */
export interface CommandContext {
  readonly projectDir: string;
  /** Explicit config path from `--config`, relative to the project. */
  readonly configPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly correlationId: string;
  /** Command arguments after the command name. */
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | undefined>>;
  /** Human progress messages; silent in JSON mode. */
  progress(text: string): void;
  /** Start listening for stop/cancel requests. */
  listenForInterrupts(): Interrupts;
}

/** Output sinks and operator input, injectable so the CLI can run in-process under test. */
export interface CliIO {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  write(text: string): void;
  writeError(text: string): void;
  listenForInterrupts?(): Interrupts;
}

/** Interrupts that never fire, for non-interactive use. */
export function noInterrupts(): Interrupts {
  const never = new Promise<void>(() => undefined);
  return { stop: never, cancel: never, dispose: () => undefined };
}
