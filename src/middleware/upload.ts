import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { config } from "../config.js";

const UPLOAD_DIR = path.join(os.tmpdir(), "cs-embed-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Multipart upload: field name `files` (one or many).
 * Files are written to a temp folder with random names (the client's path is never used on disk)
 * and deleted after indexing.
 *
 * Folder uploads from React: append each file with its relative path as the file name, e.g.
 *   formData.append("files", file, file.webkitRelativePath)
 * `preservePath` keeps that path so citations show "docs/guide.pdf" instead of "guide.pdf".
 */
export const uploadFiles = multer({
  preservePath: true,
  defParamCharset: "utf8", // keep non-ASCII file names intact
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: {
    fileSize: config.limits.maxUploadBytes,
    files: config.limits.maxFilesPerSource,
    fields: 20,
  },
}).array("files");
