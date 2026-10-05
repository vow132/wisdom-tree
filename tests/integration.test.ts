import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import { dateShanghai, hash, decryptApiKey } from '../backend/src/security.js';
import { loadApiKeyEncryptionKey } from '../backend/src/key-encryption.js';
import { readConfig } from '../backend/src/config.js';

const origin = 'http://127.0.0.1:5173';
const password = 'A-good-test-password-2026';

test('complete application and SDK integration', { timeout: 120_000 }, async t => {
  const dataDir = resolve('.local', 'qa-' + randomUUID());
  await mkdir(dataDir, { recursive: true });
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = dataDir;
  const pool = await getPool();
  await runMigrations(pool);
  const corpus = JSON.parse(await readFile(new URL('../backend/data/wisdom-tree-quotes.json', import.meta.url), 'utf8')) as { id: string; sourceKey: string; text: string }[];
  assert.equal(corpus.length, 80);
  assert.equal(new Set(corpus.map(item => item.sourceKey)).size, 80);
  const imported = await pool.query('SELECT position,text FROM model_replies WHERE model_id=$1 ORDER BY position', ['wisdom-tree']);
  assert.deepEqual(imported.rows.map(row => row.text), corpus.map(item => item.text));
  await runMigrations(pool);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM model_replies WHERE model_id=$1', ['wisdom-tree'])).rows[0].count, 80);
  const provider = createServer((request, response) => {
    const path = request.url || '';
    if (path.endsWith('/token')) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const code = new URLSearchParams(body).get('code') || 'one';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: path.startsWith('/github') ? 'gh-' + code : 'ld-' + code, token_type: 'bearer' }));
      });
    } else if (path.endsWith('/user')) {
      const token = request.headers.authorization || '';
      const identifier = token.split('-').at(-1) || 'one';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: identifier, login: 'same_name', username: 'same_name', name: 'OAuth 测试用户', active: true, silenced: false }));
    } else { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address() as { port: number };
  const providerOrigin = 'http://127.0.0.1:' + providerAddress.port;
  const app = await buildApp({ pool, config: {
    publicOrigin: origin, secureCookies: false, development: true,
    githubClientId: 'test-id', githubClientSecret: 'test-secret',
    linuxdoClientId: 'test-id', linuxdoClientSecret: 'test-secret',
    githubAuthorizeUrl: providerOrigin + '/github/authorize',
    githubTokenUrl: providerOrigin + '/github/token',
    githubUserUrl: providerOrigin + '/github/user',
    linuxdoAuthorizeUrl: providerOrigin + '/linuxdo/authorize',
    linuxdoTokenUrl: providerOrigin + '/linuxdo/token',
    linuxdoUserUrl: providerOrigin + '/linuxdo/user',
  } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const serverAddress = app.server.address() as { port: number };
  const apiOrigin = 'http://127.0.0.1:' + serverAddress.port;
  type Jar = Map<string, string>;
  const adminJar: Jar = new Map();
  const userJar: Jar = new Map();
  function remember(jar: Jar, response: any) {
    for (const cookie of response.cookies || []) jar.set(cookie.name, cookie.value);
  }
  async function request(jar: Jar | null, method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (jar) headers.cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
    if (!['GET', 'HEAD'].includes(method)) headers.origin = origin;
    const response = await app.inject({ method: method as any, url, payload: body as any, headers });
    if (jar) remember(jar, response);
    return response;
  }
  async function ok(jar: Jar | null, method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    const response = await request(jar, method, url, body, headers);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, method + ' ' + url + ': ' + response.body);
    return response.json();
  }
  async function state(jar = userJar) { return ok(jar, 'GET', '/api/me'); }
  async function action(name: string, key = randomUUID()) {
    return ok(userJar, 'POST', '/api/tree/' + name, {}, { 'Idempotency-Key': key });
  }
  let adminId = '';
  let userId = '';
  let apiKey = '';
  let keyId = '';
  let persistentKey = '';
  let persistentKeyId = '';
  try {
    await t.test('fresh migration, anonymous state, registration and session', async () => {
      const anonymous = await state(new Map());
      assert.equal(anonymous.user, null);
      assert.equal(anonymous.rules.inventoryLimit, 10);
      assert.equal(anonymous.providers.github, true);
      await createAdmin(pool, 'qa_admin', password);
      const admin = await ok(adminJar, 'POST', '/api/auth/login', { username: 'qa_admin', password });
      adminId = admin.user.id;
      assert.equal(admin.user.role, 'admin');
      const user = await ok(userJar, 'POST', '/api/auth/register', { username: 'qa_gardener', password, displayName: '园丁' });
      userId = user.user.id;
      assert.equal(user.user.coins, 0);
      assert.equal((await state()).user.id, userId);
      const duplicate = await request(null, 'POST', '/api/auth/register', { username: 'QA_GARDENER', password });
      assert.equal(duplicate.statusCode, 409);
      const stored = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [userId])).rows[0].password_hash;
      assert.ok(!stored.includes(password));
    });
    await t.test('permissions and cross-site request protection', async () => {
      assert.equal((await request(userJar, 'GET', '/api/admin/users')).statusCode, 403);
      assert.equal((await request(null, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 401);
      const response = await app.inject({ method: 'POST', url: '/api/keys', payload: { name: 'cross-site' }, headers: {
        cookie: [...userJar].map(([name, value]) => name + '=' + value).join('; '), origin: 'https://untrusted.example',
      } });
      assert.equal(response.statusCode, 403);
    });
    await t.test('one seed, planting, server persistence and action idempotency', async () => {
      assert.equal((await request(userJar, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 409);
      const idem = randomUUID();
      const [first, second] = await Promise.all([action('seed', idem), action('seed', idem)]);
      assert.equal(first.tree.seedClaimed, true);
      assert.deepEqual(first, second);
      assert.equal((await request(userJar, 'POST', '/api/tree/seed', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 409);
      await action('plant');
      assert.equal((await state()).tree.height, 1);
      await action('claim-fertilizer');
      assert.equal((await state()).user.fertilizer, 5);
      const feedKey = randomUUID();
      await Promise.all(Array.from({ length: 6 }, () => action('feed', feedKey)));
      const after = await state();
      assert.equal(after.user.fertilizer, 4);
      assert.equal(after.user.coins, 10);
      assert.equal(after.tree.height, 2);
      assert.equal(after.daily.remaining, 0);
    });
    await t.test('partial daily claim, full inventory and remaining daily allowance', async () => {
      await pool.query('DELETE FROM daily_claims WHERE user_id=$1', [userId]);
      await pool.query("INSERT INTO daily_claims(id,user_id,claim_date,amount) VALUES($1,$2,$3::date-1,5)", [randomUUID(), userId, dateShanghai()]);
      await ok(adminJar, 'POST', '/api/admin/users/' + userId + '/adjust', { coinsDelta: 0, fertilizerDelta: 4, reason: '准备部分领取验收' });
      const first = await action('claim-fertilizer');
      assert.equal(first.user.fertilizer, 10);
      assert.equal(first.daily.claimed, 2);
      assert.equal(first.daily.remaining, 3);
      assert.equal((await request(userJar, 'POST', '/api/tree/claim-fertilizer', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 409);
      await action('feed');
      await action('feed');
      await action('feed');
      const result = await action('claim-fertilizer');
      assert.equal(result.daily.claimed, 5);
      assert.equal(result.daily.remaining, 0);
      assert.equal(result.user.fertilizer, 10);
      assert.equal(dateShanghai(), result.daily.date);
    });
    await t.test('owner can recover encrypted sk_ keys; other accounts and admin views never receive secrets', async () => {
      const created = await ok(userJar, 'POST', '/api/keys', { name: 'SDK integration' });
      apiKey = created.key;
      keyId = created.item.id;
      assert.ok(apiKey.startsWith('sk_'));
      assert.equal(created.item.key, apiKey);
      assert.equal(created.item.recoverable, true);
      const list = await ok(userJar, 'GET', '/api/keys');
      assert.equal((await request(userJar, 'GET', '/api/keys')).headers['cache-control'], 'no-store');
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].key, apiKey);
      const stored = (await pool.query('SELECT * FROM api_keys WHERE id=$1', [keyId])).rows[0];
      assert.equal(stored.key_hash, hash(apiKey));
      assert.ok(!stored.key_ciphertext.includes(apiKey));
      const master = readConfig({ development: true }).apiKeyEncryptionKey;
      assert.equal(decryptApiKey(stored.key_ciphertext, master, userId, keyId), apiKey);
      assert.throws(() => decryptApiKey(stored.key_ciphertext, master, adminId, keyId));
      assert.ok(!(await ok(adminJar, 'GET', '/api/keys')).items.some((item: any) => item.id === keyId));
      const adminView = await ok(adminJar, 'GET', '/api/admin/users/' + userId);
      assert.ok(!JSON.stringify(adminView).includes(apiKey));
      assert.ok(adminView.keys.every((item: any) => !('key' in item) && !('key_ciphertext' in item)));
      assert.equal((await request(adminJar, 'DELETE', '/api/keys/' + keyId)).statusCode, 404);
    });
    await t.test('legacy digest-only keys authenticate, report unrecoverable and revoked ciphertext is cleared', async () => {
      const legacy = 'wt_' + randomUUID().replaceAll('-', '');
      const legacyId = randomUUID();
      await pool.query('INSERT INTO api_keys(id,user_id,name,prefix,key_hash) VALUES($1,$2,$3,$4,$5)', [legacyId, userId, '旧版密钥', legacy.slice(0, 11), hash(legacy)]);
      const oldItem = (await ok(userJar, 'GET', '/api/keys')).items.find((item: any) => item.id === legacyId);
      assert.equal(oldItem.key, null);
      assert.equal(oldItem.recoverable, false);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + legacy })).statusCode, 200);
      await ok(userJar, 'DELETE', '/api/keys/' + legacyId);
      const created = await ok(userJar, 'POST', '/api/keys', { name: '撤销密钥加密验证' });
      await ok(userJar, 'DELETE', '/api/keys/' + created.item.id);
      const revoked = (await ok(userJar, 'GET', '/api/keys')).items.find((item: any) => item.id === created.item.id);
      assert.equal(revoked.key, null);
      assert.equal(revoked.recoverable, false);
      assert.equal((await pool.query('SELECT key_ciphertext FROM api_keys WHERE id=$1', [created.item.id])).rows[0].key_ciphertext, null);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + created.key })).statusCode, 401);
      const persistent = await ok(userJar, 'POST', '/api/keys', { name: '重启持久化验证' });
      persistentKey = persistent.key;
      persistentKeyId = persistent.item.id;
    });
    await t.test('official SDKs parse Chat, Responses and Anthropic JSON and SSE', async () => {
      const openai = new OpenAI({ apiKey, baseURL: apiOrigin + '/v1', maxRetries: 0 });
      const anthropic = new Anthropic({ apiKey, authToken: null, baseURL: apiOrigin, maxRetries: 0 });
      const before = (await state()).user.coins;
      const models = await openai.models.list();
      assert.ok(models.data.some(model => model.id === 'gpt-5.6-luna'));
      const chat = await openai.chat.completions.create({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: '你好' }] });
      assert.ok(chat.choices[0].message.content?.includes('https://github.com/vow132/wisdom-tree'));
      const stream = await openai.chat.completions.create({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: '你好' }], stream: true, stream_options: { include_usage: true } });
      let chatText = '';
      for await (const part of stream) chatText += part.choices[0]?.delta.content || '';
      assert.equal(chatText, chat.choices[0].message.content);
      const completion = await openai.completions.create({ model: 'gpt-5.6-luna', prompt: '你好' });
      const completionStream = await openai.completions.create({ model: 'gpt-5.6-luna', prompt: '你好', stream: true });
      let completionText = '';
      for await (const part of completionStream) completionText += part.choices[0]?.text || '';
      assert.equal(completionText, completion.choices[0].text);
      const response = await openai.responses.create({ model: 'gpt-5.6-sol', input: '你好' });
      assert.ok(response.output_text.includes('https://github.com/vow132/wisdom-tree'));
      const responseStream = openai.responses.stream({ model: 'gpt-5.6-sol', input: '你好' });
      const finalResponse = await responseStream.finalResponse();
      assert.equal(finalResponse.output_text, response.output_text);
      assert.equal(finalResponse.status, 'completed');
      const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] });
      assert.equal(message.content[0].type, 'text');
      const finalMessage = await anthropic.messages.stream({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] }).finalMessage();
      assert.deepEqual(finalMessage.content, message.content);
      const count = await anthropic.messages.countTokens({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: '测试' }] });
      assert.ok(count.input_tokens > 0);
      assert.equal((await state()).user.coins, before - 18);
    });
    await t.test('invalid requests are free and truncation is correctly reported', async () => {
      const headers = { authorization: 'Bearer ' + apiKey };
      const before = (await state()).user.coins;
      assert.equal((await request(null, 'POST', '/v1/chat/completions', { model: 'missing', messages: [{ role: 'user', content: 'hello' }] }, headers)).statusCode, 404);
      assert.equal((await request(null, 'POST', '/v1/responses', { model: 'gpt-5.6-luna' }, headers)).statusCode, 400);
      assert.equal((await request(null, 'POST', '/v1/messages', { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] }, headers)).statusCode, 400);
      assert.equal((await request(null, 'POST', '/v1/chat/completions', { model: 'gpt-5.6-luna', messages: [{ role: 'garbage' }] }, headers)).statusCode, 400);
      assert.equal((await request(null, 'POST', '/v1/completions', { model: 'gpt-5.6-luna', prompt: null }, headers)).statusCode, 400);
      assert.equal((await state()).user.coins, before);
      const value = await ok(null, 'POST', '/v1/responses', { model: 'gpt-5.6-luna', input: 'hello', max_output_tokens: 1 }, headers);
      assert.equal(value.status, 'incomplete');
      assert.equal(value.incomplete_details.reason, 'max_output_tokens');
      assert.ok(value.usage.output_tokens <= 1);
    });
    await t.test('numbered reply CRUD, per-model SDK rotation and idempotent snapshots', async () => {
      await ok(adminJar, 'POST', '/api/admin/models', { id: 'qa-replies', displayName: '多条回复', coinsPerCall: 1, replyText: 'A', streamChunkChars: 8, streamDelayMs: 0, reason: '回复池验收' });
      await ok(adminJar, 'POST', '/api/admin/models', { id: 'qa-independent', displayName: '独立回复', coinsPerCall: 0, replyText: 'X', streamChunkChars: 8, streamDelayMs: 0, reason: '独立回复池验收' });
      const repliesUrl = '/api/admin/models/qa-replies/replies';
      const first = (await ok(adminJar, 'GET', repliesUrl)).items[0];
      const second = (await ok(adminJar, 'POST', repliesUrl, { position: 2, text: 'B', reason: '添加第二句' })).item;
      const third = (await ok(adminJar, 'POST', repliesUrl, { position: 3, text: 'C', reason: '添加第三句' })).item;
      await ok(adminJar, 'POST', '/api/admin/models/qa-independent/replies', { position: 2, text: 'Y', reason: '添加独立第二句' });
      assert.deepEqual((await ok(adminJar, 'GET', repliesUrl)).items.map((value: any) => [value.position, value.text]), [[1, 'A'], [2, 'B'], [3, 'C']]);
      assert.equal((await request(userJar, 'GET', repliesUrl)).statusCode, 403);
      assert.equal((await request(userJar, 'POST', repliesUrl, { position: 4, text: 'unauthorized', reason: '拒绝越权' })).statusCode, 403);
      assert.equal((await request(adminJar, 'POST', repliesUrl, { position: 2, text: 'collision', reason: '重复编号' })).statusCode, 409);
      assert.equal((await request(adminJar, 'PATCH', repliesUrl + '/' + third.id, { position: 1, reason: '冲突编辑' })).statusCode, 409);
      assert.equal((await request(adminJar, 'POST', repliesUrl, { position: 4, text: '', reason: '空白回复' })).statusCode, 400);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/models/qa-replies', { streamChunkChars: 1, streamDelayMs: 1000, reason: '超时参数', replyText: 'x'.repeat(121) })).statusCode, 400);
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-replies', { streamChunkChars: 1, streamDelayMs: 1000, reason: '校验逐条限制' });
      assert.equal((await request(adminJar, 'POST', repliesUrl, { position: 4, text: 'x'.repeat(121), reason: '超时长回复' })).statusCode, 400);
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-replies', { streamChunkChars: 8, streamDelayMs: 0, reason: '恢复快速流' });
      const sdk = new OpenAI({ apiKey, baseURL: apiOrigin + '/v1', maxRetries: 0 });
      const payload = { model: 'qa-replies', messages: [{ role: 'user' as const, content: 'rotate' }] };
      const idem = randomUUID();
      const before = (await state()).user.coins;
      const a = await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } });
      assert.equal(a.choices[0].message.content, 'A');
      const independent = await sdk.chat.completions.create({ ...payload, model: 'qa-independent' });
      assert.equal(independent.choices[0].message.content, 'X');
      const replay = await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } });
      assert.deepEqual(replay, a);
      const b = await sdk.responses.create({ model: 'qa-replies', input: 'rotate' });
      assert.equal(b.output_text, 'B');
      const stream = await sdk.chat.completions.create({ ...payload, stream: true });
      let c = '';
      for await (const chunk of stream) c += chunk.choices[0]?.delta.content || '';
      assert.equal(c, 'C');
      assert.equal((await sdk.chat.completions.create({ ...payload, model: 'qa-independent' })).choices[0].message.content, 'Y');
      await ok(adminJar, 'PATCH', repliesUrl + '/' + first.id, { text: 'A2', position: 4, reason: '编辑文本及编号' });
      const reordered = await sdk.chat.completions.create(payload);
      assert.equal(reordered.choices[0].message.content, 'A2');
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } }), a);
      const receipt = (await pool.query('SELECT result FROM api_requests WHERE user_id=$1 AND idem_key=$2', [userId, idem])).rows[0].result;
      assert.equal(receipt.replyId, first.id);
      assert.equal(receipt.replyIndex, 1);
      assert.equal(receipt.replyText, 'A');
      assert.equal((await state()).user.coins, before - 4);
      await ok(adminJar, 'DELETE', repliesUrl + '/' + first.id, { reason: '删除第一句' });
      await ok(adminJar, 'DELETE', repliesUrl + '/' + second.id, { reason: '删除第二句' });
      await ok(adminJar, 'DELETE', repliesUrl + '/' + third.id, { reason: '删除第三句' });
      assert.equal((await ok(adminJar, 'GET', repliesUrl)).total, 0);
      assert.equal((await sdk.chat.completions.create(payload)).choices[0].message.content, 'A');
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } }), a);
      const renamed = await ok(adminJar, 'PATCH', '/api/admin/models/qa-replies', { id: 'qa-new-id' });
      assert.equal(renamed.model.id, 'qa-new-id');
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers: { 'Idempotency-Key': idem } }), a);
      await ok(adminJar, 'DELETE', '/api/admin/models/qa-new-id', { reason: '删除池模型' });
      assert.equal((await request(adminJar, 'GET', repliesUrl)).statusCode, 404);
      const audit = (await ok(adminJar, 'GET', '/api/admin/audit', undefined)).items;
      assert.ok(audit.some((value: any) => value.action === 'model.reply.create'));
      assert.ok(audit.some((value: any) => value.action === 'model.reply.update'));
      assert.ok(audit.some((value: any) => value.action === 'model.reply.delete'));
    });
    await t.test('free tree dialogue, feeding and API calls share the wisdom-tree reply sequence', async () => {
      assert.equal((await request(null, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 401);
      const jar: Jar = new Map();
      const user = (await ok(jar, 'POST', '/api/auth/register', { username: 'qa_talker', password })).user;
      assert.equal((await request(jar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 409);
      const repliesUrl = '/api/admin/models/wisdom-tree/replies';
      const original = (await ok(adminJar, 'GET', repliesUrl)).items;
      const extraOne = (await ok(adminJar, 'POST', repliesUrl, { position: 999998, text: '测试树第一条', reason: '树池顺序验收' })).item;
      const extraTwo = (await ok(adminJar, 'POST', repliesUrl, { position: 999999, text: '测试树第二条', reason: '树池顺序验收' })).item;
      const poolItems = [...original, extraOne, extraTwo];
      await ok(jar, 'POST', '/api/tree/seed', {}, { 'Idempotency-Key': randomUUID() });
      const planted = await ok(jar, 'POST', '/api/tree/plant', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(planted.tip, poolItems[0].text);
      assert.equal(planted.dialogue.replyId, poolItems[0].id);
      await ok(jar, 'POST', '/api/tree/claim-fertilizer', {}, { 'Idempotency-Key': randomUUID() });
      await ok(adminJar, 'POST', '/api/admin/users/' + user.id + '/adjust', { coinsDelta: 3, reason: '智慧树API顺序验收' });
      const treeKey = (await ok(jar, 'POST', '/api/keys', { name: '树池统一验证' })).key;
      const before = await state(jar);
      const idem = randomUUID();
      const first = await ok(jar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': idem });
      assert.equal(first.replyId, poolItems[1].id);
      assert.equal(first.index, 2);
      assert.deepEqual(await ok(jar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': idem }), first);
      assert.deepEqual(await state(jar), before);
      const sdk = new OpenAI({ apiKey: treeKey, baseURL: apiOrigin + '/v1', maxRetries: 0 });
      const response = await sdk.responses.create({ model: 'wisdom-tree', input: '与站内智慧树共用回复池' });
      assert.equal(response.output_text, poolItems[2].text);
      const nextIndex = 3 % poolItems.length;
      const fed = await ok(jar, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(fed.dialogue.replyId, poolItems[nextIndex].id);
      assert.equal(fed.tip, poolItems[nextIndex].text);
      assert.equal(fed.user.coins, before.user.coins - 1 + fed.rules.coinsPerFeed);
      assert.equal(fed.tree.height, before.tree.height + fed.rules.growthPerFeed);
      assert.equal(fed.user.fertilizer, before.user.fertilizer - 1);
      const concurrent = await Promise.all(Array.from({ length: 3 }, () => ok(jar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': randomUUID() })));
      assert.equal(new Set(concurrent.map(value => value.replyId)).size, 3);
      assert.equal((await state(jar)).user.coins, fed.user.coins);
      await ok(adminJar, 'PATCH', '/api/admin/models/wisdom-tree', { enabled: false, reason: '智慧树停用验收' });
      const disabledBalance = (await state(jar)).user.coins;
      assert.equal((await request(jar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': randomUUID() })).statusCode, 404);
      assert.equal((await request(null, 'POST', '/v1/responses', { model: 'wisdom-tree', input: '停用后拒绝' }, { authorization: 'Bearer ' + treeKey })).statusCode, 404);
      assert.equal((await state(jar)).user.coins, disabledBalance);
      const disabledFeed = await ok(jar, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(disabledFeed.dialogue, undefined);
      assert.equal(disabledFeed.tree.height, fed.tree.height + 1);
      await ok(adminJar, 'PATCH', '/api/admin/models/wisdom-tree', { enabled: true, reason: '恢复智慧树模型' });
      await ok(adminJar, 'DELETE', repliesUrl + '/' + extraOne.id, { reason: '清理验收语句' });
      await ok(adminJar, 'DELETE', repliesUrl + '/' + extraTwo.id, { reason: '清理验收语句' });
      assert.deepEqual((await ok(adminJar, 'GET', repliesUrl)).items, original);
    });
    await t.test('idempotent replay preserves reply and price after model changes', async () => {
      await ok(adminJar, 'POST', '/api/admin/models', { id: 'qa-snapshot', displayName: '快照模型', coinsPerCall: 1, enabled: true, replyText: '原始回复', streamChunkChars: 2, streamDelayMs: 0, reason: '验收' });
      const headers = { authorization: 'Bearer ' + apiKey, 'Idempotency-Key': randomUUID() };
      const payload = { model: 'qa-snapshot', input: 'hello' };
      const before = (await state()).user.coins;
      const accepted = await Promise.all(Array.from({ length: 4 }, () => ok(null, 'POST', '/v1/responses', payload, headers)));
      const first = accepted[0];
      accepted.forEach(value => assert.deepEqual(value, first));
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-snapshot', { displayName: '调价模型', coinsPerCall: 7, enabled: false, replyText: '修改后的回复', streamChunkChars: 1, streamDelayMs: 0, reason: '模型调整' });
      const replay = await ok(null, 'POST', '/responses', payload, headers);
      assert.deepEqual(replay, first);
      assert.equal((await state()).user.coins, before - 1);
      assert.equal((await request(null, 'POST', '/v1/responses', { ...payload, input: 'different' }, headers)).statusCode, 409);
      assert.equal((await request(null, 'POST', '/v1/responses', payload, { authorization: headers.authorization })).statusCode, 404);
      assert.equal((await ok(adminJar, 'PATCH', '/api/admin/models/qa-snapshot', { id: 'qa-snapshot-renamed' })).model.id, 'qa-snapshot-renamed');
      await ok(adminJar, 'DELETE', '/api/admin/models/qa-snapshot-renamed', { reason: '软删除验收' });
      assert.ok(!(await ok(adminJar, 'GET', '/api/admin/models')).items.some((model: any) => ['qa-snapshot', 'qa-snapshot-renamed'].includes(model.id)));
      assert.deepEqual(await ok(null, 'POST', '/v1/responses', payload, headers), first);
    });
    await t.test('simultaneous calls never create a negative balance', async () => {
      const coins = (await state()).user.coins;
      await ok(adminJar, 'POST', '/api/admin/users/' + userId + '/adjust', { coinsDelta: 2 - coins, fertilizerDelta: 0, reason: '并发余额验收' });
      const requests = await Promise.all(Array.from({ length: 7 }, () => request(null, 'POST', '/v1/chat/completions', {
        model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'parallel' }],
      }, { authorization: 'Bearer ' + apiKey, 'Idempotency-Key': randomUUID() })));
      assert.equal(requests.filter(value => value.statusCode === 200).length, 2);
      assert.equal(requests.filter(value => value.statusCode === 402).length, 5);
      assert.equal((await state()).user.coins, 0);
      const charges = (await ok(userJar, 'GET', '/api/ledger')).items.filter((item: any) => item.kind === 'api_call');
      assert.ok(charges.every((item: any) => item.coinsDelta <= 0));
    });
    await t.test('accepted stream disconnect remains charged exactly once, replay succeeds', async () => {
      await ok(adminJar, 'POST', '/api/admin/models', { id: 'qa-disconnect', displayName: '断流模型', coinsPerCall: 1, enabled: true, replyText: '断流测试'.repeat(100), streamChunkChars: 1, streamDelayMs: 5, reason: '验收' });
      await ok(adminJar, 'POST', '/api/admin/users/' + userId + '/adjust', { coinsDelta: 2, fertilizerDelta: 0, reason: '断流验收' });
      const idem = randomUUID();
      const payload = { model: 'qa-disconnect', input: 'hello', stream: true };
      const controller = new AbortController();
      const response = await fetch(apiOrigin + '/v1/responses', { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + apiKey, 'Idempotency-Key': idem,
      }, body: JSON.stringify(payload), signal: controller.signal });
      assert.equal(response.status, 200);
      await response.body!.getReader().read();
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await state()).user.coins, 1);
      const replay = await fetch(apiOrigin + '/v1/responses', { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + apiKey, 'Idempotency-Key': idem,
      }, body: JSON.stringify(payload) });
      const text = await replay.text();
      assert.ok(text.includes('response.completed'));
      assert.equal((await state()).user.coins, 1);
      await ok(adminJar, 'PATCH', '/api/admin/settings', { apiRateLimit: 1, reason: '每分钟受理限流验收' });
      const throttled = await request(null, 'POST', '/v1/responses', { model: 'gpt-5.6-luna', input: 'limit check' }, { authorization: 'Bearer ' + apiKey });
      assert.equal(throttled.statusCode, 429);
      assert.equal((await state()).user.coins, 1);
      await ok(adminJar, 'PATCH', '/api/admin/settings', { apiRateLimit: 60, reason: '恢复限流测试规则' });
    });
    await t.test('OAuth login, explicit binding, conflicting identity and invalid state', async () => {
      const oauthJar: Jar = new Map();
      let start = await request(oauthJar, 'GET', '/api/auth/github/start');
      assert.equal(start.statusCode, 302);
      let oauthState = new URL(String(start.headers.location)).searchParams.get('state')!;
      let callback = await request(oauthJar, 'GET', '/api/auth/github/callback?code=github-one&state=' + encodeURIComponent(oauthState));
      assert.equal(callback.statusCode, 302);
      const oauthUser = (await state(oauthJar)).user;
      assert.notEqual(oauthUser.id, userId);
      start = await request(oauthJar, 'GET', '/api/auth/linuxdo/start?bind=1');
      oauthState = new URL(String(start.headers.location)).searchParams.get('state')!;
      callback = await request(oauthJar, 'GET', '/api/auth/linuxdo/callback?code=linuxdo-one&state=' + encodeURIComponent(oauthState));
      assert.equal(callback.statusCode, 302);
      const identities = await ok(oauthJar, 'GET', '/api/auth/identities');
      assert.equal(identities.items.length, 2);
      const conflict = await request(userJar, 'GET', '/api/auth/linuxdo/start?bind=1');
      const conflictState = new URL(String(conflict.headers.location)).searchParams.get('state')!;
      const conflictCallback = await request(userJar, 'GET', '/api/auth/linuxdo/callback?code=linuxdo-one&state=' + encodeURIComponent(conflictState));
      assert.ok([302, 409].includes(conflictCallback.statusCode));
      assert.equal((await ok(userJar, 'GET', '/api/auth/identities')).items.length, 0);
      assert.equal((await state()).user.id, userId);
      const bad = await request(oauthJar, 'GET', '/api/auth/github/callback?code=github-one&state=wrong');
      assert.ok(bad.statusCode >= 400 || String(bad.headers.location).includes('error'));
      await ok(oauthJar, 'DELETE', '/api/auth/identities/linuxdo');
      assert.equal((await request(oauthJar, 'DELETE', '/api/auth/identities/github')).statusCode, 409);
    });
    await t.test('user CRUD, password reset, key revocation and last-admin guard', async () => {
      const created = await ok(adminJar, 'POST', '/api/admin/users', { username: 'qa_created', password, displayName: '新用户' });
      const id = created.user.id;
      await ok(adminJar, 'PATCH', '/api/admin/users/' + id, { displayName: '已编辑', reason: '编辑验收' });
      assert.equal((await ok(adminJar, 'GET', '/api/admin/users/' + id)).user.displayName, '已编辑');
      await ok(adminJar, 'POST', '/api/admin/users/' + id + '/password', { password: 'Another-test-password', reason: '重置验收' });
      const jar: Jar = new Map();
      assert.equal((await request(jar, 'POST', '/api/auth/login', { username: 'qa_created', password })).statusCode, 401);
      await ok(jar, 'POST', '/api/auth/login', { username: 'qa_created', password: 'Another-test-password' });
      await ok(adminJar, 'POST', '/api/admin/users/' + id + '/adjust', { coinsDelta: 3, fertilizerDelta: 0, reason: '封禁验收余额' });
      const temporaryKey = (await ok(jar, 'POST', '/api/keys', { name: '封禁验收' })).key;
      await ok(adminJar, 'PATCH', '/api/admin/users/' + id, { status: 'banned', reason: '封禁验收' });
      assert.equal((await state(jar)).user, null);
      assert.equal((await request(jar, 'POST', '/api/auth/login', { username: 'qa_created', password: 'Another-test-password' })).statusCode, 401);
      assert.equal((await request(null, 'POST', '/v1/responses', { model: 'gpt-5.6-luna', input: 'hello' }, { authorization: 'Bearer ' + temporaryKey })).statusCode, 401);
      await ok(adminJar, 'PATCH', '/api/admin/users/' + id, { status: 'active', reason: '解除验收封禁' });
      await ok(jar, 'POST', '/api/auth/login', { username: 'qa_created', password: 'Another-test-password' });
      assert.equal((await ok(jar, 'POST', '/api/auth/logout')).user, null);
      assert.equal((await state(jar)).user, null);
      await ok(jar, 'POST', '/api/auth/login', { username: 'qa_created', password: 'Another-test-password' });
      await ok(adminJar, 'DELETE', '/api/admin/users/' + id, { reason: '删除验收' });
      assert.equal((await state(jar)).user, null);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + temporaryKey })).statusCode, 401);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/users/' + adminId, { role: 'user', reason: '最后管理员保护' })).statusCode, 409);
      assert.equal((await request(adminJar, 'DELETE', '/api/admin/users/' + adminId, { reason: '最后管理员保护' })).statusCode, 409);
      await ok(userJar, 'DELETE', '/api/keys/' + keyId);
      assert.equal((await request(null, 'GET', '/v1/models', undefined, { authorization: 'Bearer ' + apiKey })).statusCode, 401);
      const audit = await ok(adminJar, 'GET', '/api/admin/audit');
      assert.ok(audit.total > 0);
      assert.ok(!JSON.stringify(audit).includes(password));
      assert.ok(!JSON.stringify(audit).includes(apiKey));
    });
    await t.test('settings apply only to future actions and persistence survives app rebuild', async () => {
      const before = await state();
      await ok(adminJar, 'PATCH', '/api/admin/settings', {
        dailyFertilizer: 7, inventoryLimit: 12, coinsPerFeed: 3, growthPerFeed: 2, apiRateLimit: 60, reason: '未来规则验收',
      });
      const result = await action('feed');
      assert.equal(result.user.coins, before.user.coins + 3);
      assert.equal(result.tree.height, before.tree.height + 2);
      await app.close();
      const reopened = await buildApp({ pool, config: { publicOrigin: origin, development: true } });
      try {
        const response = await reopened.inject({ method: 'GET', url: '/api/me', headers: {
          cookie: [...userJar].map(([name, value]) => name + '=' + value).join('; '),
        } });
        assert.equal(response.json().tree.height, result.tree.height);
        assert.equal(response.json().user.coins, result.user.coins);
        const keys = await reopened.inject({ method: 'GET', url: '/api/keys', headers: {
          cookie: [...userJar].map(([name, value]) => name + '=' + value).join('; '),
        } });
        assert.equal(keys.statusCode, 200);
        assert.equal(keys.json().items.find((item: any) => item.id === persistentKeyId).key, persistentKey);
      } finally { await reopened.close(); }
    });
  } finally {
    await app.close().catch(() => undefined);
    await pool.end();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});

test('encryption configuration persists locally and rejects missing production or corrupt keys', async () => {
  const directory = resolve('.local', 'key-qa-' + randomUUID());
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, 'master.key');
  const first = loadApiKeyEncryptionKey(undefined, true, file);
  assert.ok(/^[a-f0-9]{64}$/.test(first));
  assert.ok(loadApiKeyEncryptionKey(undefined, true, file) === first);
  assert.ok((await readFile(file, 'utf8')).trim() === first);
  assert.throws(() => loadApiKeyEncryptionKey(undefined, false, file), /生产环境/);
  assert.throws(() => loadApiKeyEncryptionKey('invalid', false, file), /64 位/);
  assert.ok(loadApiKeyEncryptionKey(first, false, file) === first);
  const concurrentFile = resolve(directory, 'concurrent.key');
  const script = `import { loadApiKeyEncryptionKey } from ${JSON.stringify(new URL('../backend/src/key-encryption.ts', import.meta.url).href)}; import { createHash } from 'node:crypto'; const key = loadApiKeyEncryptionKey(undefined, true, ${JSON.stringify(concurrentFile)}); process.stdout.write(createHash('sha256').update(key).digest('hex'));`;
  const launch = promisify(execFile);
  const simultaneous = await Promise.all(Array.from({ length: 4 }, () => launch(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])));
  assert.equal(new Set(simultaneous.map(result => result.stdout)).size, 1);
  assert.ok(simultaneous.every(result => result.stdout === hash(loadApiKeyEncryptionKey(undefined, true, concurrentFile))));
  await writeFile(file, 'corrupt');
  assert.throws(() => loadApiKeyEncryptionKey(undefined, true, file), /不会自动覆盖/);
  assert.equal(await readFile(file, 'utf8'), 'corrupt');
});
