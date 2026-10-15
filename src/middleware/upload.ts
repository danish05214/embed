import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { config } from "../config.js";

const UPLOAD_DIR = path.join(os.tmpdir(), "cs-embed-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const uploadFiles = multer({
  preservePath: true,
  defParamCharset: "utf8",
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
