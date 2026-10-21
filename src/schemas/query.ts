import { z } from "zod";

// ---------- Request (runtime validation AND Swagger) ----------

export const QueryBody = z
  .object({
    question: z.string().trim().min(1, "question is required").max(2000),
    sourceIds: z
      .array(z.string().uuid())
      .max(50)
      .optional()
      .meta({ description: "Limit search to these sources (default: all)" }),
    topK: z.number().int().min(1).max(30).optional(),
  })
  .meta({ id: "QueryRequest" });

// ---------- Response (single source of truth: types below are inferred from these) ----------

export const QuerySourceSchema = z
  .object({
    ref: z.number().int().meta({ description: "Citation number used in the answer, e.g. [1]" }),
    sourceId: z.string().uuid(),
    sourceName: z.string(),
    sourceType: z.string(),
    branches: z
      .array(z.string())
      .meta({ description: "Every searched branch containing this exact passage (empty for uploads)", example: ["dev", "main"] }),
    path: z.string(),
    label: z.string().optional(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    url: z.string().nullable().meta({ description: "Deep link to file/lines (GitHub/GitLab)" }),
    score: z.number().meta({ description: "Hybrid search score (RRF)" }),
    rerankScore: z
      .number()
      .nullable()
      .meta({ description: "Re-ranker relevance 0..1 (higher = more relevant); null when not re-ranked" }),
    snippet: z.string(),
  })
  .meta({ id: "QuerySource" });

export const QueryResult = z
  .object({
    answer: z.string(),
    sources: z.array(QuerySourceSchema),
    usage: z
      .object({ promptTokens: z.number().int(), completionTokens: z.number().int() })
      .optional(),
    reranked: z
      .boolean()
      .meta({ description: "true if the sources were re-ordered by the re-ranker; false = search order (re-ranker off, loading or failed)" }),
  })
  .meta({ id: "QueryResult" });

export type QuerySource = z.infer<typeof QuerySourceSchema>;
export type QueryResult = z.infer<typeof QueryResult>;
