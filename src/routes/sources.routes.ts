import { sourceController } from "../controllers/sourceController.js";
import { rateLimit } from "../middleware/security.js";
import { uploadFiles } from "../middleware/upload.js";
import { IdParam } from "../schemas/common.js";
import {
  GitSourceBody,
  IngestResult,
  SourceDetailResponse,
  SourceListResponse,
  SyncBody,
  UploadForm,
  UploadResult,
} from "../schemas/sources.js";
import { createApiRouter } from "./apiRouter.js";

export const sourceRoutes = createApiRouter({ prefix: "/sources", tag: "Sources" });

const ingestLimit = rateLimit({ windowMs: 60_000, max: 10 });

const ingestResponses = (schema: typeof IngestResult | typeof UploadResult) => ({
  200: { description: "Already up to date, or a job is already running", schema },
  202: { description: "Indexing job queued. Poll GET /jobs/{job.id}", schema },
});

// POST /api/sources/git
sourceRoutes.post(
  "/git",
  {
    summary: "Index a Git repository",
    body: GitSourceBody,
    responses: ingestResponses(IngestResult),
  },
  ingestLimit,
  sourceController.addGit,
);

// POST /api/sources/upload
sourceRoutes.post(
  "/upload",
  {
    summary: "Upload files or a folder",
    body: UploadForm,
    bodyType: "multipart",
    responses: { ...ingestResponses(UploadResult), 413: "File too large" },
  },
  ingestLimit,
  uploadFiles,
  sourceController.upload,
);

// POST /api/sources/:id/sync
sourceRoutes.post(
  "/:id/sync",
  {
    summary: "Re-sync a Git source (only changed files)",
    params: IdParam,
    body: SyncBody,
    bodyRequired: false,
    responses: { ...ingestResponses(IngestResult), 404: "Source not found" },
  },
  ingestLimit,
  sourceController.sync,
);

// GET /api/sources
sourceRoutes.get(
  "/",
  {
    summary: "List indexed sources",
    responses: { 200: { description: "OK", schema: SourceListResponse } },
  },
  sourceController.list,
);

// GET /api/sources/:id
sourceRoutes.get(
  "/:id",
  {
    summary: "Source details + latest job",
    params: IdParam,
    responses: {
      200: { description: "OK", schema: SourceDetailResponse },
      404: "Source not found",
    },
  },
  sourceController.get,
);

// DELETE /api/sources/:id
sourceRoutes.delete(
  "/:id",
  {
    summary: "Remove a source and all its chunks",
    params: IdParam,
    responses: {
      204: "Deleted",
      400: "Invalid id, or source is currently being indexed",
      404: "Source not found",
    },
  },
  sourceController.remove,
);
