/**
 * Structured errors shared by every Cappy operation. Codes are stable
 * machine-readable identifiers; messages are for humans.
 */

/** How a failure maps onto the CLI's stable exit behavior. */
export type ErrorCategory = "usage" | "configuration" | "dependency" | "operation" | "cancelled" | "internal";

export const ERROR_CODES = {
  USAGE_INVALID: "usage",
  CONFIG_NOT_FOUND: "configuration",
  CONFIG_UNREADABLE: "configuration",
  CONFIG_PARSE_ERROR: "configuration",
  CONFIG_INVALID: "configuration",
  WORKSPACE_UNAVAILABLE: "operation",
  WORKSPACE_REGISTRY_INVALID: "operation",
  WORKSPACE_PATH_REJECTED: "operation",
  WORKSPACE_TARGET_EXISTS: "operation",
  WORKSPACE_WRITE_FAILED: "operation",
  LISTENER_NOT_LOOPBACK: "configuration",
  LISTENER_FAILED: "operation",
  ADAPTER_CONNECT_TIMEOUT: "operation",
  ADAPTER_DISCONNECTED: "operation",
  ADAPTER_UNRESPONSIVE: "operation",
  ADAPTER_OPERATION_FAILED: "operation",
  PROTOCOL_VERSION_INCOMPATIBLE: "operation",
  PROTOCOL_INVALID_MESSAGE: "operation",
  PROTOCOL_OUT_OF_STATE: "operation",
  CAPABILITY_MISSING: "operation",
  SCENARIO_NOT_FOUND: "operation",
  OPERATION_BUSY: "operation",
  OPERATION_TIMEOUT: "operation",
  OPERATION_CANCELLED: "cancelled",
  GAME_LAUNCH_FAILED: "dependency",
  GAME_EXITED: "operation",
  TOOL_NOT_FOUND: "dependency",
  TOOL_FAILED: "dependency",
  OBS_SECRET_MISSING: "configuration",
  OBS_UNREACHABLE: "dependency",
  OBS_AUTH_FAILED: "dependency",
  OBS_REQUEST_FAILED: "operation",
  OBS_SCENE_MISSING: "dependency",
  DOCTOR_CHECKS_FAILED: "dependency",
  SESSION_NOT_FOUND: "usage",
  SESSION_INVALID: "operation",
  SESSION_NOT_REPLAYABLE: "operation",
  REPLAY_PAYLOAD_MISSING: "operation",
  REPLAY_PAYLOAD_INVALID: "operation",
  REPLAY_INCOMPATIBLE: "operation",
  OBS_NOT_CONFIGURED: "configuration",
  OBS_ALREADY_RECORDING: "operation",
  OBS_START_FAILED: "operation",
  OBS_STOP_FAILED: "operation",
  MASTER_MISSING: "operation",
  MASTER_INVALID: "operation",
  PRESET_NOT_FOUND: "usage",
  PARAMETER_INVALID: "usage",
  MEDIA_PROBE_FAILED: "operation",
  DERIVATIVE_OPTIONS_INVALID: "configuration",
  DERIVATIVE_FAILED: "operation",
  DERIVATIVE_ANCHOR_UNRESOLVED: "operation",
  DERIVATIVE_WINDOW_EMPTY: "operation",
  MANIFEST_INVALID: "internal",
  TAKE_EXISTS: "usage",
  CLEAN_INCOMPLETE: "operation",
  CAPTURE_NOT_FOUND: "usage",
  COMPARE_INCOMPATIBLE: "operation",
  COMPARE_INPUT_INVALID: "operation",
  COMPARISON_FAILED: "operation",
  COMPARISON_REGRESSED: "operation",
  INTERNAL_ERROR: "internal",
} as const satisfies Record<string, ErrorCategory>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface CappyError {
  readonly code: ErrorCode;
  readonly message: string;
  /** The operation or command that failed, such as `config.load` or `doctor`. */
  readonly operation: string;
  /** Bounded, secret-free diagnostic details. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Whether retrying is plausibly useful, when known. */
  readonly retryable?: boolean;
}

export function categoryOf(code: ErrorCode): ErrorCategory {
  return ERROR_CODES[code];
}

export function cappyError(
  code: ErrorCode,
  message: string,
  operation: string,
  options: { details?: Record<string, unknown>; retryable?: boolean } = {},
): CappyError {
  return {
    code,
    message,
    operation,
    ...(options.details === undefined ? {} : { details: boundDetails(options.details) }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
}

const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

/**
 * Keep error details bounded so JSON results stay small and predictable:
 * long strings are truncated, long arrays and objects are cut, and deep
 * nesting is collapsed.
 */
export function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
  return boundValue(details, 0) as Record<string, unknown>;
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" ? String(value) : value;
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => boundValue(item, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…[${value.length - MAX_ITEMS} more]`] : items;
  }
  const entries = Object.entries(value);
  const bounded: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
    bounded[key] = boundValue(item, depth + 1);
  }
  if (entries.length > MAX_ITEMS) {
    bounded["…"] = `${entries.length - MAX_ITEMS} more keys`;
  }
  return bounded;
}
