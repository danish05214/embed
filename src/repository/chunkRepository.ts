import { pool, toVectorLiteral, type Queryable } from "../db.js";
import type { ChunkDraft, SearchHit, SourceType } from "../types.js";

export interface ChunkToStore extends ChunkDraft {
  id: string;
  embedding: number[];
}

export const chunkRepository = {
  async getCachedEmbeddings(
    embedHashes: string[],
    model: string,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (embedHashes.length === 0) return out;
    const { rows } = await pool.query(
      `select embed_hash, embedding::text as embedding
       from embedding_cache where model = $1 and embed_hash = any($2::text[])`,
      [model, embedHashes],
    );
    for (const r of rows) out.set(r.embed_hash, JSON.parse(r.embedding));
    return out;
  },

  async saveCache(
    db: Queryable,
    entries: { embedHash: string; embedding: number[] }[],
    model: string,
  ): Promise<void> {
    for (const e of entries) {
      await db.query(
        `insert into embedding_cache (embed_hash, model, embedding)
         values ($1, $2, $3)
         on conflict (embed_hash, model) do nothing`,
        [e.embedHash, model, toVectorLiteral(e.embedding)],
      );
    }
  },

  async replaceForDocument(
    db: Queryable,
    documentId: string,
    sourceId: string,
    chunks: ChunkToStore[],
    model: string,
  ): Promise<void> {
    const ids = chunks.map((c) => c.id);
    await db.query(
      `delete from chunks where document_id = $1 and not (id = any($2::text[]))`,
      [documentId, ids],
    );

    for (const c of chunks) {
      await db.query(
        `insert into chunks
           (id, document_id, source_id, chunk_index, chunk_hash, embed_hash, content, metadata, token_count, embedding, embedding_model)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (id) do update set
           chunk_index = excluded.chunk_index,
           embed_hash = excluded.embed_hash,
           content = excluded.content,
           metadata = excluded.metadata,
           token_count = excluded.token_count,
           embedding = excluded.embedding,
           embedding_model = excluded.embedding_model`,
        [
          c.id,
          documentId,
          sourceId,
          c.index,
          c.chunkHash,
          c.embedHash,
          c.content,
          JSON.stringify(c.metadata),
          c.tokenCount,
          toVectorLiteral(c.embedding),
          model,
        ],
      );
    }
  },

  async hybridSearch(params: {
    embedding: number[];
    queryText: string;
    topK: number;
    sourceIds?: string[];
  }): Promise<SearchHit[]> {
    const { rows } = await pool.query(
      `select * from hybrid_search($1, $2, $3, $4::uuid[])`,
      [
        toVectorLiteral(params.embedding),
        params.queryText,
        params.topK,
        params.sourceIds && params.sourceIds.length ? params.sourceIds : null,
      ],
    );
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceType: r.source_type as SourceType,
      repoUrl: r.repo_url,
      branch: r.branch,
      commitSha: r.commit_sha,
      path: r.path,
      content: r.content,
      metadata: r.metadata,
      score: Number(r.score),
    }));
  },
};
