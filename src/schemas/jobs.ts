import { z } from "zod";

// Single source of truth for job shapes: TypeScript types are inferred below
// (re-exported from src/types.ts) and Swagger is generated from the same schemas.

export const JobProgressSchema = z
  .object({
    filesTotal: z.number().int(),
    filesProcessed: z.number().int(),
    filesSkipped: z.number().int(),
    filesShared: z
      .number()
      .int()
      .meta({ description: "Unchanged copies of files already indexed for another branch (reused, not re-embedded)" }),
    filesDeleted: z.number().int(),
    filesFailed: z.number().int(),
    chunksEmbedded: z.number().int(),
    chunksReused: z.number().int(),
    message: z.string().optional(),
  })
  .meta({ id: "JobProgress" });

export const JobSchema = z
  .object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    kind: z.enum(["git_sync", "upload"]),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    progress: JobProgressSchema,
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
  })
  .meta({ id: "Job" });

export type JobProgress = z.infer<typeof JobProgressSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobStatus = Job["status"];

export const JobResponse = z
  .object({ job: JobSchema })
  .meta({ id: "JobResponse" });
