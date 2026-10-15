import crypto from "node:crypto";
import fs from "node:fs";

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** File hash: SHA-256 of raw bytes, streamed so large files don't load into memory twice. */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(absPath)
      .on("error", reject)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")));
  });
}

export function stableChunkId(
  documentId: string,
  chunkHash: string,
  occurrence: number,
): string {
  return sha256(`${documentId}:${chunkHash}:${occurrence}`);
}
