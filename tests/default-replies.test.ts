import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import { DEFAULT_MODEL_REPLY } from '../backend/src/default-reply.js';
import { estimateTokens, limitText } from '../backend/src/simulator.js';

const origin = 'http://127.0.0.1:5173';
const password = 'Disposable-default-reply-password-2026';
const legacyReply = '智慧树说：每天照料一点，耐心就会发芽。';
const seededModels = ['gpt-5.6-luna', 'gpt-5.6-sol', 'claude-sonnet-4-6'];
type Jar = Map<string, string>;

test('public default seeds and long ASCII replies survive fresh installs and upgrades', { timeout: 120_000 }, async t => {
  const dataDir = join(tmpdir(), 'wisdom-default-replies-' + randomUUID());
  await mkdir(dataDir, { recursive: true });
  const oldMode = process.env.DATABASE_MODE;
  const oldPath = process.env.PGLITE_PATH;
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = dataDir;
  const pool = await getPool();
  const corpus = JSON.parse(await readFile(new URL('../backend/data/wisdom-tree-quotes.json', import.meta.url), 'utf8')) as { text: string }[];
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await runMigrations(pool);
    await runMigrations(pool);
    await t.test('a fresh database contains only public model and settings seeds', async () => {
      const lines = DEFAULT_MODEL_REPLY.split('\n');
      assert.equal(lines[0], '```text');
      assert.equal(lines[25], '```');
      assert.equal(lines.slice(1, 25).length, 24);
      assert.ok(lines.slice(1, 25).every(line => line.length === 46 && /^[@%#*+=\-:. ]+$/.test(line)));
      assert.ok(!DEFAULT_MODEL_REPLY.includes('\r'));
      assert.ok(DEFAULT_MODEL_REPLY.endsWith('\n'));
      assert.ok(DEFAULT_MODEL_REPLY.includes('[**https://github.com/vow132/wisdom-tree**](https://github.com/vow132/wisdom-tree)'));
      assert.ok(DEFAULT_MODEL_REPLY.includes('本仓库静态托管在Vercel上，不会上传您的任何数据'));
      assert.ok(DEFAULT_MODEL_REPLY.includes('记住：路边免费鸡蛋千万不要乱吃！！！ 然后把鸡蛋分享给你的朋友吧'));
      assert.ok(estimateTokens(DEFAULT_MODEL_REPLY) <= 1024);
      const models = (await pool.query('SELECT id,reply_text FROM models WHERE is_wisdom_tree=false ORDER BY id')).rows;
      assert.deepEqual(models.map(row => row.id), [...seededModels].sort());
      for (const model of models) {
        assert.equal(model.reply_text, DEFAULT_MODEL_REPLY);
        const replies = (await pool.query('SELECT position,text FROM model_replies WHERE model_id=$1 ORDER BY position', [model.id])).rows;
        assert.deepEqual(replies, [{ position: 1, text: DEFAULT_MODEL_REPLY }]);
      }
      const wisdom = (await pool.query('SELECT text FROM model_replies WHERE model_id=$1 ORDER BY position', ['wisdom-tree'])).rows;
      assert.equal(wisdom.length, 80);
      assert.deepEqual(wisdom.map(row => row.text), corpus.map(row => row.text));
      assert.equal((await pool.query('SELECT reply_text FROM models WHERE is_wisdom_tree=true')).rows[0].reply_text, corpus[0].text);
      for (const table of ['users', 'api_keys', 'sessions', 'identities', 'api_requests', 'ledger']) {
        assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0, `${table} must not contain deployment data`);
      }
    });

    app = await buildApp({ pool, config: {
      publicOrigin: origin, secureCookies: false, development: true,
      apiKeyEncryptionKey: randomBytes(32).toString('hex'), githubClientId: '', linuxdoClientId: '',
    } });
    const runningApp = app;
    await runningApp.listen({ host: '127.0.0.1', port: 0 });
    const apiOrigin = 'http://127.0.0.1:' + (runningApp.server.address() as { port: number }).port;
    const adminJar: Jar = new Map();
    const userJar: Jar = new Map();
    async function ok(jar: Jar | null, method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
      const headers: Record<string, string> = { ...extraHeaders };
      if (jar) headers.cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
      if (!['GET', 'HEAD'].includes(method)) headers.origin = origin;
      const response = await runningApp.inject({ method: method as any, url, payload: payload as any, headers });
      if (jar) for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
      assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
      return response.json();
    }
    await createAdmin(pool, 'default_admin', password);
    await ok(adminJar, 'POST', '/api/auth/login', { username: 'default_admin', password });
    const userId = (await ok(userJar, 'POST', '/api/auth/register', { username: 'default_gardener', password })).user.id;
    await ok(adminJar, 'PATCH', '/api/admin/settings', { apiRateLimit: 1000 });
    await ok(adminJar, 'POST', `/api/admin/users/${userId}/adjust`, { coinsDelta: 1000 });
    const apiKey = (await ok(userJar, 'POST', '/api/keys', { name: 'Disposable default reply SDK test' })).key;
    const sdk = new OpenAI({ apiKey, baseURL: apiOrigin + '/v1', maxRetries: 0 });
    const anthropic = new Anthropic({ apiKey, authToken: null, baseURL: apiOrigin, maxRetries: 0 });

    await t.test('new models inherit public art while explicit administrator text is preserved', async () => {
      assert.equal((await ok(adminJar, 'GET', '/api/admin/models')).defaultReplyText, DEFAULT_MODEL_REPLY);
      const created = (await ok(adminJar, 'POST', '/api/admin/models', {
        id: 'qa-default-art', displayName: '默认艺术回复', coinsPerCall: 0, streamChunkChars: 31, streamDelayMs: 0,
      })).model;
      assert.equal(created.replyText, DEFAULT_MODEL_REPLY);
      assert.equal(created.replyCount, 1);
      assert.deepEqual((await ok(adminJar, 'GET', '/api/admin/models/qa-default-art/replies')).items.map((row: any) => row.text), [DEFAULT_MODEL_REPLY]);
      const custom = '管理员自己的返回文本\n保留自定义内容';
      const explicit = (await ok(adminJar, 'POST', '/api/admin/models', {
        id: 'qa-custom-art', displayName: '自定义回复', coinsPerCall: 0, replyText: custom,
      })).model;
      assert.equal(explicit.replyText, custom);
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-custom-art', { displayName: '编辑名称不改变内容' });
      assert.deepEqual((await ok(adminJar, 'GET', '/api/admin/models/qa-custom-art/replies')).items.map((row: any) => row.text), [custom]);
      assert.equal((await sdk.chat.completions.create({ model: 'qa-custom-art', messages: [{ role: 'user', content: '你好' }] })).choices[0].message.content, custom);
    });

    await t.test('official SDK JSON and SSE preserve every ASCII space, newline and disclaimer', async () => {
      const model = 'qa-default-art';
      const messages = [{ role: 'user' as const, content: '你好' }];
      assert.equal((await sdk.chat.completions.create({ model, messages, max_tokens: 1024 })).choices[0].message.content, DEFAULT_MODEL_REPLY);
      let text = '';
      let chunks = 0;
      for await (const part of await sdk.chat.completions.create({ model, messages, max_tokens: 1024, stream: true })) {
        if (part.choices[0]?.delta.content) { text += part.choices[0].delta.content; chunks++; }
      }
      assert.equal(text, DEFAULT_MODEL_REPLY);
      assert.ok(chunks > 1);
      assert.equal((await sdk.completions.create({ model, prompt: '你好', max_tokens: 1024 })).choices[0].text, DEFAULT_MODEL_REPLY);
      text = '';
      for await (const part of await sdk.completions.create({ model, prompt: '你好', max_tokens: 1024, stream: true })) text += part.choices[0]?.text || '';
      assert.equal(text, DEFAULT_MODEL_REPLY);
      assert.equal((await sdk.responses.create({ model, input: '你好', max_output_tokens: 1024 })).output_text, DEFAULT_MODEL_REPLY);
      text = '';
      for await (const part of await sdk.responses.create({ model, input: '你好', max_output_tokens: 1024, stream: true })) if (part.type === 'response.output_text.delta') text += part.delta;
      assert.equal(text, DEFAULT_MODEL_REPLY);
      const message = await anthropic.messages.create({ model, messages, max_tokens: 1024 });
      assert.equal(message.content[0].type === 'text' ? message.content[0].text : '', DEFAULT_MODEL_REPLY);
      text = '';
      for await (const part of await anthropic.messages.create({ model, messages, max_tokens: 1024, stream: true })) if (part.type === 'content_block_delta' && part.delta.type === 'text_delta') text += part.delta.text;
      assert.equal(text, DEFAULT_MODEL_REPLY);
      const limited = await sdk.chat.completions.create({ model, messages, max_tokens: 10 });
      assert.equal(limited.choices[0].message.content, limitText(DEFAULT_MODEL_REPLY, 10));
      assert.equal(limited.choices[0].finish_reason, 'length');
      const limitedResponse = await sdk.responses.create({ model, input: '你好', max_output_tokens: 10 });
      assert.equal(limitedResponse.output_text, limitText(DEFAULT_MODEL_REPLY, 10));
      assert.equal(limitedResponse.status, 'incomplete');
      assert.equal(limitedResponse.incomplete_details?.reason, 'max_output_tokens');
    });

    await t.test('upgrade replaces untouched placeholders and preserves custom pools and accepted request snapshots', async () => {
      const customFallback = '管理员编辑后的后备回复';
      const customPool = '管理员编辑后的编号回复';
      await pool.query('UPDATE models SET reply_text=$2 WHERE id=$1', ['gpt-5.6-luna', legacyReply]);
      await pool.query('UPDATE model_replies SET text=$2 WHERE model_id=$1', ['gpt-5.6-luna', legacyReply]);
      await pool.query('UPDATE models SET reply_text=$2 WHERE id=$1', ['gpt-5.6-sol', customFallback]);
      await pool.query('UPDATE model_replies SET text=$2 WHERE model_id=$1', ['gpt-5.6-sol', customPool]);
      await pool.query('UPDATE models SET reply_text=$2 WHERE id=$1', ['claude-sonnet-4-6', legacyReply]);
      await pool.query('UPDATE model_replies SET text=$2 WHERE model_id=$1', ['claude-sonnet-4-6', customPool]);
      const idem = randomUUID();
      const payload = { model: 'gpt-5.6-luna', messages: [{ role: 'user' as const, content: '升级前已受理' }], max_tokens: 1024 };
      const original = await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } });
      assert.equal(original.choices[0].message.content, legacyReply);
      const beforeCoins = (await ok(userJar, 'GET', '/api/me')).user.coins;
      await pool.query('DELETE FROM schema_migrations WHERE name=$1', ['007_default_model_reply.sql']);
      await runMigrations(pool);
      await runMigrations(pool);
      const models = (await pool.query('SELECT id,reply_text FROM models')).rows;
      assert.equal(models.find(row => row.id === 'gpt-5.6-luna')?.reply_text, DEFAULT_MODEL_REPLY);
      assert.equal(models.find(row => row.id === 'gpt-5.6-sol')?.reply_text, customFallback);
      assert.equal(models.find(row => row.id === 'claude-sonnet-4-6')?.reply_text, DEFAULT_MODEL_REPLY);
      assert.equal((await pool.query('SELECT text FROM model_replies WHERE model_id=$1', ['gpt-5.6-luna'])).rows[0].text, DEFAULT_MODEL_REPLY);
      assert.equal((await pool.query('SELECT text FROM model_replies WHERE model_id=$1', ['gpt-5.6-sol'])).rows[0].text, customPool);
      assert.equal((await pool.query('SELECT text FROM model_replies WHERE model_id=$1', ['claude-sonnet-4-6'])).rows[0].text, customPool);
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } }), original);
      assert.equal((await ok(userJar, 'GET', '/api/me')).user.coins, beforeCoins);
      assert.equal((await pool.query('SELECT result FROM api_requests WHERE user_id=$1 AND idem_key=$2', [userId, idem])).rows[0].result.replyText, legacyReply);
      assert.equal((await sdk.chat.completions.create(payload)).choices[0].message.content, DEFAULT_MODEL_REPLY);
      assert.equal((await sdk.chat.completions.create({ ...payload, model: 'claude-sonnet-4-6' })).choices[0].message.content, customPool);
      assert.equal((await pool.query('SELECT reply_text FROM models WHERE id=$1', ['qa-custom-art'])).rows[0].reply_text, '管理员自己的返回文本\n保留自定义内容');
      assert.deepEqual((await pool.query('SELECT text FROM model_replies WHERE model_id=$1 ORDER BY position', ['wisdom-tree'])).rows.map(row => row.text), corpus.map(row => row.text));
    });
  } finally {
    if (app) await app.close();
    await pool.end();
    if (oldMode === undefined) delete process.env.DATABASE_MODE; else process.env.DATABASE_MODE = oldMode;
    if (oldPath === undefined) delete process.env.PGLITE_PATH; else process.env.PGLITE_PATH = oldPath;
    await rm(dataDir, { recursive: true, force: true });
  }
});
