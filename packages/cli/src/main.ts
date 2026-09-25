import path from "node:path";
import { parseArgs } from "node:util";
import {
  CAPPY_VERSION,
  type CommandResult,
  cappyError,
  commandFailure,
  exitCodeFor,
  newCorrelationId,
  serializeCommandResult,
} from "@cappy/core";
import { type DoctorReport, doctor } from "./commands/doctor.js";
import { type RecordReport, record } from "./commands/record.js";
import { type ReplayReport, replay } from "./commands/replay.js";
import { type RunReport, run } from "./commands/run.js";
import { type ScenariosReport, scenarios } from "./commands/scenarios.js";
import { type CliIO, type CommandContext, noInterrupts } from "./context.js";
import { renderDoctor, renderError, renderRecord, renderReplay, renderRun, renderScenarios } from "./render.js";

export const HELP = `Usage: cappy <command> [options]

Commands:
  doctor               Check configuration, workspace, game command, FFmpeg, and OBS without capturing
  scenarios            Launch the game and list the scenarios its adapter registers
  run <scenario>       Capture an authored scenario with OBS
  record               Record a freeform, replayable session (Enter stops, Ctrl+C cancels)
  replay <session-id>  Play a stored session back through the adapter

Command options:
  --param <key=value>  run: scenario parameter (repeatable)
  --preset <name>      run, record --capture: capture preset (default: defaultPreset)
  --capture            record: also record an OBS master
  --duration <seconds> record: stop automatically after this many seconds
  --no-capture         replay: verify playback without recording video

Options:
  --json               Print exactly one structured JSON result on stdout
  -C, --project <dir>  Project directory (default: current directory)
  --config <path>      Configuration file, relative to the project (default: cappy.config.json)
  -h, --help           Show this help
  --version            Show the Cappy version

Exit codes: 0 success, 1 operation failed, 2 invalid usage, 3 configuration,
4 missing dependency, 70 internal error, 130 cancelled.
`;

interface Command<T> {
  run(context: CommandContext): Promise<CommandResult<T>>;
  render(result: CommandResult<T>): string;
}

const COMMANDS: Record<string, Command<unknown>> = {
  doctor: {
    run: doctor,
    render: (result) => renderDoctor(result as CommandResult<DoctorReport>),
  } as Command<unknown>,
  scenarios: {
    run: scenarios,
    render: (result) => (result.ok ? renderScenarios(result.data as ScenariosReport) : ""),
  } as Command<unknown>,
  run: {
    run,
    render: (result) => renderRun(result as CommandResult<RunReport>),
  } as Command<unknown>,
  record: {
    run: record,
    render: (result) => renderRecord(result as CommandResult<RecordReport>),
  } as Command<unknown>,
  replay: {
    run: replay,
    render: (result) => (result.ok ? renderReplay(result.data as ReplayReport) : ""),
  } as Command<unknown>,
};

/** Commands that take positional arguments after their name. */
const TAKES_ARGUMENTS = new Set(["replay", "run"]);

/** Run the CLI in-process and return the exit code. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const json = argv.includes("--json");
  const emit = (result: CommandResult<unknown>, human: string): number => {
    if (json) {
      io.write(`${serializeCommandResult(result)}\n`);
    } else {
      if (human !== "") {
        (result.ok ? io.write : io.writeError)(human);
      }
      if (!result.ok) {
        io.writeError(renderError(result.error));
      }
      for (const warning of result.warnings) {
        io.writeError(`warning: ${warning}\n`);
      }
    }
    return exitCodeFor(result);
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        project: { type: "string", short: "C" },
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        duration: { type: "string" },
        "no-capture": { type: "boolean" },
        capture: { type: "boolean" },
        preset: { type: "string" },
        param: { type: "string", multiple: true },
      },
    });
  } catch (cause) {
    const error = cappyError("USAGE_INVALID", (cause as Error).message, "cli", { details: { hint: "run cappy --help" } });
    return emit(commandFailure("cli", error), "");
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    io.write(`${CAPPY_VERSION}\n`);
    return 0;
  }
  const name = positionals[0];
  if (values.help === true || name === undefined) {
    (name === undefined && values.help !== true ? io.writeError : io.write)(HELP);
    return name === undefined && values.help !== true ? 2 : 0;
  }
  const command = COMMANDS[name];
  if (command === undefined || (positionals.length > 1 && !TAKES_ARGUMENTS.has(name))) {
    const message = command === undefined ? `unknown command "${name}"` : `unexpected argument "${positionals[1] ?? ""}"`;
    return emit(commandFailure(name, cappyError("USAGE_INVALID", message, "cli", { details: { hint: "run cappy --help" } })), "");
  }

  const context: CommandContext = {
    projectDir: path.resolve(io.cwd, values.project ?? "."),
    ...(values.config === undefined ? {} : { configPath: values.config }),
    env: io.env,
    correlationId: newCorrelationId(),
    positionals: positionals.slice(1),
    flags: {
      duration: values.duration,
      "no-capture": values["no-capture"],
      capture: values.capture,
      preset: values.preset,
      param: values.param,
    },
    progress: (text) => {
      if (!json) {
        io.writeError(text);
      }
    },
    listenForInterrupts: () => io.listenForInterrupts?.() ?? noInterrupts(),
  };
  let result: CommandResult<unknown>;
  try {
    result = await command.run(context);
  } catch (cause) {
    result = commandFailure(
      name,
      cappyError("INTERNAL_ERROR", `unexpected failure: ${(cause as Error).message}`, name, {
        details: { stack: (cause as Error).stack ?? "" },
      }),
      { correlationId: context.correlationId },
    );
  }
  return emit(result, json ? "" : command.render(result));
}
