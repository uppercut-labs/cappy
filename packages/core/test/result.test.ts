import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  boundDetails,
  cappyError,
  commandFailure,
  commandSuccess,
  exitCodeFor,
  serializeCommandResult,
  stripAnsi,
} from "@cappy/core";

describe("command result envelope", () => {
  it("wraps successful data with a correlation ID and exit code 0", () => {
    const result = commandSuccess("doctor", { checks: [] }, { warnings: ["obs not configured"] });
    expect(result).toMatchObject({ schemaVersion: 1, command: "doctor", ok: true, warnings: ["obs not configured"] });
    expect(result.correlationId).toMatch(/^op_[0-9a-f-]{36}$/);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("maps error categories to stable non-zero exit codes", () => {
    const config = commandFailure("run", cappyError("CONFIG_INVALID", "bad", "config.load"));
    const usage = commandFailure("run", cappyError("USAGE_INVALID", "bad", "cli"));
    const internal = commandFailure("run", cappyError("INTERNAL_ERROR", "bad", "run"));
    expect(exitCodeFor(config)).toBe(EXIT_CODES.configuration);
    expect(exitCodeFor(usage)).toBe(EXIT_CODES.usage);
    expect(exitCodeFor(internal)).toBe(EXIT_CODES.internal);
    for (const result of [config, usage, internal]) {
      expect(exitCodeFor(result)).not.toBe(0);
    }
  });

  it("serializes to parseable JSON with no ANSI escape sequences", () => {
    const result = commandFailure(
      "doctor",
      cappyError("CONFIG_INVALID", "\u001b[31mred\u001b[0m failure", "config.load", {
        details: { hint: "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007" },
      }),
      { correlationId: "op_fixed" },
    );
    const json = serializeCommandResult(result);
    expect(json).not.toContain("\u001b");
    // JSON.stringify would escape a surviving ESC as the text \u001b.
    expect(json).not.toContain("\\u001b");
    expect(JSON.parse(json)).toMatchObject({
      ok: false,
      command: "doctor",
      correlationId: "op_fixed",
      error: { code: "CONFIG_INVALID", message: "red failure", operation: "config.load", details: { hint: "link" } },
    });
  });

  it("strips ANSI color codes from human text", () => {
    expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
  });
});

describe("error details", () => {
  it("bounds long strings, long arrays, and deep nesting", () => {
    const bounded = boundDetails({
      long: "x".repeat(2000),
      many: Array.from({ length: 80 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: 1 } } } } },
    });
    expect((bounded["long"] as string).length).toBeLessThan(600);
    expect((bounded["many"] as unknown[]).length).toBe(51);
    expect(JSON.stringify(bounded["deep"])).toContain("[truncated]");
  });

  it("omits optional fields that were not supplied", () => {
    expect(cappyError("INTERNAL_ERROR", "bad", "op")).toEqual({ code: "INTERNAL_ERROR", message: "bad", operation: "op" });
  });
});
