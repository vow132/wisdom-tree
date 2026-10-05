import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';

const origin = 'http://127.0.0.1:5173';
const password = 'Disposable-rules-test-password-2026';
type Jar = Map<string, string>;

test('conditional model replies, editable IDs and reason-free admin integration', { timeout: 120_000 }, async t => {
  // Every run owns a new database. No preview users, credentials or data are touched.
  const dataDir = join(tmpdir(), 'wisdom-rules-test-' + randomUUID());
  await mkdir(dataDir, { recursive: true });
  const oldMode = process.env.DATABASE_MODE;
  const oldPath = process.env.PGLITE_PATH;
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = dataDir;
  const pool = await getPool();
  await runMigrations(pool);
  const app = await buildApp({ pool, config: {
    publicOrigin: origin, secureCookies: false, development: true,
    apiKeyEncryptionKey: randomBytes(32).toString('hex'),
    githubClientId: '', linuxdoClientId: '',
  } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiOrigin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  const adminJar: Jar = new Map();
  const userJar: Jar = new Map();
  async function request(jar: Jar | null, method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (jar) headers.cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
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
  async function model(id: string, replyText = '默认回复', coinsPerCall = 0) {
    return (await ok(adminJar, 'POST', '/api/admin/models', {
      id, displayName: id, replyText, coinsPerCall, streamChunkChars: 2, streamDelayMs: 0,
    })).model;
  }
  async function rule(modelId: string, position: number, input: string, text: string, enabled = true) {
    return (await ok(adminJar, 'POST', `/api/admin/models/${modelId}/rules`, { position, input, text, enabled })).item;
  }
  let userId = '';
  let adminId = '';
  let apiKey = '';
  let sdk: OpenAI;
  let anthropic: Anthropic;
  async function chat(modelId: string, content = 'unmatched', headers?: Record<string, string>) {
    const result = await sdk.chat.completions.create({ model: modelId, messages: [{ role: 'user', content }] }, { headers });
    return result.choices[0].message.content;
  }
  try {
    await createAdmin(pool, 'rules_admin', password);
    adminId = (await ok(adminJar, 'POST', '/api/auth/login', { username: 'rules_admin', password })).user.id;
    userId = (await ok(userJar, 'POST', '/api/auth/register', { username: 'rules_gardener', password })).user.id;
    await ok(adminJar, 'PATCH', '/api/admin/settings', { apiRateLimit: 10000 });
    await ok(adminJar, 'POST', `/api/admin/users/${userId}/adjust`, { coinsDelta: 1000 });
    apiKey = (await ok(userJar, 'POST', '/api/keys', { name: 'Disposable rule SDK test' })).key;
    sdk = new OpenAI({ apiKey, baseURL: apiOrigin + '/v1', maxRetries: 0 });
    anthropic = new Anthropic({ apiKey, authToken: null, baseURL: apiOrigin, maxRetries: 0 });

    await t.test('fresh wisdom import is complete and the legacy edit field agrees with the first reply', async () => {
      const corpus = JSON.parse(await readFile(new URL('../backend/data/wisdom-tree-quotes.json', import.meta.url), 'utf8')) as { text: string }[];
      const models = (await ok(adminJar, 'GET', '/api/admin/models')).items;
      const tree = models.find((item: any) => item.id === 'wisdom-tree');
      const replies = await ok(adminJar, 'GET', '/api/admin/models/wisdom-tree/replies');
      assert.equal(corpus.length, 80);
      assert.equal(tree.isWisdomTree, true);
      assert.equal(tree.replyCount, 80);
      assert.equal(tree.replyText, corpus[0].text);
      assert.deepEqual(replies.items.map((item: any) => item.text), corpus.map(item => item.text));
      const first = replies.items[0];
      await ok(adminJar, 'PATCH', `/api/admin/models/wisdom-tree/replies/${first.id}`, { text: '保留管理员编辑的语录' });
      await runMigrations(pool);
      assert.equal((await ok(adminJar, 'GET', '/api/admin/models/wisdom-tree/replies')).items[0].text, '保留管理员编辑的语录');
      await ok(adminJar, 'PATCH', `/api/admin/models/wisdom-tree/replies/${first.id}`, { text: first.text });
    });

    await t.test('rule CRUD validates input, numbering, permissions and stream duration without reasons', async () => {
      await model('qa-rule-crud');
      const url = '/api/admin/models/qa-rule-crud/rules';
      assert.equal((await ok(adminJar, 'GET', url)).total, 0);
      assert.equal((await request(null, 'GET', url)).statusCode, 401);
      assert.equal((await request(userJar, 'GET', url)).statusCode, 403);
      assert.equal((await request(userJar, 'POST', url, { position: 1, input: '你好', text: '越权' })).statusCode, 403);
      const first = (await ok(adminJar, 'POST', url, { position: 10, input: '  你好\n', text: '你好！' })).item;
      assert.equal(first.input, '你好');
      assert.equal(first.enabled, true);
      assert.equal((await request(adminJar, 'POST', url, { position: 10, input: '再见', text: '再见' })).statusCode, 409);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: ' \n ', text: '空匹配' })).statusCode, 400);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: 'x'.repeat(2001), text: '太长' })).statusCode, 400);
      const chineseBoundary = await rule('qa-rule-crud', 8, '中'.repeat(2000), '中文长度边界正常');
      assert.equal(await chat('qa-rule-crud', '中'.repeat(2000)), '中文长度边界正常');
      assert.equal((await request(adminJar, 'POST', url, { position: 9, input: '中'.repeat(2001), text: '超过中文长度边界' })).statusCode, 400);
      await ok(adminJar, 'DELETE', `${url}/${chineseBoundary.id}`);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: '空返回', text: '  ' })).statusCode, 400);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: '太长', text: 'x'.repeat(20001) })).statusCode, 400);
      assert.equal((await request(adminJar, 'POST', url, { position: 0, input: '编号', text: '无效' })).statusCode, 400);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: '布尔值', text: '无效', enabled: 'yes' })).statusCode, 400);
      const earlier = await rule('qa-rule-crud', 2, '你好', '优先命中');
      assert.equal(await chat('qa-rule-crud', '你好'), '优先命中');
      assert.equal((await request(adminJar, 'PATCH', `${url}/${first.id}`, { position: 2 })).statusCode, 409);
      const changed = (await ok(adminJar, 'PATCH', `${url}/${first.id}`, { position: 1, input: ' Hello ', text: '已修改', enabled: false })).item;
      assert.deepEqual([changed.position, changed.input, changed.text, changed.enabled], [1, 'Hello', '已修改', false]);
      assert.equal((await request(userJar, 'PATCH', `${url}/${first.id}`, { text: '越权' })).statusCode, 403);
      assert.equal((await request(userJar, 'DELETE', `${url}/${first.id}`)).statusCode, 403);
      assert.equal((await request(adminJar, 'PATCH', `/api/admin/models/qa-rule-crud`, { streamChunkChars: 1, streamDelayMs: 1000, replyText: 'x'.repeat(121) })).statusCode, 400);
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-rule-crud', { streamChunkChars: 1, streamDelayMs: 1000 });
      assert.equal((await request(adminJar, 'POST', url, { position: 5, input: 'long', text: 'x'.repeat(121) })).statusCode, 400);
      await ok(adminJar, 'PATCH', '/api/admin/models/qa-rule-crud', { streamChunkChars: 2, streamDelayMs: 0 });
      const longRule = await rule('qa-rule-crud', 5, 'long', 'x'.repeat(121));
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/models/qa-rule-crud', { streamChunkChars: 1, streamDelayMs: 1000 })).statusCode, 400);
      const listed = (await ok(adminJar, 'GET', '/api/admin/models')).items.find((item: any) => item.id === 'qa-rule-crud');
      assert.equal(listed.ruleCount, 3);
      for (const item of [first, earlier, longRule]) await ok(adminJar, 'DELETE', `${url}/${item.id}`);
      assert.equal((await ok(adminJar, 'GET', url)).total, 0);
      assert.equal((await request(adminJar, 'DELETE', `${url}/${first.id}`)).statusCode, 404);
      await ok(adminJar, 'DELETE', '/api/admin/models/qa-rule-crud');
      assert.equal((await request(adminJar, 'GET', url)).statusCode, 404);
      assert.equal((await request(adminJar, 'POST', url, { position: 1, input: '你好', text: '已删除模型' })).statusCode, 404);
    });

    await t.test('official SDKs receive conditional text for all four protocols in JSON and SSE', async () => {
      await model('qa-wire-rules', '普通返回');
      await rule('qa-wire-rules', 1, '你好', '你好，欢迎回来！');
      const expected = '你好，欢迎回来！';
      const messages = [{ role: 'user' as const, content: ' \n你好\t ' }];
      const jsonChat = await sdk.chat.completions.create({ model: 'qa-wire-rules', messages });
      assert.equal(jsonChat.choices[0].message.content, expected);
      const chatStream = await sdk.chat.completions.create({ model: 'qa-wire-rules', messages, stream: true });
      let text = '';
      for await (const part of chatStream) text += part.choices[0]?.delta.content || '';
      assert.equal(text, expected);
      const completion = await sdk.completions.create({ model: 'qa-wire-rules', prompt: '你好' });
      assert.equal(completion.choices[0].text, expected);
      const completionStream = await sdk.completions.create({ model: 'qa-wire-rules', prompt: '你好', stream: true });
      text = '';
      for await (const part of completionStream) text += part.choices[0]?.text || '';
      assert.equal(text, expected);
      const response = await sdk.responses.create({ model: 'qa-wire-rules', input: '你好' });
      assert.equal(response.output_text, expected);
      const responseStream = await sdk.responses.create({ model: 'qa-wire-rules', input: '你好', stream: true });
      text = '';
      for await (const part of responseStream) if (part.type === 'response.output_text.delta') text += part.delta;
      assert.equal(text, expected);
      const message = await anthropic.messages.create({ model: 'qa-wire-rules', max_tokens: 100, messages });
      assert.equal(message.content[0].type === 'text' ? message.content[0].text : '', expected);
      const messageStream = await anthropic.messages.create({ model: 'qa-wire-rules', max_tokens: 100, messages, stream: true });
      text = '';
      for await (const part of messageStream) if (part.type === 'content_block_delta' && part.delta.type === 'text_delta') text += part.delta.text;
      assert.equal(text, expected);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, 'qa-wire-rules'])).rows[0].n, 0);
    });

    await t.test('matching uses only the last user text, joins text blocks and preserves letter case', async () => {
      await rule('qa-wire-rules', 2, 'Hello', '大小写匹配');
      const headers = { authorization: 'Bearer ' + apiKey };
      const chatReply = async (messages: unknown[]) => (await ok(null, 'POST', '/v1/chat/completions', { model: 'qa-wire-rules', messages }, headers)).choices[0].message.content;
      assert.equal(await chatReply([{ role: 'system', content: '你好' }, { role: 'user', content: 'miss' }]), '普通返回');
      assert.equal(await chatReply([{ role: 'user', content: '你好' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'miss' }]), '普通返回');
      assert.equal(await chatReply([{ role: 'user', content: '你好' }, { role: 'assistant', content: 'miss' }]), '你好，欢迎回来！');
      assert.equal(await chatReply([{ role: 'assistant', content: '你好' }]), '普通返回');
      assert.equal(await chatReply([{ role: 'user', content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] }]), '你好，欢迎回来！');
      assert.equal(await chat('qa-wire-rules', ' Hello '), '大小写匹配');
      assert.equal(await chat('qa-wire-rules', 'hello'), '普通返回');
      assert.equal(await chat('qa-wire-rules', 'HELLO'), '普通返回');
      assert.equal(await chat('qa-wire-rules', '你 好'), '普通返回');
      const input = [
        { role: 'user', content: [{ type: 'input_text', text: 'miss' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
        { role: 'user', content: [{ type: 'input_text', text: '你' }, { type: 'input_text', text: '好' }] },
      ];
      const response = await sdk.responses.create({ model: 'qa-wire-rules', input: input as any });
      assert.equal(response.output_text, '你好，欢迎回来！');
      const responseLast = await sdk.responses.create({ model: 'qa-wire-rules', input: [...input, { role: 'user', content: 'miss' }] as any });
      assert.equal(responseLast.output_text, '普通返回');
      const message = await anthropic.messages.create({ model: 'qa-wire-rules', max_tokens: 100, messages: [
        { role: 'user', content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] },
      ] });
      assert.equal(message.content[0].type === 'text' ? message.content[0].text : '', '你好，欢迎回来！');
      const batch = await sdk.completions.create({ model: 'qa-wire-rules', prompt: ['你好', 'miss'] });
      assert.equal(batch.choices[0].text, '你好，欢迎回来！');
      const tokenPrompt = await sdk.completions.create({ model: 'qa-wire-rules', prompt: [100, 101] });
      assert.equal(tokenPrompt.choices[0].text, '普通返回');
    });

    await t.test('matched requests do not advance ordered replies; disabled rules and models stay independent', async () => {
      await model('qa-rule-cycle', 'A');
      await ok(adminJar, 'POST', '/api/admin/models/qa-rule-cycle/replies', { position: 2, text: 'B' });
      await ok(adminJar, 'POST', '/api/admin/models/qa-rule-cycle/replies', { position: 3, text: 'C' });
      const first = await rule('qa-rule-cycle', 1, 'hi', '精确回复');
      await model('qa-rule-other', 'X');
      await ok(adminJar, 'POST', '/api/admin/models/qa-rule-other/replies', { position: 2, text: 'Y' });
      assert.equal(await chat('qa-rule-cycle'), 'A');
      const cursorBefore = (await pool.query('SELECT last_reply_id FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, 'qa-rule-cycle'])).rows[0].last_reply_id;
      assert.equal(await chat('qa-rule-cycle', 'hi'), '精确回复');
      assert.equal(await chat('qa-rule-cycle', ' hi '), '精确回复');
      assert.equal((await pool.query('SELECT last_reply_id FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, 'qa-rule-cycle'])).rows[0].last_reply_id, cursorBefore);
      assert.equal(await chat('qa-rule-cycle'), 'B');
      assert.equal(await chat('qa-rule-other', 'hi'), 'X');
      await rule('qa-rule-other', 1, 'hi', '另一个模型的回复');
      assert.equal(await chat('qa-rule-other', 'hi'), '另一个模型的回复');
      assert.equal(await chat('qa-rule-cycle', 'hi'), '精确回复');
      await ok(adminJar, 'PATCH', `/api/admin/models/qa-rule-cycle/rules/${first.id}`, { enabled: false });
      assert.equal(await chat('qa-rule-cycle', 'hi'), 'C');
      await ok(adminJar, 'PATCH', `/api/admin/models/qa-rule-cycle/rules/${first.id}`, { enabled: true });
      assert.equal(await chat('qa-rule-cycle', 'hi'), '精确回复');
      assert.equal(await chat('qa-rule-cycle'), 'A');
      assert.equal(await chat('qa-rule-other'), 'Y');
    });

    await t.test('rule edits and deletion never change an accepted idempotent reply or repeat its charge', async () => {
      await model('qa-rule-snapshot', '未命中', 2);
      const item = await rule('qa-rule-snapshot', 1, '你好', '最初规则返回');
      const payload = { model: 'qa-rule-snapshot', messages: [{ role: 'user' as const, content: '你好' }] };
      const idem = randomUUID();
      const headers = { 'Idempotency-Key': idem };
      const before = (await ok(userJar, 'GET', '/api/me')).user.coins;
      const accepted = await Promise.all(Array.from({ length: 4 }, () => sdk.chat.completions.create(payload, { headers })));
      accepted.forEach(value => assert.deepEqual(value, accepted[0]));
      assert.equal(accepted[0].choices[0].message.content, '最初规则返回');
      await ok(adminJar, 'PATCH', `/api/admin/models/qa-rule-snapshot/rules/${item.id}`, { text: '编辑后的返回' });
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers }), accepted[0]);
      await ok(adminJar, 'DELETE', `/api/admin/models/qa-rule-snapshot/rules/${item.id}`);
      assert.deepEqual(await sdk.chat.completions.create(payload, { headers }), accepted[0]);
      assert.equal((await ok(userJar, 'GET', '/api/me')).user.coins, before - 2);
      const stored = (await pool.query('SELECT result,coins_charged FROM api_requests WHERE user_id=$1 AND idem_key=$2', [userId, idem])).rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].result.replyText, '最初规则返回');
      assert.equal(stored[0].result.ruleId, item.id);
      assert.equal(Number(stored[0].coins_charged), 2);
      assert.equal((await request(null, 'POST', '/v1/chat/completions', { ...payload, messages: [{ role: 'user', content: '不同请求' }] }, { authorization: 'Bearer ' + apiKey, 'Idempotency-Key': idem })).statusCode, 409);
      assert.equal(await chat('qa-rule-snapshot', '你好'), '未命中');
    });

    await t.test('renaming a used model preserves replies, rules, cursor and immutable historical response snapshots', async () => {
      const oldId = 'qa-rename-used';
      const newId = 'qa-renamed-used';
      await model(oldId, 'A', 1);
      const second = (await ok(adminJar, 'POST', `/api/admin/models/${oldId}/replies`, { position: 2, text: 'B' })).item;
      const match = await rule(oldId, 1, '你好', '欢迎');
      const originalPayload = { model: oldId, input: 'not matched' };
      const idem = randomUUID();
      const headers = { 'Idempotency-Key': idem };
      const original = await sdk.responses.create(originalPayload, { headers });
      assert.equal(original.output_text, 'A');
      const cursor = (await pool.query('SELECT last_reply_id FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, oldId])).rows[0].last_reply_id;
      const beforeCoins = (await ok(userJar, 'GET', '/api/me')).user.coins;
      const changed = (await ok(adminJar, 'PATCH', `/api/admin/models/${oldId}`, { id: newId, displayName: '改名模型' })).model;
      assert.equal(changed.id, newId);
      assert.equal((await request(adminJar, 'GET', `/api/admin/models/${oldId}/replies`)).statusCode, 404);
      assert.ok((await ok(adminJar, 'GET', `/api/admin/models/${newId}/replies`)).items.some((item: any) => item.id === second.id));
      assert.ok((await ok(adminJar, 'GET', `/api/admin/models/${newId}/rules`)).items.some((item: any) => item.id === match.id));
      assert.equal((await pool.query('SELECT last_reply_id FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, newId])).rows[0].last_reply_id, cursor);
      assert.equal((await pool.query('SELECT model_id,result FROM api_requests WHERE user_id=$1 AND idem_key=$2', [userId, idem])).rows[0].model_id, newId);
      assert.equal((await pool.query('SELECT result FROM api_requests WHERE user_id=$1 AND idem_key=$2', [userId, idem])).rows[0].result.modelId, oldId);
      assert.deepEqual(await sdk.responses.create(originalPayload, { headers }), original);
      assert.equal((await ok(userJar, 'GET', '/api/me')).user.coins, beforeCoins);
      assert.equal((await request(null, 'POST', '/v1/responses', originalPayload, { authorization: 'Bearer ' + apiKey })).statusCode, 404);
      assert.equal(await chat(newId, '你好'), '欢迎');
      assert.equal(await chat(newId), 'B');
      const usage = (await ok(userJar, 'GET', '/api/usage')).items;
      assert.ok(usage.some((item: any) => item.id === original.id.slice(5) && item.modelId === newId));
      assert.equal((await request(adminJar, 'PATCH', `/api/admin/models/${newId}`, { id: 'gpt-5.6-luna' })).statusCode, 409);
      assert.ok((await ok(adminJar, 'GET', `/api/admin/models/${newId}/replies`)).items.some((item: any) => item.id === second.id));
      assert.equal(await chat(newId), 'A');
      const audit = (await pool.query("SELECT before_value,after_value FROM audit WHERE action='model.update' AND target_id=$1 ORDER BY created_at DESC LIMIT 1", [newId])).rows[0];
      assert.equal(audit.before_value.id, oldId);
      assert.equal(audit.after_value.id, newId);
    });

    await t.test('wisdom-tree may be renamed while garden dialogue, feeding and API keep sharing its pool', async () => {
      const oldId = 'wisdom-tree';
      const newId = 'qa-wisdom-renamed';
      const quotes = (await ok(adminJar, 'GET', `/api/admin/models/${oldId}/replies`)).items;
      await ok(userJar, 'POST', '/api/tree/seed', {}, { 'Idempotency-Key': randomUUID() });
      const planted = await ok(userJar, 'POST', '/api/tree/plant', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(planted.dialogue.content, quotes[0].text);
      const idem = randomUUID();
      const originalTalk = await ok(userJar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': idem });
      assert.equal(originalTalk.content, quotes[1].text);
      const changed = (await ok(adminJar, 'PATCH', `/api/admin/models/${oldId}`, { id: newId })).model;
      assert.equal(changed.isWisdomTree, true);
      assert.equal(changed.replyCount, 80);
      await rule(newId, 1, '你好', '智慧树指定欢迎');
      const before = await ok(userJar, 'GET', '/api/me');
      const next = await ok(userJar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(next.modelId, newId);
      assert.equal(next.content, quotes[2].text);
      assert.deepEqual(await ok(userJar, 'GET', '/api/me'), before);
      assert.deepEqual(await ok(userJar, 'POST', '/api/tree/talk', {}, { 'Idempotency-Key': idem }), originalTalk);
      assert.equal(await chat(newId, '你好'), '智慧树指定欢迎');
      assert.equal(await chat(newId), quotes[3].text);
      await ok(userJar, 'POST', '/api/tree/claim-fertilizer', {}, { 'Idempotency-Key': randomUUID() });
      const fed = await ok(userJar, 'POST', '/api/tree/feed', {}, { 'Idempotency-Key': randomUUID() });
      assert.equal(fed.dialogue.modelId, newId);
      assert.equal(fed.dialogue.content, quotes[4].text);
      await runMigrations(pool);
      const listed = (await ok(adminJar, 'GET', '/api/admin/models')).items;
      assert.equal(listed.filter((item: any) => item.isWisdomTree).length, 1);
      assert.ok(!listed.some((item: any) => item.id === oldId));
      assert.equal((await ok(adminJar, 'GET', `/api/admin/models/${newId}/replies`)).total, 80);
    });

    await t.test('all user, reply and settings mutations accept omitted reasons; audits and ledgers keep automatic explanations', async () => {
      const item = (await ok(adminJar, 'POST', '/api/admin/users', { username: 'reasonless_account', displayName: '无原因用户', password })).user;
      await ok(adminJar, 'PATCH', `/api/admin/users/${item.id}`, { displayName: '直接编辑', reason: '' });
      await ok(adminJar, 'POST', `/api/admin/users/${item.id}/password`, { password: 'Disposable-changed-password-2026' });
      await ok(adminJar, 'POST', `/api/admin/users/${item.id}/adjust`, { coinsDelta: 7, fertilizerDelta: 2 });
      await ok(adminJar, 'PATCH', `/api/admin/users/${item.id}`, { status: 'banned' });
      await ok(adminJar, 'PATCH', `/api/admin/users/${item.id}`, { status: 'active', reason: '  ' });
      await ok(adminJar, 'DELETE', `/api/admin/users/${item.id}`);
      await ok(adminJar, 'PATCH', '/api/admin/settings', { dailyFertilizer: 7, coinsPerFeed: 2 });
      await model('qa-reasonless-replies');
      const reply = (await ok(adminJar, 'POST', '/api/admin/models/qa-reasonless-replies/replies', { position: 2, text: '无需理由' })).item;
      await ok(adminJar, 'PATCH', `/api/admin/models/qa-reasonless-replies/replies/${reply.id}`, { text: '直接保存' });
      await ok(adminJar, 'DELETE', `/api/admin/models/qa-reasonless-replies/replies/${reply.id}`);
      await ok(adminJar, 'DELETE', '/api/admin/models/qa-reasonless-replies');
      const actions = (await pool.query('SELECT action,reason,actor_id,before_value,after_value FROM audit')).rows;
      for (const action of ['user.create', 'user.update', 'user.password_reset', 'user.adjust', 'user.delete', 'settings.update', 'model.create', 'model.update', 'model.delete', 'model.reply.create', 'model.reply.update', 'model.reply.delete', 'model.rule.create', 'model.rule.update', 'model.rule.delete']) {
        const matching = actions.filter(row => row.action === action);
        assert.ok(matching.length, `missing audit action ${action}`);
        assert.ok(matching.every(row => typeof row.reason === 'string' && row.reason.trim().length > 0));
        assert.ok(matching.every(row => row.actor_id === adminId));
      }
      const ledger = (await pool.query("SELECT reason,coins_delta,fertilizer_delta FROM ledger WHERE user_id=$1 AND kind='admin_adjustment'", [item.id])).rows[0];
      assert.equal(Number(ledger.coins_delta), 7);
      assert.equal(ledger.fertilizer_delta, 2);
      assert.ok(ledger.reason.trim());
      assert.equal((await request(adminJar, 'PATCH', `/api/admin/users/${adminId}`, { role: 'user' })).statusCode, 409);
      assert.equal((await request(adminJar, 'PATCH', `/api/admin/users/${adminId}`, { status: 'banned' })).statusCode, 409);
      assert.equal((await request(adminJar, 'DELETE', `/api/admin/users/${adminId}`)).statusCode, 409);
      assert.equal((await ok(adminJar, 'GET', '/api/me')).user.role, 'admin');
    });
  } finally {
    await app.close();
    await pool.end();
    if (oldMode === undefined) delete process.env.DATABASE_MODE; else process.env.DATABASE_MODE = oldMode;
    if (oldPath === undefined) delete process.env.PGLITE_PATH; else process.env.PGLITE_PATH = oldPath;
  }
});
