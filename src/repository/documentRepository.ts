import { pool, type Queryable } from "../db.js";

export interface StoredDocument {
  id: string;
  path: string;
  fileHash: string;
  chunkingVersion: number;
  embeddingModel: string | null;
  status: "indexed" | "failed" | "empty";
}

export const documentRepository = {
  async listBySource(sourceId: string): Promise<Map<string, StoredDocument>> {
    const { rows } = await pool.query(
      `select id, path, file_hash, chunking_version, embedding_model, status
       from documents where source_id = $1`,
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

  async upsert(
    db: Queryable,
    doc: {
      sourceId: string;
      path: string;
      fileHash: string;
      fileType: string;
      sizeBytes: number;
      chunkCount: number;
      chunkingVersion: number;
      embeddingModel: string | null;
      status: "indexed" | "failed" | "empty";
      error?: string | null;
    },
  ): Promise<string> {
    const { rows } = await db.query(
      `insert into documents
         (source_id, path, file_hash, file_type, size_bytes, chunk_count, chunking_version, embedding_model, status, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (source_id, path) do update set
         file_hash = excluded.file_hash,
         file_type = excluded.file_type,
         size_bytes = excluded.size_bytes,
         chunk_count = excluded.chunk_count,
         chunking_version = excluded.chunking_version,
         embedding_model = excluded.embedding_model,
         status = excluded.status,
         error = excluded.error
       returning id`,
      [
        doc.sourceId,
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

  /** Deleting a document cascades to its chunks. */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await pool.query(
      `delete from documents where id = any($1::uuid[])`,
      [ids],
    );
    return res.rowCount ?? 0;
  },
};
