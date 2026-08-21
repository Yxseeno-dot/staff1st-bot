import pg from "pg";
import { config } from "./config.js";

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
});

export type DbClient = Pick<pg.PoolClient, "query">;

// pg.Pool emits 'error' when an idle client's connection drops (DB restart,
// network blip) — without a listener, EventEmitter's default behaviour is to
// throw, which crashes this whole always-on polling process. Log and move on
// instead; the pool recovers by opening a new connection on the next query.
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err);
});

export async function query<T extends pg.QueryResultRow>(sql: string, params?: unknown[], client?: DbClient): Promise<T[]> {
  const res = await (client ?? pool).query<T>(sql, params);
  return res.rows as T[];
}

export async function queryOne<T extends pg.QueryResultRow>(sql: string, params?: unknown[], client?: DbClient): Promise<T | null> {
  const res = await (client ?? pool).query<T>(sql, params);
  return (res.rows[0] as T) ?? null;
}

export async function execute(sql: string, params?: unknown[], client?: DbClient): Promise<void> {
  await (client ?? pool).query(sql, params);
}

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
