import fs from "node:fs";
import pg from "pg";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

function sslOptions(): pg.PoolConfig["ssl"] {
  if (!config.db.ssl) return undefined;
  if (config.db.sslCaPath) {
    return {
      ca: fs.readFileSync(config.db.sslCaPath, "utf8"),
      rejectUnauthorized: true,
    };
  }
  logger.warn(
    "PGSSL=true without PG_SSL_CA_PATH: traffic is encrypted but the server certificate is not verified. " +
      "Set PG_SSL_CA_PATH to Supabase's CA certificate for full verification.",
  );
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: sslOptions(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) =>
  logger.error("Postgres pool error", { error: err.message }),
);

export type Queryable = pg.Pool | pg.PoolClient;

/** Run `fn` inside a transaction; rolls back on error. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** pgvector literal: [0.1,0.2,...] */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function checkDatabase(): Promise<void> {
  const { rows } = await pool.query<{ ok: boolean }>(
    "select exists(select 1 from pg_extension where extname = 'vector') as ok",
  );
  if (!rows[0]?.ok) {
    throw new Error(
      "pgvector extension is not enabled. Run src/data/migrations/001_init.sql in Supabase.",
    );
  }
  const t = await pool.query<{ ok: boolean }>(
    "select to_regclass('public.chunks') is not null as ok",
  );
  if (!t.rows[0]?.ok) {
    throw new Error(
      "Tables are missing. Run src/data/migrations/001_init.sql in the Supabase SQL editor.",
    );
  }
  const m = await pool.query<{ ok: boolean }>(
    "select to_regclass('public.source_documents') is not null as ok",
  );
  if (!m.rows[0]?.ok) {
    throw new Error(
      "Branch de-duplication tables are missing. Run src/data/migrations/003_branch_dedup.sql in the Supabase SQL editor.",
    );
  }
}
