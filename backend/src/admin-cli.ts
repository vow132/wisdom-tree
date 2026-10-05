import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getPool, transaction } from './db.js';
import { runMigrations } from './migrate.js';
import { hashPassword, password, username, text, fail } from './security.js';
import type { PoolLike } from './types.js';

export async function createAdmin(pool: PoolLike, account: string, secret: string, displayName = '管理员'): Promise<{ id: string; username: string }> {
  const normalized = username(account); const encoded = await hashPassword(password(secret)); const display = text(displayName, '昵称', 64);
  return transaction(pool, async db => {
    await db.query('SELECT id FROM admin_guard WHERE id=true FOR UPDATE');
    if ((await db.query('SELECT id FROM users WHERE username=$1', [normalized])).rows.length) fail(409, 'already_exists', '该账号已存在，请从管理员后台管理角色。');
    const id = randomUUID();
    await db.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,\'admin\')', [id, normalized, display, encoded]);
    await db.query('INSERT INTO trees(user_id) VALUES($1)', [id]);
    await db.query('INSERT INTO audit(id,actor_id,actor_name,action,target_id,reason,after_value) VALUES($1,$2,$3,\'admin.bootstrap\',$5,\'管理员 CLI 创建\',$4::jsonb)', [randomUUID(), id, normalized, JSON.stringify({ username: normalized, role: 'admin' }), id]);
    return { id, username: normalized };
  });
}
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const account = flag('--username') || process.env.ADMIN_USERNAME;
  const secret = flag('--password') || process.env.ADMIN_PASSWORD;
  if (!account || !secret) throw new Error('请提供 --username / --password，或 ADMIN_USERNAME / ADMIN_PASSWORD。');
  const pool = await getPool();
  try {
    await runMigrations(pool);
    const result = await createAdmin(pool, account, secret, flag('--display-name') || '管理员');
    console.log(`管理员 ${result.username} 已创建。`);
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(`管理员创建失败：${error instanceof Error ? error.message : '请检查数据库配置。'}`);
    process.exitCode = 1;
  });
}
