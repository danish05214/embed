export type SourceType = "git" | "upload";
export type SourceStatus = "pending" | "indexing" | "ready" | "failed";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type ContentKind = "code" | "markdown" | "text" | "table";

export interface Source {
  id: string;
  sourceKey: string;
  type: SourceType;
  name: string;
  repoUrl: string | null;
  branch: string | null;
  lastCommitSha: string | null;
  manifestHash: string | null;
  status: SourceStatus;
  error: string | null;
  fileCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobProgress {
  filesTotal: number;
  filesProcessed: number;
  filesSkipped: number;
  filesDeleted: number;
  filesFailed: number;
  chunksEmbedded: number;
  chunksReused: number;
  message?: string;
}

export interface Job {
  id: string;
  sourceId: string;
  kind: "git_sync" | "upload";
  status: JobStatus;
  progress: JobProgress;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A file ready to be indexed (from a Git checkout or an upload). */
export interface InputFile {
  /** Relative path used for citations, e.g. "src/app.ts" or "docs/guide.pdf" */
  path: string;
  /** Absolute path on local disk to read from */
  absPath: string;
  size: number;
}

/** Text extracted from a file, split into logical sections (pages, sheets, or the whole file). */
export interface ParsedSection {
  text: string;
  kind: ContentKind;
  /** e.g. code language for the splitter */
  language?: string;
  /** e.g. "Page 3" or "Sheet: Claims" */
  label?: string;
  /** Header line repeated in each table chunk */
  tableHeader?: string;
  /** For tables: rows already split (header excluded) */
  rows?: string[];
}

export interface ChunkDraft {
  content: string;
  /** Text actually sent to the embedding model (context header + content) */
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
