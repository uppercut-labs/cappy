import { describe, expect, it } from "vitest";
import { resolveScenarioParameters, scenarioSchema } from "@cappy/core";

const scenario = scenarioSchema.parse({
  id: "boss_intro",
  name: "Boss intro",
  parameters: {
    difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 },
    speed: { type: "number" },
    hardcore: { type: "boolean" },
    arena: { type: "string", enum: ["castle", "cave"], required: true },
  },
});

describe("resolveScenarioParameters", () => {
  it("parses typed values and applies defaults", () => {
    const result = resolveScenarioParameters(scenario, ["arena=cave", "speed=1.5", "hardcore=true"]);
    expect(result).toEqual({ ok: true, value: { arena: "cave", speed: 1.5, hardcore: true, difficulty: 2 } });
  });

  it("reports every problem at once", () => {
    const result = resolveScenarioParameters(scenario, ["difficulty=9", "speed=fast", "hardcore=yes", "color=red", "novalue"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PARAMETER_INVALID");
    expect(result.error.details?.["problems"]).toEqual([
      '"novalue" is not key=value',
      'unknown parameter "color"',
      'parameter "difficulty" must be within 1..3',
      'parameter "speed" must be a number',
      'parameter "hardcore" must be true or false',
      'missing required parameter "arena"',
    ]);
  });

  it("rejects values outside an enum and non-integer integers", () => {
    expect(resolveScenarioParameters(scenario, ["arena=moon"]).ok).toBe(false);
    expect(resolveScenarioParameters(scenario, ["arena=cave", "difficulty=1.5"]).ok).toBe(false);
  });
});
