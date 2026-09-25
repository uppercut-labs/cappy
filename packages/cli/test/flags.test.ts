import { describe, expect, it } from "vitest";
import { FLAGS, SHORTHAND_EXCEPTIONS, translateShorthands } from "../src/flags.js";
import { HELP } from "../src/main.js";

const entries = Object.entries(FLAGS) as [string, { type: string; short: string }][];

describe("flag shorthands", () => {
  it("gives every flag a distinct shorthand", () => {
    const shorts = entries.map(([, spec]) => spec.short);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it("derives each shorthand from the initials rule unless it is a documented exception", () => {
    for (const [name, spec] of entries) {
      if (SHORTHAND_EXCEPTIONS[name] !== undefined) {
        expect(spec.short).toBe(SHORTHAND_EXCEPTIONS[name]);
        continue;
      }
      const words = name.split("-");
      const allowed =
        words.length > 1 ? [words.map((word) => word[0]).join("")] : [name.slice(0, 1), name.slice(0, 2)];
      expect(allowed, `--${name}`).toContain(spec.short);
      if (words.length === 1 && spec.short.length === 2) {
        // Two letters are only earned by a collision on the first letter.
        expect(entries.some(([other, otherSpec]) => other !== name && otherSpec.short === name[0]), `--${name}`).toBe(true);
      }
    }
  });

  it("translates every shorthand to its long flag, keeping values", () => {
    for (const [name, spec] of entries) {
      const args = spec.type === "string" ? [`-${spec.short}`, "value"] : [`-${spec.short}`];
      const expected = spec.type === "string" ? [`--${name}`, "value"] : [`--${name}`];
      expect(translateShorthands(["doctor", ...args])).toEqual({ ok: true, args: ["doctor", ...expected] });
    }
  });

  it("treats a multi-letter shorthand as one token, never grouped letters", () => {
    expect(translateShorthands(["replay", "ses_1", "-nc"])).toEqual({ ok: true, args: ["replay", "ses_1", "--no-capture"] });
    expect(translateShorthands(["doctor", "-jh"])).toEqual({ ok: false, token: "-jh" });
    expect(translateShorthands(["doctor", "-zz"])).toEqual({ ok: false, token: "-zz" });
  });

  it("never translates an option's value, even when it starts with a dash", () => {
    expect(translateShorthands(["run", "s", "-pa", "-d", "--param", "-nc", "--config", "-c"])).toEqual({
      ok: true,
      args: ["run", "s", "--param", "-d", "--param", "-nc", "--config", "-c"],
    });
    expect(translateShorthands(["run", "s", "--preset=-p", "-j"])).toEqual({ ok: true, args: ["run", "s", "--preset=-p", "--json"] });
    expect(translateShorthands(["run", "--", "-j"])).toEqual({ ok: true, args: ["run", "--", "-j"] });
  });

  it("lists every shorthand in the help text", () => {
    for (const [name, spec] of entries) {
      expect(HELP).toMatch(new RegExp(`-${spec.short},\\s+--${name}\\b`));
    }
  });
});
