/**
 * Every CLI flag with its whole-token shorthand (SPEC 11.1, ADR-016). A
 * multi-word flag's shorthand is its initials; a one-word flag's is its first
 * letter, or its first two letters when the first letter is taken.
 */
export const FLAGS = {
  json: { type: "boolean", short: "j" },
  project: { type: "string", short: "C" },
  config: { type: "string", short: "c" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  preset: { type: "string", short: "p" },
  param: { type: "string", short: "pa", multiple: true },
  take: { type: "string", short: "t" },
  capture: { type: "boolean", short: "ca" },
  "no-capture": { type: "boolean", short: "nc" },
  duration: { type: "string", short: "d" },
  "dry-run": { type: "boolean", short: "dr" },
  failed: { type: "boolean", short: "f" },
  "older-than": { type: "string", short: "ot" },
  logs: { type: "boolean", short: "l" },
  all: { type: "boolean", short: "a" },
  "min-ssim": { type: "string", short: "ms" },
  "min-frame-ssim": { type: "string", short: "mfs" },
  "max-drift-ms": { type: "string", short: "mdm" },
  "require-same-events": { type: "boolean", short: "rse" },
  build: { type: "string", short: "b" },
  format: { type: "string", short: "fo" },
  out: { type: "string", short: "o" },
} as const satisfies Record<string, FlagSpec>;

export interface FlagSpec {
  readonly type: "boolean" | "string";
  readonly short: string;
  readonly multiple?: boolean;
}

/** Shorthands that predate the initials rule and are kept deliberately. */
export const SHORTHAND_EXCEPTIONS: Readonly<Record<string, string>> = { project: "C" };

export type FlagName = keyof typeof FLAGS;

type ParseOptions = {
  [K in FlagName]: (typeof FLAGS)[K] extends { multiple: true }
    ? { type: (typeof FLAGS)[K]["type"]; multiple: true }
    : { type: (typeof FLAGS)[K]["type"] };
};

/** `parseArgs` options for every flag. Shorthands are translated beforehand, so none are declared here. */
export function parseOptions(): ParseOptions {
  return Object.fromEntries(
    Object.entries(FLAGS).map(([name, spec]) => [name, "multiple" in spec ? { type: spec.type, multiple: true } : { type: spec.type }]),
  ) as ParseOptions;
}

const BY_SHORT = new Map<string, string>(Object.entries(FLAGS).map(([name, spec]) => [spec.short, name]));
const SHORTHAND = /^-[A-Za-z]+$/;

export type Translation = { ok: true; args: string[] } | { ok: false; token: string };

/**
 * Replace each shorthand token with its long flag. A shorthand is always one
 * whole token (`-nc` is never `-n -c`), and an option's value is passed
 * through untouched even when it starts with `-`: such a value is joined to
 * its flag (`--preset=-x`) so strict parsing reads it as the value.
 */
export function translateShorthands(argv: readonly string[]): Translation {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      args.push(...argv.slice(index));
      break;
    }
    let long: string | undefined;
    if (SHORTHAND.test(token)) {
      long = BY_SHORT.get(token.slice(1));
      if (long === undefined) {
        return { ok: false, token };
      }
    } else if (token.startsWith("--") && !token.includes("=")) {
      long = token.slice(2);
    } else {
      args.push(token);
      continue;
    }
    const value = argv[index + 1];
    if ((FLAGS as Record<string, FlagSpec>)[long]?.type === "string" && value !== undefined) {
      args.push(value.startsWith("-") ? `--${long}=${value}` : `--${long}`, ...(value.startsWith("-") ? [] : [value]));
      index += 1;
    } else {
      args.push(`--${long}`);
    }
  }
  return { ok: true, args };
}
