import { z } from "zod";
import { timelineEventSchema, timelineExportSchema } from "./domain.js";

const BASE = "https://github.com/devin-thomas/cappy/blob/main/docs/schemas";

/**
 * The JSON Schemas Cappy publishes in `docs/schemas/` (draft-07), keyed by
 * file name. They are generated from the runtime schemas, so they cannot
 * drift from what Cappy accepts; `npm run schemas` rewrites the files.
 */
export function publishedSchemas(): Record<string, Record<string, unknown>> {
  const generate = (schema: z.ZodType, file: string, title: string): Record<string, unknown> => {
    const { $schema, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
    return { $schema, $id: `${BASE}/${file}`, title, ...rest };
  };
  return {
    "timeline-event.schema.json": generate(timelineEventSchema, "timeline-event.schema.json", "Cappy timeline event"),
    "timeline-export.schema.json": generate(timelineExportSchema, "timeline-export.schema.json", "Cappy timeline export"),
  };
}
