import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { fail, idempotencyKey, dateShanghai, pagination } from './security.js';
import { Services, publicLedger, publicUsage, publicModel } from './services.js';
import { hash, randomToken, record, text, uuid, encryptApiKey } from './security.js';
import type { UserRow, ModelRow, ModelDialogue } from './types.js';

export async function registerGame(app: FastifyInstance, services: Services) {
  app.get('/api/me', async request => services.state((await services.sessionUser(request))?.id || null));
  for (const action of ['seed', 'plant', 'claim-fertilizer', 'feed']) {
    const endpoint = `/api/tree/${action}`;
    app.post(endpoint, async request => {
      const sessionUser = await services.requireUser(request);
      const key = idempotencyKey(request.headers['idempotency-key'], true)!;
      return transaction(services.pool, async db => {
        const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [sessionUser.id])).rows[0];
        if (user.status !== 'active') fail(401, 'unauthorized', '账号已停用。');
        const previous = (await db.query('SELECT result FROM game_actions WHERE user_id=$1 AND endpoint=$2 AND idem_key=$3', [user.id, endpoint, key])).rows[0];
        if (previous) return previous.result;
        const tree = (await db.query('SELECT * FROM trees WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
        const rules = await services.rules(db);
        const actionId = randomUUID();
        let reward: any = undefined;
        let dialogue: ModelDialogue | null = null;
        if (action === 'seed') {
          if (tree.seed_claimed) fail(409, 'seed_already_claimed', '你已经领取过智慧树种子。');
          await db.query('UPDATE trees SET seed_claimed=true WHERE user_id=$1', [user.id]);
        } else if (action === 'plant') {
          if (!tree.seed_claimed) fail(409, 'seed_required', '请先领取智慧树种子。');
          if (tree.planted) fail(409, 'already_planted', '智慧树已经种下。');
          await db.query('UPDATE trees SET planted=true,height=1 WHERE user_id=$1', [user.id]);
          dialogue = await services.treeDialogue(db, user.id);
        } else if (action === 'claim-fertilizer') {
          if (!tree.planted) fail(409, 'tree_required', '种下智慧树后即可领取肥料。');
          const date = dateShanghai();
          const claimed = Number((await db.query('SELECT amount FROM daily_claims WHERE user_id=$1 AND claim_date=$2', [user.id, date])).rows[0]?.amount || 0);
          const remaining = Math.max(0, rules.dailyFertilizer - claimed);
          if (!remaining) fail(409, 'daily_already_claimed', '今天的免费肥料已经领取。');
          const amount = Math.max(0, Math.min(remaining, rules.inventoryLimit - user.fertilizer));
          if (!amount && rules.dailyFertilizer > 0) fail(409, 'inventory_full', '肥料库存已满，使用后再领取。');
          await db.query('INSERT INTO daily_claims(id,user_id,claim_date,amount) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,claim_date) DO UPDATE SET amount=daily_claims.amount+EXCLUDED.amount', [actionId, user.id, date, amount]);
          await db.query('UPDATE users SET fertilizer=fertilizer+$2,updated_at=now() WHERE id=$1', [user.id, amount]);
          await services.addLedger(db, user.id, 'daily_fertilizer', 0, amount, `每日免费肥料 · ${date}`, `game:${actionId}`);
          reward = { fertilizer: amount };
        } else {
          if (!tree.planted) fail(409, 'tree_required', '请先种下智慧树。');
          if (user.fertilizer < 1) fail(409, 'insufficient_fertilizer', '肥料不足，可以领取今日免费肥料。');
          if (Number(user.coins) + rules.coinsPerFeed > Number.MAX_SAFE_INTEGER || Number(tree.height) + rules.growthPerFeed > Number.MAX_SAFE_INTEGER) fail(409, 'limit_reached', '数值已达到上限。');
          await db.query('UPDATE users SET fertilizer=fertilizer-1,coins=coins+$2,updated_at=now() WHERE id=$1', [user.id, rules.coinsPerFeed]);
          await db.query('UPDATE trees SET height=height+$2 WHERE user_id=$1', [user.id, rules.growthPerFeed]);
          await services.addLedger(db, user.id, 'feed', rules.coinsPerFeed, -1, `施肥 · 生长 ${rules.growthPerFeed}`, `game:${actionId}`);
          reward = { coins: rules.coinsPerFeed, growth: rules.growthPerFeed };
          dialogue = await services.treeDialogue(db, user.id);
        }
        const result = { ...(await services.state(user.id, db)), ...(reward ? { reward } : {}), ...(dialogue ? { tip: dialogue.content, dialogue } : {}) };
        await db.query('INSERT INTO game_actions(id,user_id,endpoint,idem_key,result) VALUES($1,$2,$3,$4,$5::jsonb)', [actionId, user.id, endpoint, key, JSON.stringify(result)]);
        return result;
      });
    });
  }
  app.post('/api/tree/talk', async request => {
    const sessionUser = await services.requireUser(request);
    const key = idempotencyKey(request.headers['idempotency-key'], true)!;
    return transaction(services.pool, async db => {
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [sessionUser.id])).rows[0];
      if (!user || user.status !== 'active') fail(401, 'unauthorized', '账号已停用。');
      const previous = (await db.query("SELECT result FROM game_actions WHERE user_id=$1 AND endpoint='/api/tree/talk' AND idem_key=$2", [user.id, key])).rows[0];
      if (previous) return previous.result;
      const tree = (await db.query('SELECT planted FROM trees WHERE user_id=$1', [user.id])).rows[0];
      if (!tree?.planted) fail(409, 'tree_required', '请先种下智慧树。');
      const dialogue = await services.treeDialogue(db, user.id);
      if (!dialogue) fail(404, 'model_not_found', '智慧树模型已停用，请联系管理员。');
      await db.query("INSERT INTO game_actions(id,user_id,endpoint,idem_key,result) VALUES($1,$2,'/api/tree/talk',$3,$4::jsonb)", [randomUUID(), user.id, key, JSON.stringify(dialogue)]);
      return dialogue;
    });
  });
  app.get('/api/models', async () => ({ items: (await services.pool.query<ModelRow>('SELECT * FROM models WHERE enabled=true AND deleted_at IS NULL ORDER BY coins_per_call,id')).rows.map(row => publicModel(row)) }));
  app.get('/api/keys', async (request, reply) => {
    const user = await services.requireUser(request);
    reply.header('Cache-Control', 'no-store');
    return { items: (await services.pool.query('SELECT * FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC', [user.id])).rows.map(row => services.ownKey(row)) };
  });
  app.post('/api/keys', async (request, reply) => {
    const user = await services.requireUser(request); const name = text(record(request.body).name, '密钥名称', 64);
    reply.header('Cache-Control', 'no-store');
    const key = `sk_${randomToken()}`; const id = randomUUID();
    return transaction(services.pool, async db => {
      const locked = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (locked.status !== 'active') fail(401, 'unauthorized', '账号已停用。');
      if (Number((await db.query('SELECT count(*) AS count FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL', [user.id])).rows[0].count) >= 20) fail(409, 'key_limit', '最多保留 20 个有效 API Key。');
      const encrypted = encryptApiKey(key, services.config.apiKeyEncryptionKey, user.id, id);
      const row = (await db.query('INSERT INTO api_keys(id,user_id,name,prefix,key_hash,key_ciphertext) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [id, user.id, name, key.slice(0, 11), hash(key), encrypted])).rows[0];
      return { key, item: services.ownKey(row) };
    });
  });
  app.delete('/api/keys/:id', async request => {
    const user = await services.requireUser(request); const id = uuid((request.params as any).id);
    const result = await services.pool.query('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()),key_ciphertext=NULL WHERE id=$1 AND user_id=$2 RETURNING id', [id, user.id]);
    if (!result.rows.length) fail(404, 'not_found', 'API Key 不存在。');
    return { ok: true };
  });
  app.get('/api/usage', async request => {
    const user = await services.requireUser(request); const { pageSize, offset } = pagination(request.query);
    const rows = await services.pool.query('SELECT * FROM api_requests WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [user.id, pageSize, offset]);
    const total = Number((await services.pool.query('SELECT count(*) AS total FROM api_requests WHERE user_id=$1', [user.id])).rows[0].total);
    return { items: rows.rows.map(publicUsage), total };
  });
  app.get('/api/ledger', async request => {
    const user = await services.requireUser(request); const { pageSize, offset } = pagination(request.query);
    const rows = await services.pool.query('SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [user.id, pageSize, offset]);
    const total = Number((await services.pool.query('SELECT count(*) AS total FROM ledger WHERE user_id=$1', [user.id])).rows[0].total);
    return { items: rows.rows.map(publicLedger), total };
  });
}
