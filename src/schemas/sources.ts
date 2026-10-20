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
