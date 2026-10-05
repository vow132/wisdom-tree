import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from './config.js';
import type { PoolLike, Queryable, UserRow, Rules, ModelRow, ModelReplyRow, ModelReplyRuleRow, ModelDialogue } from './types.js';
import { fail, hash, randomToken, dateShanghai, decryptApiKey } from './security.js';
import { transaction } from './db.js';
import { OAuthSettings } from './oauth-settings.js';

export const SESSION_COOKIE = 'wisdom_session';
export function publicUser(user: UserRow) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, status: user.status, coins: Number(user.coins), fertilizer: user.fertilizer };
}
export function publicTree(row: any) {
  return row ? { seedClaimed: row.seed_claimed, planted: row.planted, height: Number(row.height) } : null;
}
export function publicKey(row: any) {
  return { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}
export function publicIdentity(row: any) {
  return { provider: row.provider, providerUserId: row.provider_user_id, displayName: row.display_name, createdAt: row.created_at };
}
export function publicModel(row: ModelRow, admin = false) {
  const common = { id: row.id, displayName: row.display_name, coinsPerCall: row.coins_per_call, enabled: row.enabled, isWisdomTree: row.is_wisdom_tree === true };
  return admin ? { ...common, replyText: row.reply_text, streamChunkChars: row.stream_chunk_chars, streamDelayMs: row.stream_delay_ms, replyCount: Number(row.reply_count ?? 0), ruleCount: Number(row.rule_count ?? 0) } : common;
}
export function publicModelReply(row: ModelReplyRow) {
  return { id: row.id, position: row.position, text: row.text };
}
export function publicModelReplyRule(row: ModelReplyRuleRow) {
  return { id: row.id, position: row.position, input: row.input, text: row.text, enabled: row.enabled };
}
export function publicUsage(row: any) {
  return { id: row.id, modelId: row.model_id, coinsCharged: Number(row.coins_charged), createdAt: row.created_at, endpoint: row.endpoint, status: row.status, ...(row.username ? { username: row.username, userId: row.user_id } : {}) };
}
export function publicLedger(row: any) {
  return { id: row.id, kind: row.kind, coinsDelta: Number(row.coins_delta), fertilizerDelta: row.fertilizer_delta, reason: row.reason, createdAt: row.created_at };
}

export class Services {
  public oauth: OAuthSettings;
  constructor(public pool: PoolLike, public config: AppConfig) { this.oauth = new OAuthSettings(pool, config); }
  // Callers hold the user's row lock and a shared model lock in the same transaction.
  // This also makes API acceptance and free garden dialogue share one atomic sequence.
  async selectModelReply(db: Queryable, userId: string, model: ModelRow, input?: string): Promise<ModelDialogue> {
    if (input !== undefined) {
      const rule = (await db.query<ModelReplyRuleRow>('SELECT * FROM model_reply_rules WHERE model_id=$1 AND enabled=true AND input=$2 ORDER BY position,id LIMIT 1', [model.id, input.trim()])).rows[0];
      if (rule) return { modelId: model.id, modelDisplayName: model.display_name, replyId: null, ruleId: rule.id, content: rule.text, index: 0, total: 0, fallback: false };
    }
    const replies = (await db.query<ModelReplyRow>('SELECT * FROM model_replies WHERE model_id=$1 ORDER BY position,id', [model.id])).rows;
    if (!replies.length) return { modelId: model.id, modelDisplayName: model.display_name, replyId: null, content: model.reply_text, index: 0, total: 0, fallback: true };
    const previous = (await db.query('SELECT last_reply_id FROM model_reply_cursors WHERE user_id=$1 AND model_id=$2', [userId, model.id])).rows[0];
    const index = (replies.findIndex(row => row.id === previous?.last_reply_id) + 1) % replies.length;
    const selected = replies[index];
    await db.query('INSERT INTO model_reply_cursors(user_id,model_id,last_reply_id) VALUES($1,$2,$3) ON CONFLICT(user_id,model_id) DO UPDATE SET last_reply_id=EXCLUDED.last_reply_id,updated_at=now()', [userId, model.id, selected.id]);
    return { modelId: model.id, modelDisplayName: model.display_name, replyId: selected.id, content: selected.text, index: index + 1, total: replies.length, fallback: false };
  }
  async treeDialogue(db: Queryable, userId: string): Promise<ModelDialogue | null> {
    const model = (await db.query<ModelRow>('SELECT * FROM models WHERE is_wisdom_tree=true AND enabled=true AND deleted_at IS NULL FOR SHARE')).rows[0];
    return model ? this.selectModelReply(db, userId, model) : null;
  }
  ownKey(row: any) {
    const key = !row.revoked_at && row.key_ciphertext ? decryptApiKey(row.key_ciphertext, this.config.apiKeyEncryptionKey, row.user_id, row.id) : null;
    return { ...publicKey(row), key, recoverable: key !== null };
  }
  providers(db: Queryable = this.pool) { return this.oauth.providers(db); }
  async rules(db: Queryable = this.pool): Promise<Rules> {
    return (await db.query('SELECT rules FROM settings WHERE id = true')).rows[0].rules;
  }
  async sessionUser(request: FastifyRequest, db: Queryable = this.pool): Promise<UserRow | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 128) return null;
    const result = await db.query<UserRow>('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = \'active\'', [hash(token)]);
    return result.rows[0] || null;
  }
  async requireUser(request: FastifyRequest): Promise<UserRow> {
    return (await this.sessionUser(request)) || fail(401, 'unauthorized', '请先登录。');
  }
  async requireAdmin(request: FastifyRequest): Promise<UserRow> {
    const user = await this.requireUser(request);
    if (user.role !== 'admin') fail(403, 'forbidden', '此操作需要管理员权限。');
    return user;
  }
  async state(userId: string | null, db: Queryable = this.pool) {
    const rules = await this.rules(db);
    const providers = await this.providers(db);
    if (!userId) return { user: null, tree: null, daily: null, rules, providers };
    const user = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!user || user.status !== 'active') return { user: null, tree: null, daily: null, rules, providers };
    const tree = (await db.query('SELECT * FROM trees WHERE user_id = $1', [userId])).rows[0];
    const date = dateShanghai();
    const claimed = Number((await db.query('SELECT amount FROM daily_claims WHERE user_id = $1 AND claim_date = $2', [userId, date])).rows[0]?.amount || 0);
    return {
      user: publicUser(user), tree: publicTree(tree), rules,
      daily: { date, claimed, remaining: Math.max(0, rules.dailyFertilizer - claimed) },
      providers,
    };
  }
  async startSession(userId: string, reply: FastifyReply, expectedPasswordHash?: string): Promise<void> {
    const token = randomToken();
    await transaction(this.pool, async db => {
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user || user.status !== 'active' || (expectedPasswordHash !== undefined && expectedPasswordHash !== user.password_hash)) fail(401, 'invalid_credentials', '登录验证已改变，请重新登录。');
      await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash(token), userId, new Date(Date.now() + this.config.sessionDays * 86400000)]);
    });
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', maxAge: this.config.sessionDays * 86400 });
  }
  clearSession(reply: FastifyReply) { reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax' }); }
  async authenticateApi(request: FastifyRequest): Promise<{ userId: string; keyId: string }> {
    const authorization = request.headers.authorization;
    const token = authorization ? (/^Bearer ([^\s]+)$/i.exec(authorization)?.[1] || '') : request.headers['x-api-key'];
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) fail(401, 'invalid_api_key', 'API Key 无效或已撤销。');
    const row = (await this.pool.query('SELECT k.id,k.user_id FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND u.status=\'active\'', [hash(token)])).rows[0];
    if (!row) fail(401, 'invalid_api_key', 'API Key 无效或已撤销。');
    return { userId: row.user_id, keyId: row.id };
  }
  async addLedger(db: Queryable, userId: string, kind: string, coins: number, fertilizer: number, reason: string, referenceId?: string) {
    await db.query('INSERT INTO ledger(id,user_id,kind,coins_delta,fertilizer_delta,reason,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), userId, kind, coins, fertilizer, reason, referenceId || null]);
  }
  async audit(db: Queryable, actor: UserRow, action: string, targetId: string, reason: string, before: any, after: any) {
    await db.query('INSERT INTO audit(id,actor_id,actor_name,action,target_id,reason,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [randomUUID(), actor.id, actor.username, action, targetId, reason, JSON.stringify(before ?? null), JSON.stringify(after ?? null)]);
  }
}
