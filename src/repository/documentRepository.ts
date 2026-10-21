import { pool, type Queryable } from "../db.js";

/**
 * Documents are stored once per scope (one Git repository, or one upload collection) and
 * shared by every source (branch) that contains the exact same file version.
 * `source_documents` says which source contains which document at which path.
 */
export interface StoredDocument {
  id: string;
  path: string;
  fileHash: string;
  chunkingVersion: number;
  embeddingModel: string | null;
  status: "indexed" | "failed" | "empty";
}

export interface DocumentVersionKey {
  scopeKey: string;
  path: string;
  fileHash: string;
  chunkingVersion: number;
  embeddingModel: string | null;
}

export const documentRepository = {
  /** Documents currently linked to a source, by path. */
  async listBySource(sourceId: string): Promise<Map<string, StoredDocument>> {
    const { rows } = await pool.query(
      `select d.id, sd.path, d.file_hash, d.chunking_version, d.embedding_model, d.status
       from source_documents sd
       join documents d on d.id = sd.document_id
       where sd.source_id = $1`,
      [sourceId],
    );
    const map = new Map<string, StoredDocument>();
    for (const r of rows) {
      map.set(r.path, {
        id: r.id,
        path: r.path,
        fileHash: r.file_hash,
        chunkingVersion: r.chunking_version,
        embeddingModel: r.embedding_model,
        status: r.status,
      });
    }
    return map;
  },

  /**
   * An already indexed (not failed) copy of this exact file version in the same scope,
   * e.g. the same file indexed earlier for another branch. Locks the row (FOR SHARE) so the
   * orphan clean-up cannot delete it before the caller links it in the same transaction.
   */
  async findReusable(
    db: Queryable,
    key: DocumentVersionKey,
  ): Promise<string | null> {
    const { rows } = await db.query(
      `select id from documents
       where scope_key = $1 and path = $2 and file_hash = $3
         and chunking_version = $4 and embedding_model is not distinct from $5
         and status <> 'failed'
       for share`,
      [
        key.scopeKey,
        key.path,
        key.fileHash,
        key.chunkingVersion,
        key.embeddingModel,
      ],
    );
    return (rows[0]?.id as string) ?? null;
  },

  /** Create or update the shared document row for this file version. */
  async upsert(
    db: Queryable,
    doc: DocumentVersionKey & {
      fileType: string;
      sizeBytes: number;
      chunkCount: number;
      status: "indexed" | "failed" | "empty";
      error?: string | null;
    },
  ): Promise<string> {
    const { rows } = await db.query(
      `insert into documents
         (scope_key, path, file_hash, file_type, size_bytes, chunk_count, chunking_version, embedding_model, status, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (scope_key, path, file_hash, chunking_version, embedding_model) do update set
         file_type = excluded.file_type,
         size_bytes = excluded.size_bytes,
         chunk_count = excluded.chunk_count,
         status = excluded.status,
         error = excluded.error
       returning id`,
      [
        doc.scopeKey,
        doc.path,
        doc.fileHash,
        doc.fileType,
        doc.sizeBytes,
        doc.chunkCount,
        doc.chunkingVersion,
        doc.embeddingModel,
        doc.status,
        doc.error ?? null,
      ],
    );
    return rows[0].id as string;
  },

  /** Point `sourceId`'s `path` at `documentId` (adds the branch tag). */
  async link(
    db: Queryable,
    sourceId: string,
    path: string,
    documentId: string,
  ): Promise<void> {
    await db.query(
      `insert into source_documents (source_id, path, document_id)
       values ($1, $2, $3)
       on conflict (source_id, path) do update set document_id = excluded.document_id`,
      [sourceId, path, documentId],
    );
  },

  /** Remove paths from a source (the shared documents stay while other sources use them). */
  async unlinkPaths(sourceId: string, paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const res = await pool.query(
      `delete from source_documents where source_id = $1 and path = any($2::text[])`,
      [sourceId, paths],
    );
    return res.rowCount ?? 0;
  },

  /**
   * Delete document versions in a scope that no source links to any more (chunks cascade).
   * Rows locked by an in-flight link (findReusable) are skipped and cleaned up next time.
   * The FK on source_documents is ON DELETE RESTRICT, so a row that was linked concurrently
   * makes this statement fail instead of silently removing a branch's file; callers just log it.
   */
  async deleteOrphans(scopeKey: string): Promise<number> {
    const res = await pool.query(
      `delete from documents
       where id in (
         select d.id from documents d
         where d.scope_key = $1
           and not exists (select 1 from source_documents sd where sd.document_id = d.id)
         for update skip locked
       )`,
      [scopeKey],
    );
    return res.rowCount ?? 0;
  },
};
