import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { Services, SESSION_COOKIE, publicIdentity } from './services.js';
import { AppError, fail, hash, randomToken, hashPassword, verifyPassword, record, username, password, text } from './security.js';
import type { UserRow } from './types.js';
import { oauthProvider, type OAuthProvider, type OAuthRuntime } from './oauth-settings.js';

const OAUTH_COOKIE = 'wisdom_oauth';
type OAuthStage = 'provider' | 'settings' | 'state_parameter' | 'state_cookie_missing' | 'state_cookie_mismatch' | 'state_lookup' | 'state_expired' | 'state_missing_or_used' | 'state_config_changed' | 'authorization' | 'binding_session' | 'token_exchange' | 'user_info' | 'accept_settings' | 'accept_identity' | 'session' | 'redirect';
export async function registerAuth(app: FastifyInstance, services: Services) {
  const oauthMessages: Record<string, string> = {
    invalid_oauth_state: '登录验证已过期，请重新登录。如反复失败，请检查第三方应用的回调地址。',
    oauth_denied: '第三方授权未完成，请重新登录。',
    oauth_provider_error: '第三方身份验证失败，请检查登录凭证和第三方应用的回调地址后重试。',
    provider_unavailable: '此第三方登录未开启或尚未配置，请联系管理员。',
    oauth_secret_decryption_failed: '第三方登录配置无法读取，请联系管理员。',
    provider_account_inactive: '第三方账号尚未激活。',
    account_disabled: '本站账号已停用，请联系管理员。',
    identity_already_bound: '该第三方账号已绑定其他用户。',
    provider_already_bound: '请先解除当前绑定，再绑定新账号。',
    identity_changed: '第三方绑定已改变，请重新登录。',
    binding_session_changed: '绑定期间登录状态已改变，请重新登录后绑定。',
    unauthorized: '登录状态已失效，请重新登录。',
    invalid_credentials: '登录验证已改变，请重新登录。',
  };
  const stateMessages: Partial<Record<OAuthStage, string>> = {
    state_parameter: '第三方返回缺少有效的登录验证参数，请重新登录；管理员需确认完整回调地址。',
    state_cookie_missing: '本站未收到登录验证 Cookie。请在同一浏览器中打开本站并重新发起第三方登录，避免从应用内浏览器跳到另一浏览器；Cookie 过期或被阻止时也会出现此问题。',
    state_cookie_mismatch: '本次登录验证与浏览器中的记录不一致。请关闭其他授权窗口，在同一浏览器重新发起第三方登录。',
    state_expired: '登录验证已超过 10 分钟，请在同一浏览器中重新发起第三方登录。',
    state_missing_or_used: '本次登录验证已使用或失效，请在同一浏览器中重新发起第三方登录。',
    state_config_changed: '第三方登录配置已改变，请重新发起第三方登录。',
  };
  function oauthFailure(request: FastifyRequest, reply: FastifyReply, error: unknown, stage?: OAuthStage) {
    const message = error instanceof AppError ? error.code === 'invalid_oauth_state' && stage && stateMessages[stage] || oauthMessages[error.code] : undefined;
    if (request.headers['sec-fetch-mode'] === 'navigate' && message) {
      return reply.redirect(`${services.config.publicOrigin}/?${new URLSearchParams({ error: message })}`);
    }
    throw error;
  }
  function callbackFailure(provider: OAuthProvider | null, stage: OAuthStage, error: unknown) {
    const code = error instanceof AppError && Object.hasOwn(oauthMessages, error.code) ? error.code : 'internal_error';
    // Fixed fields and controlled values only: never request URLs, state/code,
    // cookies, profile information, Client IDs, credentials or raw exceptions.
    console.error('oauth.callback.failed', JSON.stringify({ provider: provider || 'unknown', stage, code }));
  }
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
    return { items: (await services.pool.query('SELECT provider,provider_user_id,display_name,created_at FROM identities WHERE user_id=$1 ORDER BY provider', [user.id])).rows.map(publicIdentity) };
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
    // OAuth callbacks have a fixed origin. Establish the state cookie there
    // first when a browser enters through an alias such as localhost/127.0.0.1.
    if (new URL(`${request.protocol}://${request.host}`).origin !== services.config.publicOrigin) {
      const current = await services.oauth.get(provider, services.pool, false, false);
      if (!current.available) fail(503, 'provider_unavailable', '此登录方式未开启或尚未配置。');
      return reply.redirect(`${services.config.publicOrigin}/api/auth/${provider}/start${bind ? '?bind=1' : ''}`);
    }
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
  app.get('/api/auth/oauth-landing', async (request, reply) => {
    try {
      const query = request.query as Record<string, unknown>;
      const state = typeof query.state === 'string' ? query.state : '';
      if (!state || state.length > 128 || request.cookies[OAUTH_COOKIE] !== state) fail(400, 'invalid_oauth_state', '登录验证已过期，请重新登录。');
      const flow = (await services.pool.query('SELECT provider FROM oauth_states WHERE state_hash=$1 AND expires_at>now()', [hash(state)])).rows[0];
      if (!flow) fail(400, 'invalid_oauth_state', '登录验证已过期，请重新登录。');
      const provider = oauthProvider(flow.provider);
      const params = new URLSearchParams({ state });
      if (typeof query.error === 'string' && query.error.length <= 128) params.set('error', query.error);
      else if (typeof query.code === 'string' && query.code && query.code.length <= 512) params.set('code', query.code);
      else fail(400, 'oauth_denied', '第三方登录未完成。');
      // Compatibility for an application whose registered return URL is the
      // homepage. Only the server's unconsumed, cookie-bound state selects a
      // provider; all identity/session validation still runs in its callback.
      return reply.redirect(`${services.config.publicOrigin}/api/auth/${provider}/callback?${params}`);
    } catch (error) { return oauthFailure(request, reply, error); }
  });
  app.get('/api/auth/:provider/callback', async (request, reply) => {
    let provider: OAuthProvider | null = null;
    let stage: OAuthStage = 'provider';
    try {
      provider = oauthProvider((request.params as any).provider);
      stage = 'settings';
      const settings = await services.oauth.get(provider);
      if (!settings.available) fail(503, 'provider_unavailable', '此登录方式未开启或尚未配置。');
      const query = request.query as any;
      const state = typeof query.state === 'string' ? query.state : '';
      stage = 'state_parameter';
      if (!state || state.length > 128) fail(400, 'invalid_oauth_state', '第三方返回缺少有效的登录验证参数。');
      stage = 'state_cookie_missing';
      if (!request.cookies[OAUTH_COOKIE]) fail(400, 'invalid_oauth_state', '本站未收到登录验证 Cookie，请在同一浏览器重新发起登录。');
      stage = 'state_cookie_mismatch';
      if (request.cookies[OAUTH_COOKIE] !== state) fail(400, 'invalid_oauth_state', '登录验证不匹配，请在同一浏览器重新发起登录。');
      stage = 'state_lookup';
      const flow = (await services.pool.query('DELETE FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING *', [hash(state), provider])).rows[0];
      reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth', httpOnly: true, secure: services.config.secureCookies, sameSite: 'lax' });
      if (!flow) {
        const remaining = (await services.pool.query('SELECT expires_at<=now() AS expired FROM oauth_states WHERE state_hash=$1 AND provider=$2', [hash(state), provider])).rows[0];
        stage = remaining?.expired ? 'state_expired' : 'state_missing_or_used';
        fail(400, 'invalid_oauth_state', remaining?.expired ? '登录验证已过期，请重新登录。' : '登录验证已使用或失效，请重新登录。');
      }
      stage = 'state_config_changed';
      if (flow.config_fingerprint !== settings.fingerprint) fail(400, 'invalid_oauth_state', '登录配置已改变，请重新登录。');
      stage = 'authorization';
      if (query.error || typeof query.code !== 'string' || !query.code || query.code.length > 512) fail(400, 'oauth_denied', '第三方登录未完成。');
      if (flow.bind_user_id) {
        stage = 'binding_session';
        const current = await services.sessionUser(request);
        if (!current || current.id !== flow.bind_user_id || flow.session_hash !== hash(request.cookies[SESSION_COOKIE] || '')) fail(401, 'binding_session_changed', '绑定期间登录状态已改变，请重新绑定。');
      }
      const acceptedProvider = provider;
      const identity = await fetchIdentity(settings, acceptedProvider, query.code, flow.verifier, next => { stage = next; });
      const userId = await transaction(services.pool, async db => {
        // Network I/O has finished. A shared provider lock serializes identity
        // acceptance with administrator changes without holding locks during fetch.
        stage = 'accept_settings';
        await services.oauth.assertFlow(db, acceptedProvider, flow.config_fingerprint);
        stage = 'accept_identity';
        const found = (await db.query('SELECT i.*,u.status FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.provider_user_id=$2', [acceptedProvider, identity.id])).rows[0];
        if (flow.bind_user_id) {
          const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [flow.bind_user_id])).rows[0];
          if (!current || current.status !== 'active' || !(await db.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()', [flow.session_hash, current.id])).rows.length) fail(401, 'unauthorized', '登录状态已失效。');
          if (found && found.user_id !== current.id) fail(409, 'identity_already_bound', '该第三方账号已绑定其他用户。');
          const existing = (await db.query('SELECT provider_user_id FROM identities WHERE user_id=$1 AND provider=$2', [current.id, provider])).rows[0];
          if (existing && existing.provider_user_id !== identity.id) fail(409, 'provider_already_bound', '请先解除当前绑定，再绑定新账号。');
          if (!found) await db.query('INSERT INTO identities(id,user_id,provider,provider_user_id,display_name) VALUES($1,$2,$3,$4,$5)', [randomUUID(), current.id, provider, identity.id, identity.name]);
          else await db.query('UPDATE identities SET display_name=$3 WHERE provider=$1 AND provider_user_id=$2', [provider, identity.id, identity.name]);
          return current.id;
        }
        if (found) {
          const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [found.user_id])).rows[0];
          if (!current || current.status !== 'active') fail(403, 'account_disabled', '账号已停用。');
          // Unbinding also locks the account. Recheck after acquiring that lock so
          // a removed identity cannot sign in through an earlier lookup.
          if (!(await db.query('SELECT id FROM identities WHERE user_id=$1 AND provider=$2 AND provider_user_id=$3', [current.id, provider, identity.id])).rows.length) fail(409, 'identity_changed', '第三方绑定已改变，请重新登录。');
          await db.query('UPDATE identities SET display_name=$3 WHERE provider=$1 AND provider_user_id=$2', [provider, identity.id, identity.name]);
          await db.query('UPDATE users SET display_name=$2,updated_at=now() WHERE id=$1', [current.id, identity.name]);
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
        stage = 'session';
        const old = request.cookies[SESSION_COOKIE];
        if (old) await services.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(old)]);
        await services.startSession(userId, reply);
      }
      stage = 'redirect';
      console.info('oauth.callback.completed', JSON.stringify({ provider: acceptedProvider, stage, code: 'success' }));
      return reply.redirect(`${services.config.publicOrigin}${flow.bind_user_id ? '/account?bound=1' : '/?login=success'}`);
    } catch (error) {
      callbackFailure(provider, stage, error);
      return oauthFailure(request, reply, error, stage);
    }
  });
}

async function fetchIdentity(c: OAuthRuntime, provider: OAuthProvider, code: string, verifier: string, phase: (stage: 'token_exchange' | 'user_info') => void): Promise<{ id: string; name: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.callbackUrl });
  if (provider === 'github') body.set('code_verifier', verifier);
  try {
    phase('token_exchange');
    const tokenResponse = await fetch(c.tokenUrl, { method: 'POST', body, headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000) });
    const token = await tokenResponse.json() as any;
    if (!tokenResponse.ok || typeof token.access_token !== 'string') fail(502, 'oauth_provider_error', '第三方登录暂时不可用，请稍后再试。');
    phase('user_info');
    const userResponse = await fetch(c.userUrl, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'WisdomTree/1.0' }, signal: AbortSignal.timeout(10000) });
    const identity = await userResponse.json() as any;
    if (!userResponse.ok || !['string', 'number'].includes(typeof identity.id) || !String(identity.id) || String(identity.id).length > 128) fail(502, 'oauth_provider_error', '第三方身份验证失败。');
    if (provider === 'linuxdo' && identity.active === false) fail(403, 'provider_account_inactive', '第三方账号未激活。');
    const name = [identity.name, identity.login, identity.username].find(value => typeof value === 'string' && value.trim());
    return { id: String(identity.id), name: typeof name === 'string' ? name.trim().slice(0, 64) : `${provider} 用户` };
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    fail(502, 'oauth_provider_error', '第三方登录暂时不可用，请稍后再试。');
  }
}
