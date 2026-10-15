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
