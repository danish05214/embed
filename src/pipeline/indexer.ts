import path from "node:path";
import { config } from "../config.js";
import { withTransaction } from "../db.js";
import { EMBEDDING_MODEL, embedTexts } from "../llm/embeddings.js";
import {
  chunkRepository,
  type ChunkToStore,
} from "../repository/chunkRepository.js";
import { documentRepository } from "../repository/documentRepository.js";
import type { ChunkDraft, InputFile, JobProgress } from "../types.js";
import { hashFile, sha256, stableChunkId } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { chunkSections } from "./chunker.js";
import { detectFileType } from "./fileTypes.js";
import { parseFile } from "./parsers.js";

const FILE_GROUP_SIZE = 20;

export interface IndexOptions {
  sourceId: string;
  /** Files are shared with other sources in the same scope (other branches of the repo). */
  scopeKey: string;
  files: InputFile[];
  mode: "full" | "merge";
  report: (p: Partial<JobProgress>) => Promise<void>;
}

interface PreparedFile {
  file: InputFile;
  fileHash: string;
  fileType: string;
  drafts: ChunkDraft[];
  error?: string;
}

/** Hash of the sorted (path, file hash) list: identical uploads produce the same manifest hash. */
export function manifestHash(
  entries: { path: string; fileHash: string }[],
): string {
  const lines = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}\t${e.fileHash}`);
  // Include the indexing settings so re-uploading the same files after changing the
  // embedding model/dimensions or chunking version is not treated as "up_to_date".
  const settings = [
    `model=${EMBEDDING_MODEL}`,
    `dims=${config.azureOpenAI.embeddingDimensions}`,
    `chunking=${config.chunking.version}`,
  ];
  return sha256([...settings, ...lines].join("\n"));
}

export async function indexFiles(
  opts: IndexOptions,
): Promise<{ fileHashes: { path: string; fileHash: string }[] }> {
  const { sourceId, scopeKey, files, mode, report } = opts;
  const existing = await documentRepository.listBySource(sourceId);
  const progress: JobProgress = {
    filesTotal: files.length,
    filesProcessed: 0,
    filesSkipped: 0,
    filesShared: 0,
    filesDeleted: 0,
    filesFailed: 0,
    chunksEmbedded: 0,
    chunksReused: 0,
    message: "Indexing files",
  };
  await report(progress);

  const fileHashes: { path: string; fileHash: string }[] = [];
  const toProcess: { file: InputFile; fileHash: string }[] = [];

  // Step 1: file-level change detection
  for (const file of files) {
    const fileHash = await hashFile(file.absPath);
    fileHashes.push({ path: file.path, fileHash });
    const prev = existing.get(file.path);
    const unchanged =
      prev &&
      prev.fileHash === fileHash &&
      prev.chunkingVersion === config.chunking.version &&
      prev.embeddingModel === EMBEDDING_MODEL &&
      prev.status !== "failed";
    if (unchanged) {
      progress.filesSkipped++;
      progress.filesProcessed++;
      continue;
    }

    // Same file version already indexed in this repo (e.g. for another branch)?
    // Then just tag it with this branch: no parsing, chunking, embedding or new rows.
    const shared = await withTransaction(async (db) => {
      const documentId = await documentRepository.findReusable(db, {
        scopeKey,
        path: file.path,
        fileHash,
        chunkingVersion: config.chunking.version,
        embeddingModel: EMBEDDING_MODEL,
      });
      if (documentId)
        await documentRepository.link(db, sourceId, file.path, documentId);
      return documentId !== null;
    });
    if (shared) {
      progress.filesShared++;
      progress.filesProcessed++;
    } else {
      toProcess.push({ file, fileHash });
    }
  }
  await report(progress);

  // Step 2-3: process changed files in groups
  for (let i = 0; i < toProcess.length; i += FILE_GROUP_SIZE) {
    const group = toProcess.slice(i, i + FILE_GROUP_SIZE);
    const prepared: PreparedFile[] = [];

    for (const { file, fileHash } of group) {
      const type = detectFileType(file.path)!;
      try {
        const sections = await parseFile(file.absPath, type);
        const drafts = await chunkSections(file.path, sections);
        prepared.push({ file, fileHash, fileType: type.ext, drafts });
      } catch (err) {
        prepared.push({
          file,
          fileHash,
          fileType: type?.ext ?? path.extname(file.path).slice(1),
          drafts: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Embedding cache lookup for the whole group
    const allDrafts = prepared.flatMap((p) => p.drafts);
    const uniqueHashes = [...new Set(allDrafts.map((d) => d.embedHash))];
    const cached = await chunkRepository.getCachedEmbeddings(
      uniqueHashes,
      EMBEDDING_MODEL,
    );

    const missing = new Map<string, ChunkDraft>();
    for (const d of allDrafts)
      if (!cached.has(d.embedHash) && !missing.has(d.embedHash))
        missing.set(d.embedHash, d);
    const missingList = [...missing.values()];

    const fresh = new Map<string, number[]>();
    if (missingList.length > 0) {
      const vectors = await embedTexts(
        missingList.map((d) => d.embedText),
        missingList.map((d) => d.tokenCount),
      );
      missingList.forEach((d, idx) => fresh.set(d.embedHash, vectors[idx]!));
    }
    progress.chunksEmbedded += missingList.length;
    progress.chunksReused += allDrafts.length - missingList.length;

    // Store each file atomically
    for (const p of prepared) {
      try {
        await withTransaction(async (db) => {
          const status = p.error
            ? "failed"
            : p.drafts.length === 0
              ? "empty"
              : "indexed";
          const documentId = await documentRepository.upsert(db, {
            scopeKey,
            path: p.file.path,
            fileHash: p.fileHash,
            fileType: p.fileType,
            sizeBytes: p.file.size,
            chunkCount: p.drafts.length,
            chunkingVersion: config.chunking.version,
            embeddingModel: EMBEDDING_MODEL,
            status,
            error: p.error ? p.error.slice(0, 500) : null,
          });
          await documentRepository.link(db, sourceId, p.file.path, documentId);

          const occurrences = new Map<string, number>();
          const chunks: ChunkToStore[] = p.drafts.map((d) => {
            const n = occurrences.get(d.chunkHash) ?? 0;
            occurrences.set(d.chunkHash, n + 1);
            return {
              ...d,
              id: stableChunkId(documentId, d.chunkHash, n),
              embedding: cached.get(d.embedHash) ?? fresh.get(d.embedHash)!,
            };
          });
          await chunkRepository.replaceForDocument(
            db,
            documentId,
            chunks,
            EMBEDDING_MODEL,
          );

          const newCache = p.drafts
            .filter((d) => fresh.has(d.embedHash))
            .map((d) => ({
              embedHash: d.embedHash,
              embedding: fresh.get(d.embedHash)!,
            }));
          await chunkRepository.saveCache(db, newCache, EMBEDDING_MODEL);
        });
        if (p.error) {
          progress.filesFailed++;
          logger.warn("File could not be parsed", {
            path: p.file.path,
            error: p.error,
          });
        }
      } catch (err) {
        progress.filesFailed++;
        logger.error("Failed to store file", {
          path: p.file.path,
          error: (err as Error).message,
        });
      }
      progress.filesProcessed++;
    }
    await report(progress);
  }

  // Step 4: remove files that disappeared from this source (other branches keep their copy)
  if (mode === "full") {
    const incoming = new Set(files.map((f) => f.path));
    const stale = [...existing.keys()].filter((p) => !incoming.has(p));
    progress.filesDeleted = await documentRepository.unlinkPaths(
      sourceId,
      stale,
    );
  }

  // Step 5: delete file versions no branch uses any more (old versions, removed files)
  try {
    await documentRepository.deleteOrphans(scopeKey);
  } catch (err) {
    logger.warn("Orphan clean-up skipped; it will run again next time", {
      scopeKey,
      error: (err as Error).message,
    });
  }

  progress.message = "Done";
  await report(progress);
  return { fileHashes };
}
