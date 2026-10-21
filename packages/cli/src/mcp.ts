import { lstat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CAPPY_VERSION, type CommandResult, cappyError, commandFailure, commandSuccess, loadConfig, newCorrelationId, serializeCommandResult } from "@uppercut-labs/cappy-internal-core";
import { ManagedWorkspace, resolveWorkspaceRoot } from "@uppercut-labs/cappy-internal-workspace";
import { z } from "zod";
import { clean } from "./commands/clean.js";
import { compare } from "./commands/compare.js";
import { compareBuilds } from "./commands/compare-builds.js";
import { doctor } from "./commands/doctor.js";
import { record } from "./commands/record.js";
import { replay } from "./commands/replay.js";
import { run } from "./commands/run.js";
import { scenarios } from "./commands/scenarios.js";
import { timeline } from "./commands/timeline.js";
import type { CommandContext, Interrupts } from "./context.js";
import { readInventory } from "./inventory.js";

export interface LocalMcpOptions {
  readonly projectDir: string;
  readonly configPath?: string;
  readonly env: NodeJS.ProcessEnv;
  /** Diagnostic output must go to stderr, never the JSON-RPC stdout stream. */
  progress?(text: string): void;
}

const name = z.string().min(1);
const captureOptions = { build: name.optional(), preset: name.optional(), take: z.int().positive().optional() };
const parameters = z.record(z.string().min(1), z.union([z.string(), z.number().finite(), z.boolean()])).optional();
const gates = {
  minSsim: z.number().min(0).max(1).optional(),
  minFrameSsim: z.number().min(0).max(1).optional(),
  maxDriftMs: z.number().nonnegative().optional(),
  requireSameEvents: z.boolean().optional(),
};

/** Translate the typed tool input into the existing command's flag contract. */
function flags(input: Record<string, unknown>): CommandContext["flags"] {
  const names: Record<string, string> = {
    noCapture: "no-capture", durationSeconds: "duration", minSsim: "min-ssim", minFrameSsim: "min-frame-ssim",
    maxDriftMs: "max-drift-ms", requireSameEvents: "require-same-events", olderThan: "older-than",
  };
  const mapped: Record<string, string | boolean | readonly string[] | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "parameters") {
      const parsed = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(value);
      mapped["param"] = Object.entries(parsed).map(([parameter, entry]) => `${parameter}=${entry}`);
    } else if (typeof value === "string" || typeof value === "boolean") {
      mapped[names[key] ?? key] = value;
    } else if (typeof value === "number") {
      mapped[names[key] ?? key] = String(value);
    }
  }
  return mapped;
}

function toolResult(result: CommandResult<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: serializeCommandResult(result) }],
    structuredContent: { ...result },
    isError: !result.ok,
  };
}

/** Read managed IDs without creating a workspace when none exists. */
async function inventory(context: CommandContext): Promise<CommandResult<unknown>> {
  const options = { correlationId: context.correlationId };
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure("inventory", loaded.error, options);
  }
  const { root } = resolveWorkspaceRoot(loaded.value.projectDir, loaded.value.config);
  try {
    await lstat(root);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return commandSuccess("inventory", { items: [] }, options);
    }
    throw cause;
  }
  const opened = await ManagedWorkspace.open({ projectDir: loaded.value.projectDir, config: loaded.value.config, readOnly: true });
  if (!opened.ok) {
    return commandFailure("inventory", opened.error, options);
  }
  const items = await readInventory(opened.value);
  const kind = context.flags["kind"];
  return commandSuccess("inventory", {
    items: items.filter((item) => kind === undefined || item.kind === kind).map((item) => ({
      id: item.id, kind: item.kind, createdAt: item.createdAt.toISOString(),
      ...(item.kind === "log" ? {} : { record: item.record }),
      files: item.files.map((file) => ({ path: file.path, bytes: file.entry.bytes })),
    })),
  }, options);
}

export interface LocalMcp {
  readonly server: McpServer;
  /** Cancel active capture work and wait for its existing cleanup before returning. */
  close(): Promise<void>;
}

/** Build an isolated stdio-compatible server; transport selection stays with the caller. */
export function createLocalMcp(options: LocalMcpOptions): LocalMcp {
  const server = new McpServer({ name: "cappy", version: CAPPY_VERSION }, {
    instructions: "Cappy controls this server's configured local project. Run cappy_doctor first, then discover scenarios or inventory IDs. Recording launches the configured game and may use OBS. Hosted guidance cannot capture a visitor's machine. Clean previews by default; deletion requires cappy_delete with confirmDelete=true. Only one tool operation can run at a time. Cancel a request to cancel an active recording and wait for cleanup.",
  });
  let closed = false;
  let active: { cancel(): void; completion: Promise<void> } | undefined;

  const execute = async (
    command: string,
    operation: (context: CommandContext) => Promise<CommandResult<unknown>>,
    input: Record<string, unknown>,
    positionals: readonly string[],
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    const correlationId = newCorrelationId();
    if (closed || active !== undefined) {
      return toolResult(commandFailure(command, cappyError("OPERATION_BUSY", closed ? "the MCP server is shutting down" : "another Cappy tool is running; wait for it to finish or cancel it", command, { retryable: !closed }), { correlationId }));
    }
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    const cancelled = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => (complete = resolve));
    active = { cancel, completion };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
    const interrupts: Interrupts = { stop: new Promise<void>(() => undefined), cancel: cancelled, dispose: () => undefined };
    const context: CommandContext = {
      projectDir: options.projectDir,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      env: options.env, correlationId, positionals, flags: flags(input), signal: controller.signal,
      progress: (text) => options.progress?.(text),
      listenForInterrupts: () => interrupts,
    };
    try {
      if (signal.aborted) {
        return toolResult(commandFailure(command, cappyError("OPERATION_CANCELLED", "request cancelled before starting", command), { correlationId }));
      }
      const result = await operation(context);
      if (controller.signal.aborted && result.ok) {
        return toolResult(commandFailure(command, cappyError("OPERATION_CANCELLED", "request cancelled; completed artifacts, if any, are included", command), { correlationId, data: result.data, warnings: result.warnings }));
      }
      return toolResult(result);
    } catch (cause) {
      return toolResult(commandFailure(command, cappyError("INTERNAL_ERROR", `unexpected failure: ${cause instanceof Error ? cause.message : String(cause)}`, command), { correlationId }));
    } finally {
      signal.removeEventListener("abort", cancel);
      active = undefined;
      complete();
    }
  };

  const annotations = (readOnlyHint = false, destructiveHint = false, openWorldHint = true) => ({ readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint });
  server.registerTool("cappy_doctor", {
    description: "Check this project's configuration, game, workspace, FFmpeg, and OBS. May initialize the managed workspace; does not launch the game or capture.",
    inputSchema: z.object({}).strict(), annotations: annotations(),
  }, (_input, extra) => execute("doctor", doctor, {}, [], extra.signal));
  server.registerTool("cappy_scenarios", {
    description: "Launch the configured local game, list its adapter's authored scenarios, then close the game. Records nothing.",
    inputSchema: z.object({ build: name.optional() }).strict(), annotations: annotations(),
  }, (input, extra) => execute("scenarios", scenarios, input, [], extra.signal));
  server.registerTool("cappy_inventory", {
    description: "List managed capture, session, comparison, and log IDs and their files. An empty workspace returns an empty list without creating files.",
    inputSchema: z.object({ kind: z.enum(["capture", "session", "comparison", "log"]).optional() }).strict(), annotations: annotations(true, false, false),
  }, (input, extra) => execute("inventory", inventory, input, [], extra.signal));
  server.registerTool("cappy_run", {
    description: "Capture an authored scenario using the configured local game and OBS; create derivatives and a manifest. Use cappy_scenarios to discover scenario IDs.",
    inputSchema: z.object({ scenario: name, parameters, ...captureOptions }).strict(), annotations: annotations(),
  }, ({ scenario, ...input }, extra) => execute("run", run, input, [scenario], extra.signal));
  server.registerTool("cappy_record", {
    description: "Launch the game and record a replayable freeform session for a bounded duration (0.001 to 3600 seconds). Set capture to also create an OBS master. Cancel the request to abort.",
    inputSchema: z.object({ durationSeconds: z.number().min(0.001).max(3600), capture: z.boolean().optional(), build: name.optional(), preset: name.optional() }).strict(), annotations: annotations(),
  }, (input, extra) => execute("record", record, input, [], extra.signal));
  server.registerTool("cappy_replay", {
    description: "Replay a stored session in the local game and capture it through OBS, or set noCapture to verify playback without video.",
    inputSchema: z.object({ sessionId: name, noCapture: z.boolean().optional(), ...captureOptions }).strict(), annotations: annotations(),
  }, ({ sessionId, ...input }, extra) => execute("replay", replay, input, [sessionId], extra.signal));
  server.registerTool("cappy_compare", {
    description: "Compare two compatible captures, write a triptych and SSIM/PSNR report, and evaluate optional regression gates. A regressed comparison returns isError with its report.",
    inputSchema: z.object({ captureA: name, captureB: name, ...gates }).strict(), annotations: annotations(false, false, false),
  }, ({ captureA, captureB, ...input }, extra) => execute("compare", compare, input, [captureA, captureB], extra.signal));
  server.registerTool("cappy_compare_builds", {
    description: "Capture a scenario or stored session with two configured named builds (base means the default game), then compare the results and optional regression gates.",
    inputSchema: z.object({ source: name, buildA: name, buildB: name, preset: name.optional(), parameters, ...gates }).strict(), annotations: annotations(),
  }, ({ source, buildA, buildB, ...input }, extra) => execute("compare-builds", compareBuilds, input, [source, buildA, buildB], extra.signal));
  server.registerTool("cappy_timeline", {
    description: "Read a capture or session timeline as JSON, CSV, or WebVTT. Returns the content without writing an export file.",
    inputSchema: z.object({ id: name, format: z.enum(["json", "csv", "vtt"]).optional() }).strict(), annotations: annotations(true, false, false),
  }, ({ id, ...input }, extra) => execute("timeline", timeline, input, ["export", id], extra.signal));
  const selectors = { ids: z.array(name).optional(), failed: z.boolean().optional(), logs: z.boolean().optional(), all: z.boolean().optional(), olderThan: z.string().regex(/^[1-9][0-9]*[mhdw]$/).optional() };
  server.registerTool("cappy_clean", {
    description: "Preview cleanup of selected managed items and report protected or modified files. Always a dry run; use cappy_delete only after reviewing this report.",
    inputSchema: z.object(selectors).strict(), annotations: annotations(true, false, false),
  }, ({ ids, ...input }, extra) => execute("clean", clean, { ...input, "dry-run": true }, ids ?? [], extra.signal));
  server.registerTool("cappy_delete", {
    description: "Delete the selected Cappy-managed items immediately. Requires explicit confirmDelete=true; preview the same selection with cappy_clean first. Unmanaged or modified files remain protected.",
    inputSchema: z.object({ ...selectors, confirmDelete: z.literal(true) }).strict(), annotations: annotations(false, true, false),
  }, ({ ids, confirmDelete: _confirmed, ...input }, extra) => execute("clean", clean, input, ids ?? [], extra.signal));

  server.server.onclose = () => {
    closed = true;
    active?.cancel();
  };
  return {
    server,
    async close() {
      closed = true;
      const running = active;
      running?.cancel();
      await running?.completion;
      await server.close();
    },
  };
}

/** Own stdio and process signals without installing a readline consumer on MCP stdin. */
export async function serveLocalMcp(options: LocalMcpOptions): Promise<number> {
  const local = createLocalMcp(options);
  const transport = new StdioServerTransport();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let shuttingDown = false;
  let exitCode = 0;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void local.close().then(finish, (cause: unknown) => {
      options.progress?.(`Cappy MCP shutdown failed: ${String(cause)}\n`);
      exitCode = 70;
      finish();
    });
  };
  const disconnected = local.server.server.onclose;
  local.server.server.onclose = () => {
    disconnected?.();
    shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  try {
    await local.server.connect(transport);
    await finished;
    return exitCode;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.stdin.off("end", shutdown);
  }
}
