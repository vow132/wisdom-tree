import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { Services, SESSION_COOKIE } from './services.js';
import { fail, hash, randomToken, hashPassword, verifyPassword, record, username, password, text } from './security.js';
import type { UserRow } from './types.js';
import { oauthProvider, type OAuthProvider, type OAuthRuntime } from './oauth-settings.js';

const OAUTH_COOKIE = 'wisdom_oauth';
export async function registerAuth(app: FastifyInstance, services: Services) {
  const attempts = new Map<string, { count: number; until: number }>();
  const throttle = (request: FastifyRequest) => {
    const now = Date.now();
    if (attempts.size > 10000) for (const [key, item] of attempts) if (item.until < now) attempts.delete(key);
    let item = attempts.get(request.ip);
    if (!item || item.until < now) { item = { count: 0, until: now + 600000 }; attempts.set(request.ip, item); }
    if (++item.count > 20) fail(429, 'rate_limit_exceeded', '登录操作过于频繁，请稍后再试。');
  };
  app.post('/api/auth/register', async (request, reply) => {
    throttle(request);
    const body = record(request.body); const account = username(body.username);
    const pass = await hashPassword(password(body.password));
    const displayName = body.displayName === undefined ? account : text(body.displayName, '昵称', 64);
    const id = randomUUID();
    await transaction(services.pool, async db => {
      await db.query('INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)', [id, account, displayName, pass]);
      await db.query('INSERT INTO trees(user_id) VALUES($1)', [id]);
    });
    await services.startSession(id, reply);
    return services.state(id);
  });
  app.post('/api/auth/login', async (request, reply) => {
    throttle(request);
    const body = record(request.body); const account = username(body.username); const pass = password(body.password);
    const user = (await services.pool.query<UserRow>('SELECT * FROM users WHERE username=$1', [account])).rows[0];
    const correct = await verifyPassword(pass, user?.password_hash || null);
    if (!correct || !user || user.status !== 'active') fail(401, 'invalid_credentials', '账号或密码错误，或账号已停用。');
    if (request.cookies[SESSION_COOKIE]) await services.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(request.cookies[SESSION_COOKIE]!)]);
    await services.startSession(user.id, reply, user.password_hash!);
    return services.state(user.id);
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await services.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token)]);
    services.clearSession(reply);
    return services.state(null);
  });
  app.get('/api/auth/identities', async request => {
    const user = await services.requireUser(request);
    return { items: (await services.pool.query('SELECT provider,provider_user_id,display_name FROM identities WHERE user_id=$1 ORDER BY provider', [user.id])).rows.map(row => ({ provider: row.provider, providerUserId: row.provider_user_id, displayName: row.display_name })) };
  });
  app.delete('/api/auth/identities/:provider', async request => {
    const user = await services.requireUser(request); const provider = (request.params as any).provider;
    if (!['github', 'linuxdo'].includes(provider)) fail(404, 'not_found', '登录方式不存在。');
    await transaction(services.pool, async db => {
      const locked = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (locked.status !== 'active') fail(401, 'unauthorized', '账号已停用。');
      const identities = (await db.query('SELECT id,provider FROM identities WHERE user_id=$1', [user.id])).rows;
      if (!identities.some(row => row.provider === provider)) fail(404, 'not_found', '此登录方式尚未绑定。');
      if (!locked.password_hash && identities.length <= 1) fail(409, 'last_login_method', '请先设置另一种登录方式。');
      await db.query('DELETE FROM identities WHERE user_id=$1 AND provider=$2', [user.id, provider]);
    });
    return { ok: true };
  });

  app.get('/api/auth/:provider/start', async (request, reply) => {
    const provider = oauthProvider((request.params as any).provider);
    const bind = (request.query as any).bind === '1';
    const user = bind ? await services.requireUser(request) : null;
    const state = randomToken(); const verifier = randomToken();
    const settings = await transaction(services.pool, async db => {
      const current = await services.oauth.get(provider, db, true, false);
      if (!current.available) fail(503, 'provider_unavailable', '此登录方式未开启或尚未配置。');
      await db.query('INSERT INTO oauth_states(state_hash,provider,bind_user_id,session_hash,verifier,expires_at,config_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)', [hash(state), provider, user?.id || null, bind ? hash(request.cookies[SESSION_COOKIE]!) : null, verifier, new Date(Date.now() + 600000), current.fingerprint]);
      return current;
    });
    reply.setCookie(OAUTH_COOKIE, state, { path: '/api/auth', httpOnly: true, secure: services.config.secureCookies, sameSite: 'lax', maxAge: 600 });
    const params = new URLSearchParams({ client_id: settings.clientId, redirect_uri: `${services.config.publicOrigin}/api/auth/${provider}/callback`, response_type: 'code', scope: provider === 'github' ? 'read:user' : 'user', state });
    if (provider === 'github') { params.set('code_challenge', Buffer.from(hash(verifier), 'hex').toString('base64url')); params.set('code_challenge_method', 'S256'); }
    return reply.redirect(`${settings.authorizeUrl}?${params}`);
  });
  app.get('/api/auth/:provider/callback', async (request, reply) => {
    const provider = oauthProvider((request.params as any).provider);
    const settings = await services.oauth.get(provider);
    if (!settings.available) fail(503, 'provider_unavailable', '此登录方式未开启或尚未配置。');
    const query = request.query as any;
    const state = typeof query.state === 'string' ? query.state : '';
    if (!state || state.length > 128 || request.cookies[OAUTH_COOKIE] !== state) fail(400, 'invalid_oauth_state', '登录验证已过期，请重新登录。');
    const flow = (await services.pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING *', [hash(state), provider])).rows[0];
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth', httpOnly: true, secure: services.config.secureCookies, sameSite: 'lax' });
    if (!flow) fail(400, 'invalid_oauth_state', '登录验证已过期，请重新登录。');
    if (flow.config_fingerprint !== settings.fingerprint) fail(400, 'invalid_oauth_state', '登录配置已改变，请重新登录。');
    if (query.error || typeof query.code !== 'string' || !query.code || query.code.length > 512) fail(400, 'oauth_denied', '第三方登录未完成。');
    if (flow.bind_user_id) {
      const current = await services.sessionUser(request);
      if (!current || current.id !== flow.bind_user_id || flow.session_hash !== hash(request.cookies[SESSION_COOKIE] || '')) fail(401, 'binding_session_changed', '绑定期间登录状态已改变，请重新绑定。');
    }
    const identity = await fetchIdentity(settings, provider, query.code, flow.verifier);
    const userId = await transaction(services.pool, async db => {
      // Network I/O has finished. A shared provider lock serializes identity
      // acceptance with administrator changes without holding locks during fetch.
      await services.oauth.assertFlow(db, provider, flow.config_fingerprint);
      const found = (await db.query('SELECT i.*,u.status FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.provider_user_id=$2', [provider, identity.id])).rows[0];
      if (flow.bind_user_id) {
        const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [flow.bind_user_id])).rows[0];
        if (!current || current.status !== 'active' || !(await db.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()', [flow.session_hash, current.id])).rows.length) fail(401, 'unauthorized', '登录状态已失效。');
        if (found && found.user_id !== current.id) fail(409, 'identity_already_bound', '该第三方账号已绑定其他用户。');
        const existing = (await db.query('SELECT provider_user_id FROM identities WHERE user_id=$1 AND provider=$2', [current.id, provider])).rows[0];
        if (existing && existing.provider_user_id !== identity.id) fail(409, 'provider_already_bound', '请先解除当前绑定，再绑定新账号。');
        if (!found) await db.query('INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), current.id, provider, identity.id, identity.name]);
        return current.id;
      }
      if (found) {
        if (found.status !== 'active') fail(403, 'account_disabled', '账号已停用。');
        await db.query('UPDATE identities SET display_name=$3 WHERE provider=$1 AND provider_user_id=$2', [provider, identity.id, identity.name]);
        return found.user_id;
      }
      const id = randomUUID();
      const account = `${provider}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await db.query('INSERT INTO users(id,username,display_name) VALUES($1,$2,$3)', [id, account, identity.name]);
      await db.query('INSERT INTO trees(user_id) VALUES($1)', [id]);
      await db.query('INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), id, provider, identity.id, identity.name]);
      return id;
    });
    if (!flow.bind_user_id) {
      const old = request.cookies[SESSION_COOKIE];
      if (old) await services.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(old)]);
      await services.startSession(userId, reply);
    }
    return reply.redirect(flow.bind_user_id ? '/account?bound=1' : '/?login=success');
  });
}

async function fetchIdentity(c: OAuthRuntime, provider: OAuthProvider, code: string, verifier: string): Promise<{ id: string; name: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.callbackUrl });
  if (provider === 'github') body.set('code_verifier', verifier);
  try {
    const tokenResponse = await fetch(c.tokenUrl, { method: 'POST', body, headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000) });
    const token = await tokenResponse.json() as any;
    if (!tokenResponse.ok || typeof token.access_token !== 'string') fail(502, 'oauth_provider_error', '第三方登录暂时不可用，请稍后再试。');
    const userResponse = await fetch(c.userUrl, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'WisdomTree/1.0' }, signal: AbortSignal.timeout(10000) });
    const identity = await userResponse.json() as any;
    if (!userResponse.ok || !['string', 'number'].includes(typeof identity.id) || !String(identity.id) || String(identity.id).length > 128) fail(502, 'oauth_provider_error', '第三方身份验证失败。');
    if (provider === 'linuxdo' && identity.active === false) fail(403, 'provider_account_inactive', '第三方账号未激活。');
    return { id: String(identity.id), name: String(identity.name || identity.login || identity.username || `${provider} 用户`).trim().slice(0, 64) || `${provider} 用户` };
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    fail(502, 'oauth_provider_error', '第三方登录暂时不可用，请稍后再试。');
  }
}
