import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { InputFile } from "../types.js";
import { detectFileType, shouldIgnorePath } from "./fileTypes.js";

export interface WalkResult {
  files: InputFile[];
  skipped: { path: string; reason: string }[];
}

export function sanitizeRelativePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

export function filterFile(
  relPath: string,
  size: number,
): { ok: true } | { ok: false; reason: string } {
  const ig = shouldIgnorePath(relPath);
  if (ig.ignore) return { ok: false, reason: ig.reason! };
  if (!detectFileType(relPath))
    return { ok: false, reason: "unsupported file type" };
  if (size === 0) return { ok: false, reason: "empty file" };
  const t = detectFileType(relPath)!;
  const limit =
    t.parser === "text"
      ? config.limits.maxFileBytes
      : config.limits.maxFileBytes * 10;
  if (size > limit)
    return {
      ok: false,
      reason: `file too large (${Math.round(size / 1024)} KB)`,
    };
  return { ok: true };
}

/** Recursively list indexable files under `root` (used for Git checkouts). Symlinks are not followed. */
export async function walkDirectory(root: string): Promise<WalkResult> {
  const files: InputFile[] = [];
  const skipped: WalkResult["skipped"] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(`${rel}/x`).ignore) continue;
        await visit(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        const check = filterFile(rel, stat.size);
        if (!check.ok) {
          skipped.push({ path: rel, reason: check.reason });
          continue;
        }
        if (files.length >= config.limits.maxFilesPerSource) {
          skipped.push({ path: rel, reason: "file limit reached" });
          continue;
        }
        files.push({ path: rel, absPath: abs, size: stat.size });
      }
    }
  }

  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}
