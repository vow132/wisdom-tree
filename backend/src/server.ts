import { getPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';

async function main() {
const pool = await getPool();
try {
  await runMigrations(pool);
  const app = await buildApp({ pool });
  await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
  console.log(`Wisdom Tree API listening on ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await app.close(); await pool.end();
  };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
} catch (error) { await pool.end(); throw error; }
}
await main().catch(error => {
  console.error(`服务启动失败：${error instanceof Error ? error.message : '请检查数据库与监听配置。'}`);
  process.exitCode = 1;
});
