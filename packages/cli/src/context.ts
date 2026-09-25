/** What every command receives from the CLI shell. */
export interface CommandContext {
  readonly projectDir: string;
  /** Explicit config path from `--config`, relative to the project. */
  readonly configPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly correlationId: string;
}

/** Output sinks, injectable so the CLI can run in-process under test. */
export interface CliIO {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  write(text: string): void;
  writeError(text: string): void;
}
