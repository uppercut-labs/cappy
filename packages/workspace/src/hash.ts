import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

/** Stream a file through SHA-256 without loading it into memory. */
export async function hashFile(filePath: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

export function hashBytes(data: string | Uint8Array): FileDigest {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength };
}
