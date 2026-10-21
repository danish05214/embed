import { sourceController } from "../controllers/sourceController.js";
import { rateLimit } from "../middleware/security.js";
import { uploadFiles } from "../middleware/upload.js";
import { IdParam } from "../schemas/common.js";
import {
  GitBranchesBody,
  GitSourceBody,
  IngestResult,
  MultiIngestResult,
  RemoteBranchesBody,
  RemoteBranchList,
  SourceDetailResponse,
  SourceListResponse,
  SyncBody,
  UploadForm,
  UploadResult,
} from "../schemas/sources.js";
import { createApiRouter } from "./apiRouter.js";

export const sourceRoutes = createApiRouter({
  prefix: "/sources",
  tag: "Sources",
});

const ingestLimit = rateLimit({ windowMs: 60_000, max: 10 });

const ingestResponses = (
  schema: typeof IngestResult | typeof UploadResult,
) => ({
  200: {
    description: "Already up to date, or a job is already running",
    schema,
  },
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

// POST /api/sources/git/remote-branches
sourceRoutes.post(
  "/git/remote-branches",
  {
    summary: "List a repository's branches (to pick which ones to index)",
    description:
      "Reads branch names from the remote with `git ls-remote` (no clone) and shows which are already indexed. POST so the token is never put in a URL.",
    body: RemoteBranchesBody,
    responses: {
      200: { description: "OK", schema: RemoteBranchList },
      422: "Repository not found or not accessible",
    },
  },
  ingestLimit,
  sourceController.remoteBranches,
);

// POST /api/sources/git/branches
sourceRoutes.post(
  "/git/branches",
  {
    summary: "Index several branches of a Git repository",
    description:
      "One source per branch. Files identical across branches are stored and embedded once and tagged with every branch, so search returns them once. All branch names are checked first; nothing is queued if one is missing.",
    body: GitBranchesBody,
    responses: {
      200: { description: "Every branch already up to date or running", schema: MultiIngestResult },
      202: { description: "At least one job queued. Poll GET /jobs/{job.id}", schema: MultiIngestResult },
      422: "Branch not found, or repository not accessible",
    },
  },
  ingestLimit,
  sourceController.addGitBranches,
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
