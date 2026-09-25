import { randomUUID } from "node:crypto";
import { type CappyError, type ErrorCategory, categoryOf } from "./errors.js";

/** A plain success/failure value for internal operations. */
export type Result<T, E = CappyError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Cappy controller version, reported by the CLI and recorded in manifests. */
export const CAPPY_VERSION = "0.1.0";

export const RESULT_SCHEMA_VERSION = 1;

interface CommandResultBase {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION;
  readonly command: string;
  readonly correlationId: string;
  readonly warnings: readonly string[];
}

/** The envelope every CLI command returns, rendered for humans or as JSON. */
export type CommandResult<T> =
  | (CommandResultBase & { readonly ok: true; readonly data: T })
  | (CommandResultBase & {
      readonly ok: false;
      readonly error: CappyError;
      /** Partial results gathered before the failure, such as doctor checks. */
      readonly data?: T;
    });

export function newCorrelationId(): string {
  return `op_${randomUUID()}`;
}

export function commandSuccess<T>(
  command: string,
  data: T,
  options: { correlationId?: string; warnings?: readonly string[] } = {},
): CommandResult<T> {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command,
    correlationId: options.correlationId ?? newCorrelationId(),
    ok: true,
    data,
    warnings: options.warnings ?? [],
  };
}

export function commandFailure<T = never>(
  command: string,
  error: CappyError,
  options: { correlationId?: string; warnings?: readonly string[]; data?: T } = {},
): CommandResult<T> {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command,
    correlationId: options.correlationId ?? newCorrelationId(),
    ok: false,
    error,
    warnings: options.warnings ?? [],
    ...(options.data === undefined ? {} : { data: options.data }),
  };
}

/** Stable process exit codes. Scripts may rely on these values. */
export const EXIT_CODES = {
  success: 0,
  operation: 1,
  usage: 2,
  configuration: 3,
  dependency: 4,
  internal: 70,
  cancelled: 130,
} as const satisfies Record<ErrorCategory | "success", number>;

export function exitCodeFor(result: CommandResult<unknown>): number {
  return result.ok ? EXIT_CODES.success : EXIT_CODES[categoryOf(result.error.code)];
}

// Matches CSI and OSC escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Serialize a result for `--json` mode: one parseable document, never ANSI. */
export function serializeCommandResult(result: CommandResult<unknown>): string {
  return JSON.stringify(result, (_key, value: unknown) => (typeof value === "string" ? stripAnsi(value) : value));
}
