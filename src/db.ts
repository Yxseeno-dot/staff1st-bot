import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// pg.Pool emits 'error' when an idle client's connection drops (DB restart,
// network blip) — without a listener, EventEmitter's default behaviour is to
// throw, which crashes this whole always-on polling process. Log and move on
// instead; the pool recovers by opening a new connection on the next query.
pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err);
});

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const res = await pool.query(sql, params);
  return (res.rows[0] as T) ?? null;
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  await pool.query(sql, params);
}
