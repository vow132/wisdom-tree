import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Services } from './services.js';
import { transaction } from './db.js';
import { fail, idempotencyKey } from './security.js';
import type { UserRow, ModelRow } from './types.js';
import type { SimulatorServices, GenerationOptions, GenerationReceipt } from './simulator.js';

export function simulatorServices(services: Services): SimulatorServices {
  return {
    async models(request) {
      await services.authenticateApi(request);
      return (await services.pool.query<ModelRow>('SELECT * FROM models WHERE enabled=true AND deleted_at IS NULL ORDER BY coins_per_call,id')).rows.map(model => ({ id: model.id, displayName: model.display_name, coinsPerCall: model.coins_per_call }));
    },
    authenticate: request => services.authenticateApi(request),
    async accept(request: FastifyRequest, options: GenerationOptions): Promise<GenerationReceipt> {
      const auth = await services.authenticateApi(request);
      const key = idempotencyKey(request.headers['idempotency-key']);
      return transaction(services.pool, async db => {
        const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [auth.userId])).rows[0];
        if (!user || user.status !== 'active') fail(401, 'invalid_api_key', '用户或 API Key 已停用。');
        const activeKey = (await db.query('SELECT id FROM api_keys WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE', [auth.keyId, user.id])).rows[0];
        if (!activeKey) fail(401, 'invalid_api_key', 'API Key 已撤销。');
        if (key) {
          const existing = (await db.query('SELECT request_hash,result FROM api_requests WHERE user_id=$1 AND endpoint=$2 AND idem_key=$3', [user.id, options.endpoint, key])).rows[0];
          if (existing) {
            if (existing.request_hash !== options.requestHash) fail(409, 'idempotency_conflict', '此 Idempotency-Key 已用于不同请求。');
            await db.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [auth.keyId]);
            return existing.result as GenerationReceipt;
          }
        }
        const model = (await db.query<ModelRow>('SELECT * FROM models WHERE id=$1 AND enabled=true AND deleted_at IS NULL FOR SHARE', [options.modelId])).rows[0];
        if (!model) fail(404, 'model_not_found', '模型不存在或已停用。');
        const rules = await services.rules(db);
        const recent = Number((await db.query("SELECT count(*) AS count FROM api_requests WHERE user_id=$1 AND created_at > now() - interval '1 minute'", [user.id])).rows[0].count);
        if (recent >= rules.apiRateLimit) fail(429, 'rate_limit_exceeded', '请求过于频繁，请稍后再试。');
        if (Number(user.coins) < model.coins_per_call) fail(402, 'insufficient_balance', '金币不足，请先给智慧树施肥。');
        const dialogue = await services.selectModelReply(db, user.id, model, options.userInput);
        const requestId = randomUUID();
        const receipt: GenerationReceipt = {
          requestId, createdAt: Math.floor(Date.now() / 1000), modelId: model.id,
          replyText: dialogue.content, replyId: dialogue.replyId,
          ...(dialogue.ruleId ? { ruleId: dialogue.ruleId } : {}),
          replyIndex: dialogue.index, replyTotal: dialogue.total, streamChunkChars: model.stream_chunk_chars,
          streamDelayMs: model.stream_delay_ms, inputTokens: options.inputTokens,
        };
        await db.query('UPDATE users SET coins=coins-$2,updated_at=now() WHERE id=$1 AND coins >= $2', [user.id, model.coins_per_call]);
        await db.query('INSERT INTO api_requests(id,user_id,api_key_id,model_id,endpoint,request_hash,idem_key,coins_charged,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)', [requestId, user.id, auth.keyId, model.id, options.endpoint, options.requestHash, key, model.coins_per_call, JSON.stringify(receipt)]);
        await services.addLedger(db, user.id, 'api_call', -model.coins_per_call, 0, `${model.id} · 每次 ${model.coins_per_call} 金币`, `api:${requestId}`);
        await db.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [auth.keyId]);
        return receipt;
      });
    },
    async health() { await services.pool.query('SELECT 1'); return { status: 'ok', mode: 'simulator' }; },
    async onEnd(requestId, status) {
      await services.pool.query("UPDATE api_requests SET status=$2 WHERE id=$1 AND (status='accepted' OR $2='completed')", [requestId, status]);
    },
  };
}
