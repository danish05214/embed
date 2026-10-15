import { pool } from "../db.js";
import type { Job, JobProgress, JobStatus } from "../types.js";

export const emptyProgress = (): JobProgress => ({
  filesTotal: 0,
  filesProcessed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  filesFailed: 0,
  chunksEmbedded: 0,
  chunksReused: 0,
});

function map(r: Record<string, unknown>): Job {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    kind: r.kind as Job["kind"],
    status: r.status as JobStatus,
    progress: { ...emptyProgress(), ...(r.progress as JobProgress) },
    error: (r.error as string) ?? null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export const jobRepository = {
  async create(sourceId: string, kind: Job["kind"]): Promise<Job> {
    const { rows } = await pool.query(
      `insert into jobs (source_id, kind, progress) values ($1, $2, $3) returning *`,
      [sourceId, kind, JSON.stringify(emptyProgress())],
    );
    return map(rows[0]);
  },

  async findById(id: string): Promise<Job | null> {
    const { rows } = await pool.query(`select * from jobs where id = $1`, [id]);
    return rows[0] ? map(rows[0]) : null;
  },

  async latestForSource(sourceId: string): Promise<Job | null> {
    const { rows } = await pool.query(
      `select * from jobs where source_id = $1 order by created_at desc limit 1`,
      [sourceId],
    );
    return rows[0] ? map(rows[0]) : null;
  },

  async activeForSource(sourceId: string): Promise<Job | null> {
    const { rows } = await pool.query(
      `select * from jobs where source_id = $1 and status in ('queued','running') order by created_at desc limit 1`,
      [sourceId],
    );
    return rows[0] ? map(rows[0]) : null;
  },

  async markRunning(id: string): Promise<void> {
    await pool.query(`update jobs set status = 'running', started_at = now() where id = $1`, [id]);
  },

  async updateProgress(id: string, progress: JobProgress): Promise<void> {
    await pool.query(`update jobs set progress = $2 where id = $1`, [id, JSON.stringify(progress)]);
  },

  async finish(id: string, status: "succeeded" | "failed", progress: JobProgress, error: string | null = null) {
    await pool.query(
      `update jobs set status = $2, progress = $3, error = $4, finished_at = now() where id = $1`,
      [id, status, JSON.stringify(progress), error],
    );
  },

  /** Jobs left running after a crash/restart can never finish; mark them failed. */
  async failInterrupted(): Promise<number> {
    const res = await pool.query(
      `update jobs set status = 'failed', error = 'Interrupted by server restart', finished_at = now()
       where status in ('queued', 'running')`,
    );
    return res.rowCount ?? 0;
  },
};
