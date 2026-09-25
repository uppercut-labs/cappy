import type { Scenario, ScenarioParameters } from "./domain.js";
import { cappyError } from "./errors.js";
import { type Result, err, ok } from "./result.js";

/**
 * Parse `key=value` strings (from the CLI) against a scenario's parameter
 * schema, apply defaults, and validate types, enums, ranges, and required
 * parameters. Unknown parameters are rejected.
 */
export function resolveScenarioParameters(scenario: Scenario, assignments: readonly string[]): Result<ScenarioParameters> {
  const problems: string[] = [];
  const raw = new Map<string, string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      problems.push(`"${assignment}" is not key=value`);
      continue;
    }
    raw.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }

  const resolved: Record<string, string | number | boolean> = {};
  for (const name of raw.keys()) {
    if (!(name in scenario.parameters)) {
      problems.push(`unknown parameter "${name}"`);
    }
  }
  for (const [name, spec] of Object.entries(scenario.parameters)) {
    const text = raw.get(name);
    if (text === undefined) {
      if (spec.default !== undefined) {
        resolved[name] = spec.default;
      } else if (spec.required) {
        problems.push(`missing required parameter "${name}"`);
      }
      continue;
    }
    let value: string | number | boolean;
    switch (spec.type) {
      case "boolean":
        if (text !== "true" && text !== "false") {
          problems.push(`parameter "${name}" must be true or false`);
          continue;
        }
        value = text === "true";
        break;
      case "integer":
      case "number": {
        const parsed = Number(text);
        if (text.trim() === "" || !Number.isFinite(parsed) || (spec.type === "integer" && !Number.isInteger(parsed))) {
          problems.push(`parameter "${name}" must be ${spec.type === "integer" ? "an integer" : "a number"}`);
          continue;
        }
        value = parsed;
        break;
      }
      default:
        value = text;
    }
    if (spec.enum !== undefined && !spec.enum.includes(value as string | number)) {
      problems.push(`parameter "${name}" must be one of ${spec.enum.join(", ")}`);
      continue;
    }
    if (typeof value === "number" && ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) {
      problems.push(`parameter "${name}" must be within ${spec.minimum ?? "-∞"}..${spec.maximum ?? "∞"}`);
      continue;
    }
    resolved[name] = value;
  }

  if (problems.length > 0) {
    return err(
      cappyError("PARAMETER_INVALID", `invalid parameters for scenario "${scenario.id}": ${problems.join("; ")}`, "scenario.parameters", {
        details: { scenario: scenario.id, problems },
        retryable: false,
      }),
    );
  }
  return ok(resolved);
}
