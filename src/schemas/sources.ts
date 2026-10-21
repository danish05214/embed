import { z } from "zod";
import { JobSchema } from "./jobs.js";

// ---------- Requests (used for runtime validation AND Swagger) ----------

export const GitSourceBody = z
  .object({
    repoUrl: z
      .string()
      .min(1)
      .max(500)
      .meta({ example: "https://github.com/org/repo" }),
    branch: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .meta({ description: "Defaults to the repo's default branch" }),
    token: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .meta({ description: "Access token for private repos. Never stored or logged." }),
    name: z.string().min(1).max(200).optional(),
    force: z
      .boolean()
      .optional()
      .meta({ description: "Re-index even if the commit is unchanged" }),
  })
  .meta({ id: "GitSourceRequest" });

/** POST because the token must not travel in a URL (proxies and logs record URLs). */
export const RemoteBranchesBody = z
  .object({
    repoUrl: z
      .string()
      .min(1)
      .max(500)
      .meta({ example: "https://github.com/org/repo" }),
    token: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .meta({ description: "Access token for private repos. Never stored or logged." }),
  })
  .meta({ id: "RemoteBranchesRequest" });

export const GitBranchesBody = z
  .object({
    repoUrl: z
      .string()
      .min(1)
      .max(500)
      .meta({ example: "https://github.com/org/repo" }),
    branches: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(25)
      .meta({
        description:
          "Branches to index (exact names). Files identical across branches are stored and embedded once.",
        example: ["main", "dev"],
      }),
    token: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .meta({ description: "Access token for private repos. Never stored or logged." }),
    force: z
      .boolean()
      .optional()
      .meta({ description: "Re-index even if the commit is unchanged" }),
  })
  .meta({ id: "GitBranchesRequest" });

export const SyncBody = z
  .object({
    token: z.string().min(1).max(500).optional(),
    force: z.boolean().optional(),
  })
  .meta({ id: "SyncRequest" });

/** Text fields of the multipart upload (files are handled by multer). */
export const UploadFields = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .meta({ description: "Collection name. Re-uploading with the same name updates it." }),
  mode: z
    .enum(["merge", "replace"])
    .default("merge")
    .meta({ description: "`replace` also removes files not included in this upload" }),
  paths: z
    .string()
    .optional()
    .meta({
      description:
        'Optional JSON array of relative paths, one per file, e.g. ["docs/a.md","docs/b.pdf"]',
    }),
});

/** Multipart form as shown in Swagger: the text fields plus the `files` field. */
export const UploadForm = UploadFields.extend({
  files: z
    .array(z.string().meta({ type: "string", format: "binary" }))
    .meta({ description: "One or more files (repeat the `files` field per file)" }),
}).meta({ id: "UploadRequest" });

// ---------- Responses (single source of truth: types below are inferred from these) ----------

export const SourceSchema = z
  .object({
    id: z.string().uuid(),
    sourceKey: z.string(),
    scopeKey: z.string().meta({
      description:
        "Repository (git:<host>/<owner>/<repo>) or upload collection. Branches of one repo share it and share identical files.",
    }),
    type: z.enum(["git", "upload"]),
    name: z.string(),
    repoUrl: z.string().nullable(),
    branch: z.string().nullable(),
    lastCommitSha: z.string().nullable(),
    manifestHash: z.string().nullable(),
    status: z.enum(["pending", "indexing", "ready", "failed"]),
    error: z.string().nullable(),
    fileCount: z.number().int(),
    chunkCount: z.number().int(),
    lastIndexedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .meta({ id: "Source" });

export type Source = z.infer<typeof SourceSchema>;
export type SourceType = Source["type"];
export type SourceStatus = Source["status"];

export const IngestResult = z
  .object({
    status: z.enum(["queued", "already_running", "up_to_date"]),
    source: SourceSchema,
    job: JobSchema.nullable().meta({ description: "null when nothing needed indexing" }),
  })
  .meta({ id: "IngestResult" });
export type IngestResult = z.infer<typeof IngestResult>;

export const MultiIngestResult = z
  .object({
    results: z.array(IngestResult).meta({ description: "One entry per requested branch, in request order" }),
  })
  .meta({ id: "MultiIngestResult" });
export type MultiIngestResult = z.infer<typeof MultiIngestResult>;

export const RemoteBranchList = z
  .object({
    repoUrl: z.string(),
    defaultBranch: z.string(),
    total: z.number().int(),
    truncated: z.boolean().meta({ description: "true when only the first 1000 branches are listed" }),
    branches: z.array(
      z.object({
        name: z.string(),
        sha: z.string().meta({ description: "Latest commit on the remote" }),
        isDefault: z.boolean(),
        sourceId: z
          .string()
          .uuid()
          .nullable()
          .meta({ description: "Source ID if this branch is already indexed" }),
        status: z.enum(["pending", "indexing", "ready", "failed"]).nullable(),
        upToDate: z.boolean().meta({ description: "Indexed and at the remote's latest commit" }),
      }),
    ),
  })
  .meta({ id: "RemoteBranchList" });
export type RemoteBranchList = z.infer<typeof RemoteBranchList>;

export const UploadResult = IngestResult.extend({
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
}).meta({ id: "UploadResult" });
export type UploadResult = z.infer<typeof UploadResult>;

export const SourceListResponse = z
  .object({ sources: z.array(SourceSchema) })
  .meta({ id: "SourceList" });

export const SourceDetailResponse = z
  .object({
    source: SourceSchema,
    latestJob: JobSchema.nullable().meta({ description: "null if the source has no jobs yet" }),
  })
  .meta({ id: "SourceDetail" });
