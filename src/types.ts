// API types are inferred from the zod schemas in src/schemas (one definition for
// validation, TypeScript and Swagger). Re-exported here so existing imports keep working.
export type { Job, JobProgress, JobStatus } from "./schemas/jobs.js";
export type { Source, SourceStatus, SourceType } from "./schemas/sources.js";
import type { SourceType } from "./schemas/sources.js";

export type ContentKind = "code" | "markdown" | "text" | "table";

export interface InputFile {
  path: string;
  absPath: string;
  size: number;
}

export interface ParsedSection {
  text: string;
  kind: ContentKind;
  language?: string;
  label?: string;
  tableHeader?: string;
  rows?: string[];
}

export interface ChunkDraft {
  content: string;
  embedText: string;
  chunkHash: string;
  embedHash: string;
  index: number;
  tokenCount: number;
  metadata: {
    kind: ContentKind;
    language?: string;
    label?: string;
    startLine?: number;
    endLine?: number;
  };
}

export interface SearchHit {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  repoUrl: string | null;
  branch: string | null;
  commitSha: string | null;
  path: string;
  content: string;
  metadata: ChunkDraft["metadata"];
  score: number;
}
