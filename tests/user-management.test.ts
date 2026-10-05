import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import { hash } from '../backend/src/security.js';
import type { PoolLike } from '../backend/src/types.js';

const origin = 'http://127.0.0.1:5173';
const password = 'Disposable-user-management-test-2026';
type Jar = Map<string, string>;
const privateTables = ['trees', 'sessions', 'identities', 'daily_claims', 'ledger', 'game_actions', 'api_keys', 'api_requests', 'model_reply_cursors'];

async function isolatedPool(label: string) {
  const directory = join(tmpdir(), `wisdom-users-${label}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const mode = process.env.DATABASE_MODE, path = process.env.PGLITE_PATH;
  process.env.DATABASE_MODE = 'embedded'; process.env.PGLITE_PATH = directory;
  try { return await getPool(); }
  finally {
    if (mode === undefined) delete process.env.DATABASE_MODE; else process.env.DATABASE_MODE = mode;
    if (path === undefined) delete process.env.PGLITE_PATH; else process.env.PGLITE_PATH = path;
  }
}

async function assertPrivateDataGone(pool: PoolLike, ids: string[]) {
  assert.equal((await pool.query('SELECT id FROM users WHERE id=ANY($1::uuid[])', [ids])).rows.length, 0);
  for (const table of privateTables) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE user_id=ANY($1::uuid[])`, [ids])).rows[0].n, 0, `deleted users must have no ${table} records`);
  }
  assert.equal((await pool.query('SELECT state_hash FROM oauth_states WHERE bind_user_id=ANY($1::uuid[])', [ids])).rows.length, 0);
  assert.equal((await pool.query('SELECT id FROM audit WHERE actor_id=ANY($1::uuid[]) OR target_id=ANY($2::text[])', [ids, ids])).rows.length, 0);
  assert.equal((await pool.query('SELECT id FROM system_update_jobs WHERE actor_id=ANY($1::uuid[])', [ids])).rows.length, 0);
}

test('user deletion and bulk moderation are permanent, atomic and protect administrator access', { timeout: 120_000 }, async t => {
  const pool = await isolatedPool('integration');
  await runMigrations(pool);
  const app = await buildApp({ pool, config: { publicOrigin: origin, secureCookies: false, development: true,
    apiKeyEncryptionKey: randomBytes(32).toString('hex'), githubClientId: '', linuxdoClientId: '' } });
  const adminJar: Jar = new Map();
  async function request(jar: Jar | null, method: string, url: string, payload?: unknown, additional: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...additional };
    if (jar) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (!['GET', 'HEAD'].includes(method)) headers.origin = origin;
    const response = await app.inject({ method: method as any, url, payload: payload as any, headers });
    if (jar) for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  }
  async function ok(jar: Jar | null, method: string, url: string, payload?: unknown, headers?: Record<string, string>) {
    const response = await request(jar, method, url, payload, headers);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
    return response.json();
  }
  async function create(name: string, role = 'user') {
    const user = (await ok(adminJar, 'POST', '/api/admin/users', { username: name, displayName: `${name}-display`, password, role })).user;
    const jar: Jar = new Map();
    await ok(jar, 'POST', '/api/auth/login', { username: name, password });
    return { user, jar };
  }
  const batch = (action: string, ids: string[], jar: Jar | null = adminJar) => request(jar, 'POST', '/api/admin/users/batch', { action, ids });
  let adminId = '';
  try {
    await createAdmin(pool, 'management_admin', password);
    adminId = (await ok(adminJar, 'POST', '/api/auth/login', { username: 'management_admin', password })).user.id;

    await t.test('fresh migration has only active and banned user states', async () => {
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM schema_migrations')).rows[0].n, 11);
      const user = await create('status_constraint');
      await assert.rejects(pool.query("UPDATE users SET status='deleted' WHERE id=$1", [user.user.id]), /check constraint/i);
      assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [user.user.id])).rows[0].status, 'active');
    });

    await t.test('hard deletion removes all owned data, invalidates access and anonymizes system history', async () => {
      const { user, jar } = await create('permanent_victim', 'admin');
      await ok(adminJar, 'POST', `/api/admin/users/${user.id}/adjust`, { coinsDelta: 20 });
      await ok(jar, 'POST', '/api/tree/seed', {}, { 'Idempotency-Key': randomUUID() });
      await ok(jar, 'POST', '/api/tree/plant', {}, { 'Idempotency-Key': randomUUID() });
      await ok(jar, 'POST', '/api/tree/claim-fertilizer', {}, { 'Idempotency-Key': randomUUID() });
      await ok(jar, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() });
      const key = (await ok(jar, 'POST', '/api/keys', { name: 'Owned disposable key' })).key;
      await ok(null, 'POST', '/v1/responses', { model: 'wisdom-tree', input: 'test' }, { authorization: 'Bearer ' + key });
      const providerId = 'deleted-provider-' + randomUUID();
      await pool.query('INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), user.id, 'linuxdo', providerId, user.displayName]);
      await pool.query("INSERT INTO oauth_states(state_hash,provider,bind_user_id,session_hash,verifier,expires_at) VALUES($1,'github',$2,$3,'disposable-verifier',now()+interval '5 minutes')", [hash(randomUUID()), user.id, hash(randomUUID())]);
      const actorAuditId = randomUUID();
      await pool.query("INSERT INTO audit(id,actor_id,actor_name,action,target_id,reason,before_value,after_value) VALUES($1,$2,$3,'settings.update','settings','管理员操作',$4::jsonb,$5::jsonb)", [actorAuditId, user.id, user.displayName, '{"inventoryLimit":10}', '{"inventoryLimit":9}']);
      const jobId = randomUUID();
      await pool.query("INSERT INTO system_update_jobs(id,actor_id,target_sha,status,expires_at) VALUES($1,$2,$3,'failed',now()+interval '1 hour')", [jobId, user.id, 'a'.repeat(40)]);
      for (const table of privateTables) assert.ok((await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE user_id=$1`, [user.id])).rows[0].n > 0, `fixture must exercise ${table}`);
      const response = await ok(adminJar, 'DELETE', `/api/admin/users/${user.id}`);
      assert.deepEqual(response, { ok: true, action: 'delete', affected: 1, ids: [user.id] });
      await assertPrivateDataGone(pool, [user.id]);
      assert.equal((await ok(jar, 'GET', '/api/me')).user, null);
      assert.equal((await request(jar, 'POST', '/api/auth/login', { username: user.username, password })).statusCode, 401);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + key })).statusCode, 401);
      assert.equal((await request(adminJar, 'GET', `/api/admin/users/${user.id}`)).statusCode, 404);
      assert.equal((await request(adminJar, 'DELETE', `/api/admin/users/${user.id}`)).statusCode, 404);
      const actorAudit = (await pool.query('SELECT * FROM audit WHERE id=$1', [actorAuditId])).rows[0];
      assert.equal(actorAudit.actor_id, null); assert.equal(actorAudit.actor_name, '已删除管理员');
      assert.equal((await pool.query('SELECT actor_id FROM system_update_jobs WHERE id=$1', [jobId])).rows[0].actor_id, null);
      const auditText = JSON.stringify((await pool.query('SELECT * FROM audit')).rows);
      assert.ok(!auditText.includes(user.id)); assert.ok(!auditText.includes(user.username)); assert.ok(!auditText.includes(user.displayName));
      const deletion = (await pool.query("SELECT target_id,before_value,after_value FROM audit WHERE action='user.delete' ORDER BY created_at DESC LIMIT 1")).rows[0];
      assert.deepEqual(deletion, { target_id: 'users', before_value: null, after_value: { deleted: 1 } });
      const replacement = await create(user.username);
      assert.notEqual(replacement.user.id, user.id);
      await pool.query('INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), replacement.user.id, 'linuxdo', providerId, 'New account']);
      assert.equal((await ok(adminJar, 'GET', `/api/admin/users/${replacement.user.id}`)).identities[0].providerUserId, providerId, 'third-party bindings are reusable after deletion');
    });

    await t.test('legacy PATCH deleted performs physical deletion rather than a hidden tombstone', async () => {
      const { user } = await create('legacy_delete_request');
      const response = await ok(adminJar, 'PATCH', `/api/admin/users/${user.id}`, { status: 'deleted' });
      assert.deepEqual(response, { ok: true, action: 'delete', affected: 1, ids: [user.id] });
      await assertPrivateDataGone(pool, [user.id]);
    });

    await t.test('batch validates permissions, action, limits and UUIDs before mutating', async () => {
      const ordinary = await create('batch_no_privilege');
      assert.equal((await batch('ban', [ordinary.user.id], null)).statusCode, 401);
      assert.equal((await batch('delete', [ordinary.user.id], ordinary.jar)).statusCode, 403);
      for (const payload of [
        { action: 'ban', ids: [] }, { action: 'ban', ids: Array.from({ length: 101 }, () => randomUUID()) },
        { action: 'invalid', ids: [ordinary.user.id] }, { action: 'ban', ids: ['not-a-uuid'] },
        { action: 'ban', ids: ordinary.user.id }, { ids: [ordinary.user.id] },
      ]) assert.equal((await request(adminJar, 'POST', '/api/admin/users/batch', payload)).statusCode, 400);
      assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [ordinary.user.id])).rows[0].status, 'active');
    });

    await t.test('a full 100-user batch succeeds and the upper bound is enforced before deduplication', async () => {
      const ids = Array.from({ length: 100 }, () => randomUUID());
      await pool.query("INSERT INTO users(id,username,display_name) SELECT id,'bulk_limit_'||ordinality,'Boundary '||ordinality FROM unnest($1::uuid[]) WITH ORDINALITY AS input(id,ordinality)", [ids]);
      await pool.query('INSERT INTO trees(user_id) SELECT unnest($1::uuid[])', [ids]);
      const banned = await batch('ban', ids);
      assert.equal(banned.statusCode, 200); assert.equal(banned.json().affected, 100);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM users WHERE id=ANY($1::uuid[]) AND status='banned'", [ids])).rows[0].n, 100);
      assert.equal((await batch('unban', Array.from({ length: 101 }, () => ids[0]))).statusCode, 400);
      assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [ids[0]])).rows[0].status, 'banned');
      const deleted = await batch('delete', ids);
      assert.equal(deleted.statusCode, 200); assert.equal(deleted.json().affected, 100);
      await assertPrivateDataGone(pool, ids);
    });

    await t.test('bulk ban and unban deduplicate users and revoke existing sessions immediately', async () => {
      const first = await create('batch_first'), second = await create('batch_second');
      await ok(adminJar, 'POST', `/api/admin/users/${first.user.id}/adjust`, { coinsDelta: 4 });
      const key = (await ok(first.jar, 'POST', '/api/keys', { name: 'Ban check' })).key;
      const before = (await ok(adminJar, 'GET', `/api/admin/users/${first.user.id}`)).user;
      const secondBefore = (await ok(adminJar, 'GET', `/api/admin/users/${second.user.id}`)).user;
      const banned = await batch('ban', [first.user.id.toUpperCase(), first.user.id, second.user.id]);
      assert.equal(banned.statusCode, 200);
      assert.equal(banned.json().affected, 2); assert.deepEqual(new Set(banned.json().ids), new Set([first.user.id, second.user.id]));
      const bans = (await pool.query("SELECT actor_id,target_id,before_value,after_value FROM audit WHERE action='user.batch.ban' AND target_id=ANY($1::text[])", [[first.user.id, second.user.id]])).rows;
      assert.equal(bans.length, 2, 'each unique selected user has an attributable status-change audit');
      for (const snapshot of [before, secondBefore]) {
        const entry = bans.find(row => row.target_id === snapshot.id);
        assert.equal(entry.actor_id, adminId);
        assert.deepEqual(entry.before_value, snapshot);
        assert.deepEqual(entry.after_value, { ...snapshot, status: 'banned' });
      }
      for (const item of [first, second]) {
        assert.equal((await ok(item.jar, 'GET', '/api/me')).user, null);
        assert.equal((await request(item.jar, 'POST', '/api/auth/login', { username: item.user.username, password })).statusCode, 401);
        assert.equal((await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [item.user.id])).rows.length, 0);
      }
      assert.equal((await request(null, 'POST', '/v1/responses', { model: 'wisdom-tree', input: 'blocked' }, { authorization: 'Bearer ' + key })).statusCode, 401);
      assert.equal((await ok(adminJar, 'GET', `/api/admin/users/${first.user.id}`)).user.coins, before.coins);
      assert.equal((await batch('unban', [first.user.id, second.user.id])).statusCode, 200);
      const unbans = (await pool.query("SELECT actor_id,target_id,before_value,after_value FROM audit WHERE action='user.batch.unban' AND target_id=ANY($1::text[])", [[first.user.id, second.user.id]])).rows;
      assert.equal(unbans.length, 2);
      for (const snapshot of [before, secondBefore]) {
        const entry = unbans.find(row => row.target_id === snapshot.id);
        assert.equal(entry.actor_id, adminId);
        assert.deepEqual(entry.before_value, { ...snapshot, status: 'banned' });
        assert.deepEqual(entry.after_value, snapshot);
      }
      assert.equal((await pool.query("SELECT id FROM audit WHERE action IN ('user.batch.ban','user.batch.unban') AND target_id='users'")).rows.length, 0, 'bulk moderation must not retain multi-user profiles in a global audit target');
      assert.equal((await ok(first.jar, 'GET', '/api/me')).user, null, 'unbanning does not resurrect invalidated sessions');
      await ok(first.jar, 'POST', '/api/auth/login', { username: first.user.username, password });
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + key })).statusCode, 200, 'unbanning restores otherwise valid API keys');
      assert.equal((await batch('delete', [first.user.id, second.user.id])).json().affected, 2);
      await assertPrivateDataGone(pool, [first.user.id, second.user.id]);
      const moderationHistory = JSON.stringify((await pool.query("SELECT * FROM audit WHERE action IN ('user.batch.ban','user.batch.unban')")).rows);
      for (const user of [first.user, second.user]) {
        for (const personal of [user.id, user.username, user.displayName]) assert.ok(!moderationHistory.includes(personal), 'hard deletion erases previously audited moderation profiles');
      }
      const deletion = (await pool.query("SELECT target_id,before_value,after_value FROM audit WHERE action='user.batch.delete' ORDER BY created_at DESC LIMIT 1")).rows[0];
      assert.deepEqual(deletion, { target_id: 'users', before_value: null, after_value: { deleted: 2 } });
    });

    await t.test('one missing or protected user rolls back the entire batch', async () => {
      const first = await create('atomic_first'), second = await create('atomic_second');
      const rowsBefore = (await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.user.id, second.user.id]])).rows;
      const auditsBefore = (await pool.query('SELECT count(*)::integer AS n FROM audit')).rows[0].n;
      for (const action of ['ban', 'unban', 'delete']) {
        assert.equal((await batch(action, [first.user.id, randomUUID(), second.user.id])).statusCode, 404);
        assert.deepEqual((await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.user.id, second.user.id]])).rows, rowsBefore);
        assert.equal((await pool.query('SELECT count(*)::integer AS n FROM audit')).rows[0].n, auditsBefore);
      }
      for (const action of ['ban', 'delete']) {
        assert.equal((await batch(action, [first.user.id, adminId, second.user.id])).statusCode, 409);
        assert.deepEqual((await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.user.id, second.user.id]])).rows, rowsBefore);
        assert.equal((await ok(first.jar, 'GET', '/api/me')).user.id, first.user.id, 'rollback preserves target sessions');
        assert.equal((await ok(adminJar, 'GET', '/api/me')).user.role, 'admin');
      }
    });

    await t.test('selecting every active administrator is rejected even when each alone could be removed', async () => {
      const extra = await create('select_all_admin', 'admin');
      for (const action of ['ban', 'delete']) assert.equal((await batch(action, [adminId, extra.user.id])).statusCode, 409);
      assert.equal((await ok(extra.jar, 'GET', '/api/me')).user.role, 'admin');
      await ok(adminJar, 'DELETE', `/api/admin/users/${extra.user.id}`);
    });

    await t.test('concurrent self-ban and self-delete retain exactly one active administrator', async () => {
      const extra = await create('race_admin', 'admin');
      const results = await Promise.all([
        request(extra.jar, 'DELETE', `/api/admin/users/${extra.user.id}`),
        batch('ban', [adminId]),
      ]);
      const codes = results.map(result => result.statusCode);
      assert.equal(codes.filter(code => code === 200).length, 1, `one operation must commit: ${codes.join(',')}`);
      assert.ok(codes.every(code => [200, 401, 403, 409].includes(code)));
      const active = (await pool.query("SELECT id FROM users WHERE role='admin' AND status='active'")).rows;
      assert.equal(active.length, 1, 'concurrent deletion and banning must never remove all active administrators');
      if (active[0].id === extra.user.id) {
        await ok(extra.jar, 'PATCH', `/api/admin/users/${adminId}`, { status: 'active' });
        await ok(adminJar, 'POST', '/api/auth/login', { username: 'management_admin', password });
        await ok(adminJar, 'DELETE', `/api/admin/users/${extra.user.id}`);
      }
      assert.equal((await ok(adminJar, 'GET', '/api/me')).user.role, 'admin');
    });
  } finally { await app.close(); await pool.end(); }
});

test('migration physically purges historical deleted users without changing active or banned accounts', { timeout: 120_000 }, async () => {
  const pool = await isolatedPool('upgrade');
  const directory = new URL('../backend/migrations/', import.meta.url);
  try {
    const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    const upgradeName = names.find(name => name.startsWith('011_'));
    assert.ok(upgradeName, 'a versioned upgrade is required for existing databases');
    for (const name of names.filter(name => name < upgradeName!)) {
      await pool.query(await readFile(new URL(name, directory), 'utf8'));
      await pool.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
    const adminId = randomUUID(), deletedId = randomUUID(), bannedId = randomUUID();
    for (const [id, name, role, status] of [[adminId, 'migration_admin', 'admin', 'active'], [deletedId, 'legacy_deleted_private', 'admin', 'deleted'], [bannedId, 'legacy_banned', 'user', 'banned']]) {
      await pool.query('INSERT INTO users(id,username,display_name,role,status) VALUES($1,$2,$2,$3,$4)', [id, name, role, status]);
      await pool.query('INSERT INTO trees(user_id) VALUES($1)', [id]);
    }
    await pool.query("INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,'github','legacy-third-party','legacy_deleted_private')", [randomUUID(), deletedId]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(randomUUID()), deletedId]);
    await pool.query("INSERT INTO oauth_states(state_hash,provider,bind_user_id,verifier,expires_at) VALUES($1,'github',$2,'legacy',now()+interval '5 minutes')", [hash(randomUUID()), deletedId]);
    await pool.query("INSERT INTO ledger(id,user_id,kind,reason) VALUES($1,$2,'admin_adjustment','legacy balance')", [randomUUID(), deletedId]);
    const ownedAuditId = randomUUID(), targetedAuditId = randomUUID(), updateJobId = randomUUID();
    await pool.query("INSERT INTO audit(id,actor_id,actor_name,action,target_id,reason,before_value) VALUES($1,$2,'legacy_deleted_private','settings.update','settings','legacy reason','{}'::jsonb)", [ownedAuditId, deletedId]);
    await pool.query("INSERT INTO audit(id,actor_id,actor_name,action,target_id,reason,before_value,after_value) VALUES($1,$2,'migration_admin','user.update',$3,'legacy reason',$4::jsonb,$4::jsonb)", [targetedAuditId, adminId, deletedId, JSON.stringify({ username: 'legacy_deleted_private', id: deletedId })]);
    await pool.query("INSERT INTO system_update_jobs(id,actor_id,target_sha,status,expires_at) VALUES($1,$2,$3,'failed',now()+interval '1 hour')", [updateJobId, deletedId, 'b'.repeat(40)]);
    const retainedBefore = (await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [[adminId, bannedId]])).rows;
    await runMigrations(pool);
    await assertPrivateDataGone(pool, [deletedId]);
    assert.deepEqual((await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [[adminId, bannedId]])).rows, retainedBefore);
    const owned = (await pool.query('SELECT actor_id,actor_name FROM audit WHERE id=$1', [ownedAuditId])).rows[0];
    assert.deepEqual(owned, { actor_id: null, actor_name: '已删除管理员' });
    const targeted = (await pool.query('SELECT target_id,before_value,after_value FROM audit WHERE id=$1', [targetedAuditId])).rows[0];
    assert.deepEqual(targeted, { target_id: 'deleted-user', before_value: null, after_value: null });
    assert.equal((await pool.query('SELECT actor_id FROM system_update_jobs WHERE id=$1', [updateJobId])).rows[0].actor_id, null);
    const history = JSON.stringify((await pool.query('SELECT * FROM audit')).rows);
    assert.ok(!history.includes('legacy_deleted_private')); assert.ok(!history.includes(deletedId));
    await runMigrations(pool);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM schema_migrations')).rows[0].n, 11, 'upgrade can be retried without duplicating migrations');
    await assert.rejects(pool.query("UPDATE users SET status='deleted' WHERE id=$1", [bannedId]), /check constraint/i);
  } finally { await pool.end(); }
});
