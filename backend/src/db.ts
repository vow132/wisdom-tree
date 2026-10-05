import pg from 'pg';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from './env.js';
import { PGlite } from '@electric-sql/pglite';
import type { ClientLike, PoolLike, QueryResult } from './types.js';

export async function getPool(): Promise<PoolLike> {
  if (process.env.DATABASE_MODE === 'embedded') {
    const db = new PGlite(resolve(PROJECT_ROOT, process.env.PGLITE_PATH || process.env.PGLITE_DATA_DIR || '.local/preview-db'));
    await db.waitReady;
    let tail: Promise<void> = Promise.resolve();
    const acquire = async () => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      return release;
    };
    async function query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
      if (!params.length && sql.split(';').filter(part => part.trim()).length > 1) {
        const results = await db.exec(sql);
        const last = results.at(-1);
        return { rows: (last?.rows || []) as T[], rowCount: last?.affectedRows ?? 0 };
      }
      const result = await db.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }
    return {
      async query<T>(sql: string, params?: any[]) {
        const release = await acquire();
        try { return await query<T>(sql, params); } finally { release(); }
      },
      async connect() {
        const release = await acquire();
        let released = false;
        return { query, release() { if (!released) { released = true; release(); } } };
      },
      async end() { const release = await acquire(); try { await db.close(); } finally { release(); } },
    };
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. For local preview only, set DATABASE_MODE=embedded.');
  const max = Number(process.env.DB_POOL_MAX || 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('DB_POOL_MAX must be an integer between 1 and 20.');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 }) as unknown as PoolLike;
}

export async function transaction<T>(pool: PoolLike, fn: (client: ClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
