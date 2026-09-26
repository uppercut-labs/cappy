import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { capabilityNameSchema } from "./capabilities.js";
import { type CappyError, cappyError } from "./errors.js";
import { type Result, err, ok } from "./result.js";

export const CONFIG_FILENAME = "cappy.config.json";
export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_WORKSPACE_DIR = ".cappy";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "use 1-64 lowercase letters, digits, '-' or '_'");

const nonEmpty = z.string().trim().min(1);

const gameSchema = z.strictObject({
  command: nonEmpty,
  args: z.array(z.string()).default([]),
  cwd: nonEmpty.optional(),
});

/** A named build overrides these fields of the base `game` (SPEC 6, ADR-019). */
const gameOverrideSchema = z.strictObject({
  command: nonEmpty.optional(),
  args: z.array(z.string()).optional(),
  cwd: nonEmpty.optional(),
});

/** The build name that always means the base `game`. */
export const BASE_BUILD = "base";

const adapterSchema = z.strictObject({
  host: z
    .string()
    .refine((host) => (LOOPBACK_HOSTS as readonly string[]).includes(host), {
      message: `the adapter listener must bind to loopback (${LOOPBACK_HOSTS.join(", ")})`,
    })
    .default("127.0.0.1"),
  /** Port for the adapter listener; 0 picks a free port for each launch. */
  port: z.int().min(0).max(65535),
  expectedAdapter: nonEmpty.optional(),
  requiredCapabilities: z.array(capabilityNameSchema).default([]),
});

const workspaceSchema = z.strictObject({
  /** Overrides the default project-local `.cappy/` managed root. */
  root: nonEmpty.optional(),
});

const obsSchema = z.strictObject({
  url: z
    .string()
    .regex(/^wss?:\/\//, "use a ws:// or wss:// URL")
    .default("ws://127.0.0.1:4455"),
  /** Name of the environment variable that holds the OBS WebSocket password. */
  passwordEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "use an environment variable name")
    .optional(),
  password: z
    .never({ error: "do not store the OBS password in config; set obs.passwordEnv to an environment variable name" })
    .optional(),
  scene: nonEmpty.optional(),
  /** Switch OBS to `scene` before recording. Off unless explicitly enabled. */
  switchScene: z.boolean().default(false),
});

const toolsSchema = z.strictObject({
  ffmpeg: nonEmpty.optional(),
  ffprobe: nonEmpty.optional(),
});

export const DERIVATIVE_KINDS = ["mp4", "clip", "thumbnail", "still"] as const;

const derivativeSchema = z.strictObject({
  kind: z.enum(DERIVATIVE_KINDS),
  /** Role recorded in the manifest, unique within a preset. */
  role: idSchema,
  required: z.boolean().default(true),
  /** Kind-specific options interpreted by the media pipeline. */
  options: z.record(z.string(), z.unknown()).default({}),
});

const presetSchema = z
  .strictObject({
    scene: nonEmpty.optional(),
    derivatives: z.array(derivativeSchema).default([]),
    requiredCapabilities: z.array(capabilityNameSchema).default([]),
    /** Game-side presentation parameters, passed only when the adapter supports them. */
    presentation: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((preset, ctx) => {
    const { timeScale, camera } = preset.presentation;
    if (timeScale !== undefined && (typeof timeScale !== "number" || !Number.isFinite(timeScale) || timeScale < 0.1 || timeScale > 4)) {
      ctx.addIssue({ code: "custom", path: ["presentation", "timeScale"], message: "use a number from 0.1 to 4 (0.5 is half speed)" });
    }
    if (camera !== undefined && (typeof camera !== "string" || camera.trim() === "")) {
      ctx.addIssue({ code: "custom", path: ["presentation", "camera"], message: "use an adapter-defined camera name" });
    }
    const seen = new Set<string>();
    preset.derivatives.forEach((derivative, index) => {
      if (seen.has(derivative.role)) {
        ctx.addIssue({ code: "custom", path: ["derivatives", index, "role"], message: `duplicate role "${derivative.role}"` });
      }
      seen.add(derivative.role);
    });
  });

const timeoutsSchema = z.strictObject({
  connectMs: z.int().positive().default(30_000),
  readyMs: z.int().positive().default(60_000),
  obsMs: z.int().positive().default(10_000),
  processMs: z.int().positive().default(300_000),
});

export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    project: z.strictObject({ id: idSchema, name: nonEmpty }),
    game: gameSchema,
    adapter: adapterSchema,
    workspace: workspaceSchema.default({}),
    obs: obsSchema.optional(),
    tools: toolsSchema.default({}),
    presets: z.record(idSchema, presetSchema).default({}),
    /** Named game launch overrides, selected with `--build <name>`. */
    builds: z.record(idSchema, z.strictObject({ game: gameOverrideSchema })).default({}),
    defaultPreset: idSchema.optional(),
    timeouts: timeoutsSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.defaultPreset !== undefined && !(config.defaultPreset in config.presets)) {
      ctx.addIssue({ code: "custom", path: ["defaultPreset"], message: `preset "${config.defaultPreset}" is not defined` });
    }
    if (BASE_BUILD in config.builds) {
      ctx.addIssue({ code: "custom", path: ["builds", BASE_BUILD], message: `"${BASE_BUILD}" is reserved for the base game and cannot name a build` });
    }
  });

export type CappyConfig = z.output<typeof configSchema>;
export type CappyConfigInput = z.input<typeof configSchema>;
export type CapturePreset = CappyConfig["presets"][string];
export type DerivativeSpec = CapturePreset["derivatives"][number];

export interface ConfigIssue {
  /** Dotted path to the offending field, such as `adapter.port`. */
  readonly path: string;
  readonly message: string;
}

export interface LoadedConfig {
  readonly config: CappyConfig;
  readonly configPath: string;
  readonly projectDir: string;
}

function formatPath(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) {
    return "(root)";
  }
  return segments
    .map((segment, index) => (typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`))
    .join("");
}

/**
 * The configuration to launch a named build with: the base `game`, with each
 * field the build gives replacing the base's. No name, or `base`, is the base
 * game unchanged.
 */
export function selectBuild(config: CappyConfig, name: string | undefined): Result<CappyConfig> {
  if (name === undefined || name === BASE_BUILD) {
    return ok(config);
  }
  const build = config.builds[name];
  if (build === undefined) {
    return err(
      cappyError("BUILD_NOT_FOUND", `build "${name}" is not defined in builds`, "config.build", {
        details: { build: name, available: [BASE_BUILD, ...Object.keys(config.builds)] },
        retryable: false,
      }),
    );
  }
  return ok({ ...config, game: { ...config.game, ...build.game } });
}

/** Validate an already-parsed configuration object. */
export function parseConfig(raw: unknown, source = CONFIG_FILENAME): Result<CappyConfig> {
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const issues: ConfigIssue[] = parsed.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
  return err(
    cappyError("CONFIG_INVALID", `${source} is invalid: ${issues.length} problem(s) found`, "config.load", {
      details: { source, issues },
      retryable: false,
    }),
  );
}

/**
 * Read and validate `cappy.config.json` from a project directory, or from an
 * explicit file path.
 */
export async function loadConfig(options: { projectDir: string; configPath?: string }): Promise<Result<LoadedConfig>> {
  const projectDir = path.resolve(options.projectDir);
  const configPath = path.resolve(projectDir, options.configPath ?? CONFIG_FILENAME);

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const error: CappyError =
      code === "ENOENT"
        ? cappyError("CONFIG_NOT_FOUND", `no Cappy configuration at ${configPath}`, "config.load", {
            details: { configPath },
            retryable: false,
          })
        : cappyError("CONFIG_UNREADABLE", `cannot read ${configPath}`, "config.load", {
            details: { configPath, cause: code ?? String(cause) },
          });
    return err(error);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err(
      cappyError("CONFIG_PARSE_ERROR", `${configPath} is not valid JSON`, "config.load", {
        details: { configPath, cause: (cause as Error).message },
        retryable: false,
      }),
    );
  }

  const parsed = parseConfig(raw, configPath);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({ config: parsed.value, configPath, projectDir });
}
