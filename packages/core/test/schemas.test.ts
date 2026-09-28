import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { publishedSchemas } from "@uppercut-labs/cappy-internal-core";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/schemas");

describe("published JSON Schemas", () => {
  it("match the runtime schemas exactly (run `npm run schemas` after changing them)", async () => {
    for (const [file, generated] of Object.entries(publishedSchemas())) {
      const committed = JSON.parse(await readFile(path.join(directory, file), "utf8")) as unknown;
      expect(committed, file).toEqual(generated);
    }
  });

  it("are valid draft-07 schemas", () => {
    const ajv = new Ajv({ allErrors: true });
    for (const schema of Object.values(publishedSchemas())) {
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });
});
