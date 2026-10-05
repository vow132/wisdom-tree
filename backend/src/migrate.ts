import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { PoolLike } from './types.js';
import { getPool, transaction } from './db.js';

export async function runMigrations(pool: PoolLike): Promise<void> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  await transaction(pool, async db => {
    await db.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const name of files) {
      if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length) continue;
      await db.query(await readFile(join(directory, name), 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  });
}
async function main() {
  const pool = await getPool();
  try { await runMigrations(pool); console.log('数据库迁移完成。'); } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(`数据库迁移失败：${error instanceof Error ? error.message : '请检查数据库配置。'}`);
    process.exitCode = 1;
  });
}
