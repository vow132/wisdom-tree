import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import { hash } from '../backend/src/security.js';
import type { PoolLike } from '../backend/src/types.js';

// Always create and remove our own schema; never migrate the caller's public schema.
test('PostgreSQL 17 migration, row locking, billing and SDK integration', { timeout: 120_000 }, async t => {
  const connectionString = process.env.CI_DATABASE_URL;
  assert.ok(connectionString, 'Set CI_DATABASE_URL to a disposable PostgreSQL 17 database.');
  const schema = 'ci_' + randomUUID().replaceAll('-', '');
  const control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const database = new pg.Pool({ connectionString, options: '-c search_path=' + schema, max: 10, connectionTimeoutMillis: 10_000 });
  const pool = database as unknown as PoolLike;
  const origin = 'http://127.0.0.1:5173';
  const master = randomBytes(32).toString('hex');
  const password = 'Disposable-CI-account-2026!';
  const app = await buildApp({ pool, config: { publicOrigin: origin, secureCookies: false, development: false, apiKeyEncryptionKey: master } });
  type Jar = Map<string, string>;
  const adminJar: Jar = new Map();
  const userJar: Jar = new Map();
  async function request(jar: Jar | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await app.inject({ method: method as any, url, payload: body as any, headers: {
      ...headers,
      ...(!['GET', 'HEAD'].includes(method) ? { origin } : {}),
      ...(jar ? { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') } : {}),
    } });
    if (jar) for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  }
  async function ok(jar: Jar | null, method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    const response = await request(jar, method, url, body, headers);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: HTTP ${response.statusCode}`);
    return response.json();
  }
  const action = (name: string, key = randomUUID()) => request(userJar, 'POST', '/api/tree/' + name, {}, { 'Idempotency-Key': key });
  const me = () => ok(userJar, 'GET', '/api/me');
  let schemaCreated = false;
  let adminId = '';
  let userId = '';
  let apiKey = '';
  try {
    const version = Number((await control.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 170000 && version < 180000, 'This acceptance suite requires PostgreSQL 17.');
    await control.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await t.test('fresh migrations run twice and preserve the complete wisdom corpus', async () => {
      await runMigrations(pool);
      await runMigrations(pool);
      const files = (await readdir(new URL('../backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql'));
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM schema_migrations')).rows[0].count, files.length);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM model_replies WHERE model_id='wisdom-tree'")).rows[0].count, 80);
    });
    await t.test('admin bootstrap, password login and account registration', async () => {
      await createAdmin(pool, 'ci_admin', password);
      adminId = (await ok(adminJar, 'POST', '/api/auth/login', { username: 'ci_admin', password })).user.id;
      userId = (await ok(userJar, 'POST', '/api/auth/register', { username: 'ci_gardener', password, displayName: 'CI gardener' })).user.id;
      assert.equal((await request(userJar, 'GET', '/api/admin/users')).statusCode, 403);
      assert.equal((await me()).user.coins, 0);
    });
    await t.test('concurrent seed and feeding replay only award once', async () => {
      const seedKey = randomUUID();
      const seeds = await Promise.all(Array.from({ length: 8 }, () => action('seed', seedKey)));
      assert.ok(seeds.every(response => response.statusCode === 200));
      for (const response of seeds) assert.deepEqual(response.json(), seeds[0].json());
      assert.equal((await action('seed')).statusCode, 409);
      assert.equal((await action('plant')).statusCode, 200);
      assert.equal((await action('claim-fertilizer')).statusCode, 200);
      const feedKey = randomUUID();
      const feeds = await Promise.all(Array.from({ length: 8 }, () => action('feed', feedKey)));
      assert.ok(feeds.every(response => response.statusCode === 200));
      for (const response of feeds) assert.deepEqual(response.json(), feeds[0].json());
      const after = await me();
      assert.equal(after.tree.height, 2);
      assert.equal(after.user.fertilizer, 4);
      assert.equal(after.user.coins, 10);
      const distinct = await Promise.all(Array.from({ length: 8 }, () => action('feed')));
      assert.equal(distinct.filter(response => response.statusCode === 200).length, 4);
      assert.equal(distinct.filter(response => response.statusCode === 409).length, 4);
      const exhausted = await me();
      assert.equal(exhausted.tree.height, 6);
      assert.equal(exhausted.user.fertilizer, 0);
      assert.equal(exhausted.user.coins, 50);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM ledger WHERE user_id=$1 AND kind='feed'", [userId])).rows[0].count, 5);
    });
    await t.test('API keys remain encrypted and recoverable only by their owner', async () => {
      const created = await ok(userJar, 'POST', '/api/keys', { name: 'PostgreSQL CI' });
      apiKey = created.key;
      assert.ok(apiKey.startsWith('sk_'));
      const stored = (await pool.query('SELECT key_hash,key_ciphertext FROM api_keys WHERE id=$1', [created.item.id])).rows[0];
      assert.equal(stored.key_hash, hash(apiKey));
      assert.ok(!stored.key_ciphertext.includes(apiKey));
      assert.equal((await ok(userJar, 'GET', '/api/keys')).items[0].key, apiKey);
      assert.equal((await ok(adminJar, 'GET', '/api/keys')).items.length, 0);
    });
    const apiHeaders = () => ({ authorization: 'Bearer ' + apiKey });
    const payload = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'concurrent acceptance' }] };
    await t.test('separate concurrent requests cannot overspend the balance', async () => {
      await pool.query('UPDATE users SET coins=3 WHERE id=$1', [userId]);
      const calls = await Promise.all(Array.from({ length: 12 }, () => request(null, 'POST', '/v1/chat/completions', payload, { ...apiHeaders(), 'Idempotency-Key': randomUUID() })));
      assert.equal(calls.filter(response => response.statusCode === 200).length, 3);
      assert.equal(calls.filter(response => response.statusCode === 402).length, 9);
      assert.equal((await me()).user.coins, 0);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM api_requests WHERE user_id=$1', [userId])).rows[0].count, 3);
      assert.equal(Number((await pool.query("SELECT sum(coins_delta) AS total FROM ledger WHERE user_id=$1 AND kind='api_call'", [userId])).rows[0].total), -3);
    });
    await t.test('concurrent API replays charge once and payload conflicts are free', async () => {
      await pool.query('UPDATE users SET coins=10 WHERE id=$1', [userId]);
      const key = randomUUID();
      const calls = await Promise.all(Array.from({ length: 8 }, () => request(null, 'POST', '/v1/chat/completions', payload, { ...apiHeaders(), 'Idempotency-Key': key })));
      assert.ok(calls.every(response => response.statusCode === 200));
      assert.equal(new Set(calls.map(response => response.body)).size, 1);
      assert.equal((await me()).user.coins, 9);
      const conflict = await request(null, 'POST', '/v1/chat/completions', { ...payload, messages: [{ role: 'user', content: 'different input' }] }, { ...apiHeaders(), 'Idempotency-Key': key });
      assert.equal(conflict.statusCode, 409);
      assert.equal((await me()).user.coins, 9);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM api_requests WHERE user_id=$1', [userId])).rows[0].count, 4);
    });
    await t.test('official SDKs parse Chat, Responses and Anthropic JSON and SSE', async () => {
      await pool.query('UPDATE users SET coins=100 WHERE id=$1', [userId]);
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address !== 'string');
      const baseURL = 'http://127.0.0.1:' + address.port;
      const openai = new OpenAI({ apiKey, baseURL: baseURL + '/v1', maxRetries: 0 });
      const anthropic = new Anthropic({ apiKey, authToken: null, baseURL, maxRetries: 0 });
      assert.ok((await openai.models.list()).data.length >= 3);
      const chat = await openai.chat.completions.create({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }] });
      let text = '';
      for await (const part of await openai.chat.completions.create({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }], stream: true })) text += part.choices[0]?.delta.content || '';
      assert.equal(text, chat.choices[0].message.content);
      const response = await openai.responses.create({ model: 'gpt-5.6-sol', input: 'hello' });
      assert.equal((await openai.responses.stream({ model: 'gpt-5.6-sol', input: 'hello' }).finalResponse()).output_text, response.output_text);
      const message = await anthropic.messages.create({ model: 'claude-fable-5.1', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] });
      assert.deepEqual((await anthropic.messages.stream({ model: 'claude-fable-5.1', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }).finalMessage()).content, message.content);
      assert.ok((await anthropic.messages.countTokens({ model: 'claude-fable-5.1', messages: [{ role: 'user', content: 'hello' }] })).input_tokens > 0);
      assert.equal((await me()).user.coins, 84);
    });
    await t.test('model rename cascades references but preserves accepted reply snapshots', async () => {
      const before = (await pool.query("SELECT id,result,coins_charged FROM api_requests WHERE model_id='gpt-5.6-luna' ORDER BY created_at,id LIMIT 1")).rows[0];
      await ok(adminJar, 'PATCH', '/api/admin/models/gpt-5.6-luna', { id: 'ci-luna', coinsPerCall: 2 });
      const after = (await pool.query('SELECT model_id,result,coins_charged FROM api_requests WHERE id=$1', [before.id])).rows[0];
      assert.equal(after.model_id, 'ci-luna');
      assert.deepEqual(after.result, before.result);
      assert.equal(after.coins_charged, before.coins_charged);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM model_replies WHERE model_id='ci-luna'")).rows[0].count, 1);
    });
    await t.test('last-admin protection and bans immediately revoke sessions and API access', async () => {
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/users/' + adminId, { role: 'user' })).statusCode, 409);
      assert.equal((await request(adminJar, 'DELETE', '/api/admin/users/' + adminId)).statusCode, 409);
      await ok(adminJar, 'PATCH', '/api/admin/users/' + userId, { status: 'banned' });
      assert.equal((await me()).user, null);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, apiHeaders())).statusCode, 401);
      assert.equal((await request(userJar, 'POST', '/api/auth/login', { username: 'ci_gardener', password })).statusCode, 401);
    });
  } finally {
    await app.close().catch(() => undefined);
    await database.end();
    try { if (schemaCreated) await control.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await control.end(); }
  }
});
