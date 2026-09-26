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
import { type CleanReport, clean } from "./commands/clean.js";
import { type CompareBuildsReport, compareBuilds } from "./commands/compare-builds.js";
import { type CompareReport, compare } from "./commands/compare.js";
import { type TimelineExportReport, timeline } from "./commands/timeline.js";
import { type DoctorReport, doctor } from "./commands/doctor.js";
import { type RecordReport, record } from "./commands/record.js";
import { type ReplayReport, replay } from "./commands/replay.js";
import { type RunReport, run } from "./commands/run.js";
import { type ScenariosReport, scenarios } from "./commands/scenarios.js";
import { type CliIO, type CommandContext, noInterrupts } from "./context.js";
import { parseOptions, translateShorthands } from "./flags.js";
import { renderClean, renderCompare, renderCompareBuilds, renderDoctor, renderError, renderRecord, renderReplay, renderRun, renderScenarios } from "./render.js";

export const HELP = `Usage: cappy <command> [options]

Commands:
  doctor               Check configuration, workspace, game command, FFmpeg, and OBS without capturing
  scenarios            Launch the game and list the scenarios its adapter registers
  run <scenario>       Capture an authored scenario with OBS, FFmpeg derivatives, and a manifest
  record               Record a freeform, replayable session (Enter stops, Ctrl+C cancels)
  replay <session-id>  Capture a stored session's replay (or --no-capture to only play it)
  compare <a> <b>      Compare two captures of the same source: triptych video and SSIM/PSNR
  compare-builds <session|scenario> <build-a> <build-b>
                       Capture one session or scenario with two named builds, then compare them
  timeline export <id> Export a capture's or session's timeline as JSON, CSV, or WebVTT
  clean [<id>...]      Delete captures, sessions, comparisons, or logs Cappy created (--dry-run previews)

Command options:
  -b,  --build <name>        run, replay, record, scenarios: launch a named build from builds (base = game)
  -pa, --param <key=value>   run: scenario parameter (repeatable)
  -p,  --preset <name>       run, replay, record --capture: capture preset (default: defaultPreset)
  -t,  --take <n>            run, replay: explicit take number; never overwrites an existing take
  -ca, --capture             record: also record an OBS master
  -d,  --duration <seconds>  record: stop automatically after this many seconds
  -nc, --no-capture          replay: verify playback without recording video
  -f,  --failed              clean: failed, cancelled, and interrupted captures and sessions
  -ot, --older-than <age>    clean: only items older than an age such as 90m, 12h, 7d, 2w
  -l,  --logs                clean: command logs
  -a,  --all                 clean: every capture, session, comparison, and log
  -ms, --min-ssim <score>    compare: regress (exit 1) when the mean SSIM is below a score from 0 to 1
  -mfs, --min-frame-ssim <score>  compare: regress when any single frame's SSIM is below the score
  -mdm, --max-drift-ms <ms>  compare: regress when a matched game event drifts more than ms
  -rse, --require-same-events  compare: regress when any game event type occurs a different number of times
  -fo, --format <format>     timeline export: json (default), csv, or vtt
  -o,  --out <path>          timeline export: write a new file instead of standard output
  -dr, --dry-run             clean: report what would be removed without deleting anything

Options:
  -j,  --json                Print exactly one structured JSON result on stdout
  -C,  --project <dir>       Project directory (default: current directory)
  -c,  --config <path>       Configuration file, relative to the project (default: cappy.config.json)
  -h,  --help                Show this help
  -v,  --version             Show the Cappy version

Shorthands are whole tokens: -nc is --no-capture, never -n -c.

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
  clean: {
    run: clean,
    render: (result) => renderClean(result as CommandResult<CleanReport>),
  } as Command<unknown>,
  compare: {
    run: compare,
    render: (result) => renderCompare(result as CommandResult<CompareReport>),
  } as Command<unknown>,
  timeline: {
    run: timeline,
    render: (result) => (result.ok ? ((result.data as TimelineExportReport).content ?? `Wrote ${(result.data as TimelineExportReport).events} event(s) to ${(result.data as TimelineExportReport).path ?? ""}\n`) : ""),
  } as Command<unknown>,
  "compare-builds": {
    run: compareBuilds,
    render: (result) => renderCompareBuilds(result as CommandResult<CompareBuildsReport>),
  } as Command<unknown>,
};

/** Commands that take positional arguments after their name. */
const TAKES_ARGUMENTS = new Set(["replay", "run", "clean", "compare", "compare-builds", "timeline"]);

/** Run the CLI in-process and return the exit code. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const translated = translateShorthands(argv);
  // Judged after translation, so a value such as `--config -j` is not mistaken for the flag.
  const json = translated.ok ? translated.args.includes("--json") : argv.includes("--json") || argv.includes("-j");
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

  if (!translated.ok) {
    const error = cappyError("USAGE_INVALID", `unknown option "${translated.token}"`, "cli", { details: { hint: "run cappy --help" } });
    return emit(commandFailure("cli", error), "");
  }
  let parsed;
  try {
    parsed = parseArgs({ args: translated.args, allowPositionals: true, strict: true, options: parseOptions() });
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
    flags: values,
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
