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
import { type ScenariosReport, scenarios } from "./commands/scenarios.js";
import type { CliIO, CommandContext } from "./context.js";
import { renderDoctor, renderError, renderScenarios } from "./render.js";

export const HELP = `Usage: cappy <command> [options]

Commands:
  doctor               Check configuration, workspace, game command, FFmpeg, and OBS without capturing
  scenarios            Launch the game and list the scenarios its adapter registers

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
};

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
  if (command === undefined || positionals.length > 1) {
    const message = command === undefined ? `unknown command "${name}"` : `unexpected argument "${positionals[1] ?? ""}"`;
    return emit(commandFailure(name, cappyError("USAGE_INVALID", message, "cli", { details: { hint: "run cappy --help" } })), "");
  }

  const context: CommandContext = {
    projectDir: path.resolve(io.cwd, values.project ?? "."),
    ...(values.config === undefined ? {} : { configPath: values.config }),
    env: io.env,
    correlationId: newCorrelationId(),
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
