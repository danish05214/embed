import { pool, type Queryable } from "../db.js";
import type { Source, SourceStatus, SourceType } from "../types.js";

const COLUMNS = `id, source_key, type, name, repo_url, branch, last_commit_sha, manifest_hash, status, error,
  file_count, chunk_count, last_indexed_at, created_at, updated_at`;

function map(r: Record<string, unknown>): Source {
  return {
    id: r.id as string,
    sourceKey: r.source_key as string,
    type: r.type as SourceType,
    name: r.name as string,
    repoUrl: (r.repo_url as string) ?? null,
    branch: (r.branch as string) ?? null,
    lastCommitSha: (r.last_commit_sha as string) ?? null,
    manifestHash: (r.manifest_hash as string) ?? null,
    status: r.status as SourceStatus,
    error: (r.error as string) ?? null,
    fileCount: Number(r.file_count ?? 0),
    chunkCount: Number(r.chunk_count ?? 0),
    lastIndexedAt: r.last_indexed_at
      ? new Date(r.last_indexed_at as string).toISOString()
      : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export const sourceRepository = {
  async findById(id: string, db: Queryable = pool): Promise<Source | null> {
    const { rows } = await db.query(
      `select ${COLUMNS} from sources where id = $1`,
      [id],
    );
    return rows[0] ? map(rows[0]) : null;
  },

  async findByKey(
    sourceKey: string,
    db: Queryable = pool,
  ): Promise<Source | null> {
    const { rows } = await db.query(
      `select ${COLUMNS} from sources where source_key = $1`,
      [sourceKey],
    );
    return rows[0] ? map(rows[0]) : null;
  },

  async list(): Promise<Source[]> {
    const { rows } = await pool.query(
      `select ${COLUMNS} from sources order by updated_at desc`,
    );
    return rows.map(map);
  },

  /** Insert, or return the existing row for the same key (no duplicates). */
  async findOrCreate(input: {
    sourceKey: string;
    type: SourceType;
    name: string;
    repoUrl?: string | null;
    branch?: string | null;
  }): Promise<{ source: Source; created: boolean }> {
    const { rows } = await pool.query(
      `insert into sources (source_key, type, name, repo_url, branch)
       values ($1, $2, $3, $4, $5)
       on conflict (source_key) do nothing
       returning ${COLUMNS}`,
      [
        input.sourceKey,
        input.type,
        input.name,
        input.repoUrl ?? null,
        input.branch ?? null,
      ],
    );
    if (rows[0]) return { source: map(rows[0]), created: true };
    const existing = await this.findByKey(input.sourceKey);
    if (!existing) throw new Error("Source disappeared during creation");
    return { source: existing, created: false };
  },

  async setStatus(
    id: string,
    status: SourceStatus,
    error: string | null = null,
  ): Promise<void> {
    await pool.query(
      `update sources set status = $2, error = $3 where id = $1`,
      [id, status, error],
    );
  },

  async markIndexed(
    id: string,
    data: { lastCommitSha?: string | null; manifestHash?: string | null },
  ): Promise<void> {
    await pool.query(
      `update sources s set
         status = 'ready',
         error = null,
         last_commit_sha = coalesce($2, s.last_commit_sha),
         manifest_hash = coalesce($3, s.manifest_hash),
         file_count = (select count(*) from documents d where d.source_id = s.id),
         chunk_count = (select count(*) from chunks c where c.source_id = s.id),
         last_indexed_at = now()
       where s.id = $1`,
      [id, data.lastCommitSha ?? null, data.manifestHash ?? null],
    );
  },

  async delete(id: string): Promise<boolean> {
    const res = await pool.query(`delete from sources where id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  },

  /** Sources left in 'indexing' after a crash/restart. */
  async resetStuck(): Promise<number> {
    const res = await pool.query(
      `update sources set status = 'failed', error = 'Indexing interrupted by server restart; please re-run'
       where status = 'indexing'`,
    );
    return res.rowCount ?? 0;
  },
};
