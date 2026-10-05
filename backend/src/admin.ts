import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Services, publicUser, publicTree, publicKey, publicIdentity, publicModel, publicModelReply, publicModelReplyRule, publicUsage, publicLedger } from './services.js';
import { transaction } from './db.js';
import { fail, record, text, integer, uuid, username, password, hashPassword, pagination } from './security.js';
import type { ClientLike, UserRow, ModelRow, ModelReplyRow, ModelReplyRuleRow, Rules } from './types.js';
import { oauthProvider } from './oauth-settings.js';
import { DEFAULT_MODEL_REPLY } from './default-reply.js';

export async function registerAdmin(app: FastifyInstance, services: Services) {
  async function guard(db: ClientLike, actor: UserRow) {
    await db.query('SELECT id FROM admin_guard WHERE id=true FOR UPDATE');
    const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [actor.id])).rows[0];
    if (!current || current.status !== 'active' || current.role !== 'admin') fail(403, 'forbidden', '管理员权限已失效。');
  }
  async function adminTransaction<T>(actor: UserRow, fn: (db: ClientLike) => Promise<T>): Promise<T> {
    return transaction(services.pool, async db => { await guard(db, actor); return fn(db); });
  }
  async function protectLastAdmin(db: ClientLike, current: UserRow, nextRole: string, nextStatus: string) {
    if (current.role === 'admin' && current.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active')) {
      if (Number((await db.query('SELECT count(*) AS count FROM users WHERE role=\'admin\' AND status=\'active\'')).rows[0].count) <= 1) fail(409, 'last_admin', '至少需要保留一位有效管理员。');
    }
  }
  const adminBody = (value: unknown) => value === undefined ? {} : record(value);
  const reason = (body: any) => body.reason === undefined || (typeof body.reason === 'string' && !body.reason.trim()) ? '管理员操作' : text(body.reason, '操作原因', 500);
  function validateReply(value: unknown, chunkChars: number, delayMs: number) {
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > 20000) fail(400, 'invalid_request', '回复长度应为 1–20000 字符。');
    if (Math.ceil(Array.from(value).length / chunkChars) * delayMs > 120000) fail(400, 'invalid_request', '按当前分片和间隔，回复不能超过 120 秒。');
    return value;
  }
  async function replyModel(db: ClientLike, id: string) {
    const model = (await db.query<ModelRow>('SELECT * FROM models WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!model) fail(404, 'not_found', '模型不存在。');
    return model;
  }
  app.get('/api/admin/oauth', async (request, reply) => {
    await services.requireAdmin(request);
    reply.header('Cache-Control', 'no-store');
    return { items: await services.oauth.list() };
  });
  app.patch('/api/admin/oauth/:provider', async (request, reply) => {
    const actor = await services.requireAdmin(request);
    const provider = oauthProvider((request.params as any).provider);
    reply.header('Cache-Control', 'no-store');
    return adminTransaction(actor, async db => {
      const { before, item, changed } = await services.oauth.update(db, provider, request.body);
      if (changed) await services.audit(db, actor, 'oauth.update', provider, '管理员操作', before, item);
      return { item };
    });
  });
  app.get('/api/admin/stats', async request => {
    await services.requireAdmin(request);
    const counts = (await services.pool.query(`SELECT
      (SELECT count(*) FROM users WHERE status<>'deleted') AS users,
      (SELECT count(*) FROM users WHERE status='active') AS active_users,
      (SELECT count(*) FROM models WHERE deleted_at IS NULL) AS models,
      (SELECT count(*) FROM api_requests) AS requests,
      (SELECT COALESCE(sum(coins_delta),0) FROM ledger WHERE coins_delta>0) AS coins_issued,
      (SELECT COALESCE(-sum(coins_delta),0) FROM ledger WHERE kind='api_call') AS coins_spent`)).rows[0];
    return { users: Number(counts.users), activeUsers: Number(counts.active_users), models: Number(counts.models), requests: Number(counts.requests), coinsIssued: Number(counts.coins_issued), coinsSpent: Number(counts.coins_spent) };
  });
  app.get('/api/admin/users', async request => {
    await services.requireAdmin(request); const query = request.query as any; const { pageSize, offset } = pagination(query);
    const search = typeof query.search === 'string' ? query.search.slice(0, 100) : '';
    const pattern = `%${search}%`;
    const rows = (await services.pool.query<UserRow>('SELECT * FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [pattern, pageSize, offset])).rows;
    const total = Number((await services.pool.query('SELECT count(*) AS total FROM users WHERE username ILIKE $1 OR display_name ILIKE $1', [pattern])).rows[0].total);
    const identities = rows.length ? (await services.pool.query('SELECT user_id,provider,provider_user_id,display_name,created_at FROM identities WHERE user_id=ANY($1::uuid[]) ORDER BY provider', [rows.map(row => row.id)])).rows : [];
    const byUser = new Map<string, ReturnType<typeof publicIdentity>[]>();
    for (const identity of identities) {
      const items = byUser.get(identity.user_id) || [];
      items.push(publicIdentity(identity)); byUser.set(identity.user_id, items);
    }
    return { items: rows.map(row => ({ ...publicUser(row), identities: byUser.get(row.id) || [] })), total };
  });
  app.post('/api/admin/users', async request => {
    const actor = await services.requireAdmin(request); const body = adminBody(request.body); const account = username(body.username);
    const pass = await hashPassword(password(body.password)); const displayName = body.displayName === undefined ? account : text(body.displayName, '昵称', 64);
    const role = body.role || 'user'; if (!['user', 'admin'].includes(role)) fail(400, 'invalid_request', '角色无效。');
    const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const user = (await db.query<UserRow>('INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), account, displayName, pass, role])).rows[0];
      await db.query('INSERT INTO trees(user_id) VALUES($1)', [user.id]);
      await services.audit(db, actor, 'user.create', user.id, explanation, null, publicUser(user));
      return { user: publicUser(user) };
    });
  });
  app.get('/api/admin/users/:id', async request => {
    await services.requireAdmin(request); const id = uuid((request.params as any).id);
    const user = (await services.pool.query<UserRow>('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!user) fail(404, 'not_found', '用户不存在。');
    const tree = (await services.pool.query('SELECT * FROM trees WHERE user_id=$1', [id])).rows[0];
    const identities = (await services.pool.query('SELECT provider,provider_user_id,display_name,created_at FROM identities WHERE user_id=$1 ORDER BY provider', [id])).rows.map(publicIdentity);
    const keys = (await services.pool.query('SELECT * FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC', [id])).rows.map(publicKey);
    const usage = (await services.pool.query('SELECT * FROM api_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id])).rows.map(publicUsage);
    const ledger = (await services.pool.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id])).rows.map(publicLedger);
    return { user: publicUser(user), tree: publicTree(tree), identities, keys, usage, ledger };
  });
  async function updateUser(request: FastifyRequest, deleting = false) {
    const actor = await services.requireAdmin(request); const id = uuid((request.params as any).id); const body = adminBody(request.body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!user) fail(404, 'not_found', '用户不存在。');
      const account = body.username === undefined ? user.username : username(body.username);
      const displayName = body.displayName === undefined ? user.display_name : text(body.displayName, '昵称', 64);
      const role = body.role === undefined ? user.role : body.role; const status = deleting ? 'deleted' : (body.status === undefined ? user.status : body.status);
      if (!['user', 'admin'].includes(role) || !['active', 'banned', 'deleted'].includes(status)) fail(400, 'invalid_request', '角色或用户状态无效。');
      await protectLastAdmin(db, user, role, status);
      const updated = (await db.query<UserRow>('UPDATE users SET username=$2,display_name=$3,role=$4,status=$5,updated_at=now() WHERE id=$1 RETURNING *', [id, account, displayName, role, status])).rows[0];
      if (status !== 'active' || role !== user.role) await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      if (status === 'deleted') await db.query('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()),key_ciphertext=NULL WHERE user_id=$1', [id]);
      await services.audit(db, actor, deleting ? 'user.delete' : 'user.update', id, explanation, publicUser(user), publicUser(updated));
      return { user: publicUser(updated) };
    });
  }
  app.patch('/api/admin/users/:id', request => updateUser(request));
  app.delete('/api/admin/users/:id', request => updateUser(request, true));
  app.post('/api/admin/users/:id/password', async request => {
    const actor = await services.requireAdmin(request); const id = uuid((request.params as any).id); const body = adminBody(request.body); const pass = await hashPassword(password(body.password)); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!user || user.status === 'deleted') fail(404, 'not_found', '用户不存在或已删除。');
      await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [id, pass]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await services.audit(db, actor, 'user.password_reset', id, explanation, { hasPassword: !!user.password_hash }, { hasPassword: true, sessionsRevoked: true });
      return { ok: true };
    });
  });
  app.post('/api/admin/users/:id/adjust', async request => {
    const actor = await services.requireAdmin(request); const id = uuid((request.params as any).id); const body = adminBody(request.body); const explanation = reason(body);
    const coins = integer(body.coinsDelta ?? 0, '金币调整', -1000000000, 1000000000); const fertilizer = integer(body.fertilizerDelta ?? 0, '肥料调整', -1000000, 1000000);
    if (!coins && !fertilizer) fail(400, 'invalid_request', '请填写非零调整值。');
    return adminTransaction(actor, async db => {
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!user || user.status === 'deleted') fail(404, 'not_found', '用户不存在或已删除。');
      const rules = await services.rules(db);
      const finalCoins = Number(user.coins) + coins; const finalFertilizer = user.fertilizer + fertilizer;
      if (!Number.isSafeInteger(finalCoins) || finalCoins < 0 || finalFertilizer < 0 || finalFertilizer > Math.max(rules.inventoryLimit, user.fertilizer)) fail(409, 'invalid_balance', '调整后的余额不得为负，肥料不得超过库存上限。');
      const updated = (await db.query<UserRow>('UPDATE users SET coins=$2,fertilizer=$3,updated_at=now() WHERE id=$1 RETURNING *', [id, finalCoins, finalFertilizer])).rows[0];
      await services.addLedger(db, id, 'admin_adjustment', coins, fertilizer, explanation);
      await services.audit(db, actor, 'user.adjust', id, explanation, publicUser(user), publicUser(updated));
      return { user: publicUser(updated) };
    });
  });
  app.get('/api/admin/models', async request => {
    await services.requireAdmin(request);
    const models = (await services.pool.query<ModelRow>(`SELECT m.*,COALESCE(r.reply_count,0) AS reply_count,COALESCE(c.rule_count,0) AS rule_count
      FROM models m
      LEFT JOIN (SELECT model_id,count(*) AS reply_count FROM model_replies GROUP BY model_id) r ON r.model_id=m.id
      LEFT JOIN (SELECT model_id,count(*) AS rule_count FROM model_reply_rules GROUP BY model_id) c ON c.model_id=m.id
      WHERE m.deleted_at IS NULL ORDER BY m.coins_per_call,m.id`)).rows;
    return { items: models.map(row => publicModel(row, true)), defaultReplyText: DEFAULT_MODEL_REPLY };
  });
  function modelBody(body: any, existing?: ModelRow) {
    const id = body.id === undefined && existing ? existing.id : text(body.id, '模型 ID', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) fail(400, 'invalid_request', '模型 ID 仅支持字母、数字、点、冒号、下划线和短横线。');
    const displayName = body.displayName === undefined && existing ? existing.display_name : text(body.displayName, '显示名称', 80);
    const coinsPerCall = body.coinsPerCall === undefined && existing ? existing.coins_per_call : integer(body.coinsPerCall, '每次金币价格', 0, 1000000);
    const enabled = body.enabled === undefined ? existing?.enabled ?? true : body.enabled;
    if (typeof enabled !== 'boolean') fail(400, 'invalid_request', '启用状态必须是布尔值。');
    const replyText = body.replyText === undefined ? existing?.reply_text ?? DEFAULT_MODEL_REPLY : body.replyText;
    const streamChunkChars = body.streamChunkChars === undefined ? existing?.stream_chunk_chars ?? 8 : integer(body.streamChunkChars, '分片字符数', 1, 1000);
    const streamDelayMs = body.streamDelayMs === undefined ? existing?.stream_delay_ms ?? 20 : integer(body.streamDelayMs, '分片间隔', 0, 1000);
    validateReply(replyText, streamChunkChars, streamDelayMs);
    return { id, displayName, coinsPerCall, enabled, replyText, streamChunkChars, streamDelayMs };
  }
  app.post('/api/admin/models', async request => {
    const actor = await services.requireAdmin(request); const body = adminBody(request.body); const values = modelBody(body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const model = (await db.query<ModelRow>('INSERT INTO models(id,display_name,coins_per_call,enabled,reply_text,stream_chunk_chars,stream_delay_ms) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [values.id, values.displayName, values.coinsPerCall, values.enabled, values.replyText, values.streamChunkChars, values.streamDelayMs])).rows[0];
      await db.query('INSERT INTO model_replies(id,model_id,position,text) VALUES($1,$2,1,$3)', [randomUUID(), model.id, model.reply_text]);
      model.reply_count = 1; model.rule_count = 0;
      await services.audit(db, actor, 'model.create', model.id, explanation, null, publicModel(model, true));
      return { model: publicModel({ ...model, reply_count: 1, rule_count: 0 }, true) };
    });
  });
  app.patch('/api/admin/models/:id', async request => {
    const actor = await services.requireAdmin(request); const id = text((request.params as any).id, '模型 ID', 128); const body = adminBody(request.body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const existing = (await db.query<ModelRow>('SELECT * FROM models WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!existing) fail(404, 'not_found', '模型不存在。');
      const values = modelBody(body, existing);
      if (values.id !== id && (await db.query('SELECT id FROM models WHERE id=$1', [values.id])).rows.length) fail(409, 'model_id_exists', '此模型 ID 已存在，请使用其他 ID。');
      const replies = (await db.query<ModelReplyRow>('SELECT * FROM model_replies WHERE model_id=$1 ORDER BY position,id', [id])).rows;
      const inputRules = (await db.query<ModelReplyRuleRow>('SELECT * FROM model_reply_rules WHERE model_id=$1 ORDER BY position,id', [id])).rows;
      existing.reply_count = replies.length; existing.rule_count = inputRules.length;
      for (const item of replies) validateReply(replies.length === 1 && item.text === existing.reply_text ? values.replyText : item.text, values.streamChunkChars, values.streamDelayMs);
      for (const item of inputRules) validateReply(item.text, values.streamChunkChars, values.streamDelayMs);
      // Preserve the old single-reply edit form; configured multi-entry pools stay independent.
      if (body.replyText !== undefined && replies.length === 1 && replies[0].text === existing.reply_text) await db.query('UPDATE model_replies SET text=$2,updated_at=now() WHERE id=$1', [replies[0].id, values.replyText]);
      const model = (await db.query<ModelRow>('UPDATE models SET id=$2,display_name=$3,coins_per_call=$4,enabled=$5,reply_text=$6,stream_chunk_chars=$7,stream_delay_ms=$8,updated_at=now() WHERE id=$1 RETURNING *', [id, values.id, values.displayName, values.coinsPerCall, values.enabled, values.replyText, values.streamChunkChars, values.streamDelayMs])).rows[0];
      model.reply_count = replies.length; model.rule_count = inputRules.length;
      await services.audit(db, actor, 'model.update', model.id, explanation, publicModel(existing, true), publicModel(model, true));
      return { model: publicModel({ ...model, reply_count: replies.length, rule_count: inputRules.length }, true) };
    });
  });
  app.delete('/api/admin/models/:id', async request => {
    const actor = await services.requireAdmin(request); const id = text((request.params as any).id, '模型 ID', 128); const explanation = reason(adminBody(request.body));
    return adminTransaction(actor, async db => {
      const model = (await db.query<ModelRow>('SELECT * FROM models WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!model) fail(404, 'not_found', '模型不存在。');
      await db.query('UPDATE models SET enabled=false,deleted_at=now(),updated_at=now() WHERE id=$1', [id]);
      await services.audit(db, actor, 'model.delete', id, explanation, publicModel(model, true), { deleted: true });
      return { ok: true };
    });
  });
  app.get('/api/admin/models/:id/replies', async request => {
    await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128);
    if (!(await services.pool.query('SELECT id FROM models WHERE id=$1 AND deleted_at IS NULL', [id])).rows.length) fail(404, 'not_found', '模型不存在。');
    const items = (await services.pool.query<ModelReplyRow>('SELECT * FROM model_replies WHERE model_id=$1 ORDER BY position,id', [id])).rows.map(publicModelReply);
    return { items, total: items.length };
  });
  app.post('/api/admin/models/:id/replies', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const body = adminBody(request.body); const explanation = reason(body);
    const position = integer(body.position, '回复编号', 1, 1000000);
    return adminTransaction(actor, async db => {
      const model = await replyModel(db, id);
      const replyText = validateReply(body.text, model.stream_chunk_chars, model.stream_delay_ms);
      if (Number((await db.query('SELECT count(*) AS total FROM model_replies WHERE model_id=$1', [id])).rows[0].total) >= 500) fail(409, 'reply_limit', '每个模型最多配置 500 条回复。');
      if ((await db.query('SELECT id FROM model_replies WHERE model_id=$1 AND position=$2', [id, position])).rows.length) fail(409, 'reply_position_exists', '此回复编号已存在，请使用其他编号。');
      const item = (await db.query<ModelReplyRow>('INSERT INTO model_replies(id,model_id,position,text) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), id, position, replyText])).rows[0];
      await services.audit(db, actor, 'model.reply.create', `${id}:${item.id}`, explanation, null, publicModelReply(item));
      return { item: publicModelReply(item) };
    });
  });
  app.patch('/api/admin/models/:id/replies/:replyId', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const replyId = uuid((request.params as any).replyId); const body = adminBody(request.body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const model = await replyModel(db, id);
      const before = (await db.query<ModelReplyRow>('SELECT * FROM model_replies WHERE id=$1 AND model_id=$2', [replyId, id])).rows[0];
      if (!before) fail(404, 'not_found', '回复不存在。');
      const position = body.position === undefined ? before.position : integer(body.position, '回复编号', 1, 1000000);
      const replyText = validateReply(body.text === undefined ? before.text : body.text, model.stream_chunk_chars, model.stream_delay_ms);
      if ((await db.query('SELECT id FROM model_replies WHERE model_id=$1 AND position=$2 AND id<>$3', [id, position, replyId])).rows.length) fail(409, 'reply_position_exists', '此回复编号已存在，请使用其他编号。');
      const item = (await db.query<ModelReplyRow>('UPDATE model_replies SET position=$2,text=$3,updated_at=now() WHERE id=$1 RETURNING *', [replyId, position, replyText])).rows[0];
      await services.audit(db, actor, 'model.reply.update', `${id}:${replyId}`, explanation, publicModelReply(before), publicModelReply(item));
      return { item: publicModelReply(item) };
    });
  });
  app.delete('/api/admin/models/:id/replies/:replyId', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const replyId = uuid((request.params as any).replyId); const explanation = reason(adminBody(request.body));
    return adminTransaction(actor, async db => {
      await replyModel(db, id);
      const before = (await db.query<ModelReplyRow>('SELECT * FROM model_replies WHERE id=$1 AND model_id=$2', [replyId, id])).rows[0];
      if (!before) fail(404, 'not_found', '回复不存在。');
      await db.query('DELETE FROM model_replies WHERE id=$1', [replyId]);
      await services.audit(db, actor, 'model.reply.delete', `${id}:${replyId}`, explanation, publicModelReply(before), null);
      return { ok: true };
    });
  });
  app.get('/api/admin/settings', async request => { await services.requireAdmin(request); return services.rules(); });
  app.get('/api/admin/models/:id/rules', async request => {
    await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128);
    if (!(await services.pool.query('SELECT id FROM models WHERE id=$1 AND deleted_at IS NULL', [id])).rows.length) fail(404, 'not_found', '模型不存在。');
    const items = (await services.pool.query<ModelReplyRuleRow>('SELECT * FROM model_reply_rules WHERE model_id=$1 ORDER BY position,id', [id])).rows.map(publicModelReplyRule);
    return { items, total: items.length };
  });
  app.post('/api/admin/models/:id/rules', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const body = adminBody(request.body); const explanation = reason(body);
    const position = integer(body.position, '规则编号', 1, 1000000);
    const input = text(body.input, '客户输入', 2000);
    const enabled = body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== 'boolean') fail(400, 'invalid_request', '启用状态必须是布尔值。');
    return adminTransaction(actor, async db => {
      const model = await replyModel(db, id);
      const replyText = validateReply(body.text, model.stream_chunk_chars, model.stream_delay_ms);
      if (Number((await db.query('SELECT count(*) AS total FROM model_reply_rules WHERE model_id=$1', [id])).rows[0].total) >= 500) fail(409, 'rule_limit', '每个模型最多配置 500 条指定回复规则。');
      if ((await db.query('SELECT id FROM model_reply_rules WHERE model_id=$1 AND position=$2', [id, position])).rows.length) fail(409, 'rule_position_exists', '此规则编号已存在，请使用其他编号。');
      const item = (await db.query<ModelReplyRuleRow>('INSERT INTO model_reply_rules(id,model_id,position,input,text,enabled) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), id, position, input, replyText, enabled])).rows[0];
      await services.audit(db, actor, 'model.rule.create', `${id}:${item.id}`, explanation, null, publicModelReplyRule(item));
      return { item: publicModelReplyRule(item) };
    });
  });
  app.patch('/api/admin/models/:id/rules/:ruleId', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const ruleId = uuid((request.params as any).ruleId); const body = adminBody(request.body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const model = await replyModel(db, id);
      const before = (await db.query<ModelReplyRuleRow>('SELECT * FROM model_reply_rules WHERE id=$1 AND model_id=$2', [ruleId, id])).rows[0];
      if (!before) fail(404, 'not_found', '指定回复规则不存在。');
      const position = body.position === undefined ? before.position : integer(body.position, '规则编号', 1, 1000000);
      const input = body.input === undefined ? before.input : text(body.input, '客户输入', 2000);
      const replyText = validateReply(body.text === undefined ? before.text : body.text, model.stream_chunk_chars, model.stream_delay_ms);
      const enabled = body.enabled === undefined ? before.enabled : body.enabled;
      if (typeof enabled !== 'boolean') fail(400, 'invalid_request', '启用状态必须是布尔值。');
      if ((await db.query('SELECT id FROM model_reply_rules WHERE model_id=$1 AND position=$2 AND id<>$3', [id, position, ruleId])).rows.length) fail(409, 'rule_position_exists', '此规则编号已存在，请使用其他编号。');
      const item = (await db.query<ModelReplyRuleRow>('UPDATE model_reply_rules SET position=$2,input=$3,text=$4,enabled=$5,updated_at=now() WHERE id=$1 RETURNING *', [ruleId, position, input, replyText, enabled])).rows[0];
      await services.audit(db, actor, 'model.rule.update', `${id}:${ruleId}`, explanation, publicModelReplyRule(before), publicModelReplyRule(item));
      return { item: publicModelReplyRule(item) };
    });
  });
  app.delete('/api/admin/models/:id/rules/:ruleId', async request => {
    const actor = await services.requireAdmin(request);
    const id = text((request.params as any).id, '模型 ID', 128); const ruleId = uuid((request.params as any).ruleId); const explanation = reason(adminBody(request.body));
    return adminTransaction(actor, async db => {
      await replyModel(db, id);
      const before = (await db.query<ModelReplyRuleRow>('SELECT * FROM model_reply_rules WHERE id=$1 AND model_id=$2', [ruleId, id])).rows[0];
      if (!before) fail(404, 'not_found', '指定回复规则不存在。');
      await db.query('DELETE FROM model_reply_rules WHERE id=$1', [ruleId]);
      await services.audit(db, actor, 'model.rule.delete', `${id}:${ruleId}`, explanation, publicModelReplyRule(before), null);
      return { ok: true };
    });
  });
  app.patch('/api/admin/settings', async request => {
    const actor = await services.requireAdmin(request); const body = adminBody(request.body); const explanation = reason(body);
    return adminTransaction(actor, async db => {
      const old = await services.rules(db); const next: Rules = { ...old };
      const fields = ['dailyFertilizer', 'inventoryLimit', 'coinsPerFeed', 'growthPerFeed', 'apiRateLimit'] as const;
      for (const field of fields) if (body[field] !== undefined) next[field] = integer(body[field], field, ['growthPerFeed', 'apiRateLimit'].includes(field) ? 1 : 0, field === 'apiRateLimit' ? 10000 : 1000000);
      await db.query('UPDATE settings SET rules=$1::jsonb,updated_at=now() WHERE id=true', [JSON.stringify(next)]);
      await services.audit(db, actor, 'settings.update', 'rules', explanation, old, next);
      return next;
    });
  });
  app.get('/api/admin/audit', async request => {
    await services.requireAdmin(request); const { pageSize, offset } = pagination(request.query);
    const rows = (await services.pool.query('SELECT * FROM audit ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2', [pageSize, offset])).rows;
    const total = Number((await services.pool.query('SELECT count(*) AS total FROM audit')).rows[0].total);
    return { items: rows.map(row => ({ id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action, targetId: row.target_id, reason: row.reason, before: row.before_value, after: row.after_value, createdAt: row.created_at })), total };
  });
  app.get('/api/admin/usage', async request => {
    await services.requireAdmin(request); const query = request.query as any; const { pageSize, offset } = pagination(query);
    const userId = query.userId ? uuid(query.userId) : null; const modelId = query.modelId ? text(query.modelId, '模型 ID', 128) : null;
    const where = '($1::uuid IS NULL OR r.user_id=$1::uuid) AND ($2::text IS NULL OR r.model_id=$2::text)';
    const rows = (await services.pool.query(`SELECT r.*,u.username FROM api_requests r JOIN users u ON u.id=r.user_id WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4`, [userId, modelId, pageSize, offset])).rows;
    const total = Number((await services.pool.query(`SELECT count(*) AS total FROM api_requests r WHERE ${where}`, [userId, modelId])).rows[0].total);
    return { items: rows.map(publicUsage), total };
  });
}
