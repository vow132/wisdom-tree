import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'jsdom';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';

const origin = 'https://tree.example.test';
const password = 'Disposable-browser-oauth-password-2026';

test('OAuth browser cookies, homepage returns, names and administrator identity metadata', { timeout: 60000 }, async t => {
  const dir = join(tmpdir(), 'wisdom-oauth-session-' + randomUUID());
  await mkdir(dir, { recursive: true });
  process.env.DATABASE_MODE = 'embedded'; process.env.PGLITE_PATH = dir; process.env.TRUST_PROXY = 'true';
  const pool = await getPool(); await runMigrations(pool);
  const profileNames = new Map<string, string>();
  const exchanges: { provider: string; redirectUri: string }[] = [];
  const provider = createServer(async (request, response) => {
    const name = request.url?.split('/')[1];
    if (request.url?.endsWith('/token')) {
      let body = ''; for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      exchanges.push({ provider: name!, redirectUri: params.get('redirect_uri')! });
      if (params.get('code') === 'bad-provider') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant', error_description: 'raw-provider-secret-or-code' })); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: name + ':' + params.get('code') }));
    } else if (request.url?.endsWith('/user')) {
      const code = String(request.headers.authorization).split(':').at(-1)!;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: code, name: profileNames.get(code) ?? '论坛昵称', username: 'forum_username', active: true, api_key: 'discarded-provider-key' }));
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerOrigin = 'http://127.0.0.1:' + (provider.address() as { port: number }).port;
  const app = await buildApp({ pool, config: {
    publicOrigin: origin, development: false, secureCookies: true, apiKeyEncryptionKey: randomBytes(32).toString('hex'),
    githubClientId: 'fixture-github-client', githubClientSecret: 'fixture-github-secret',
    linuxdoClientId: 'fixture-linuxdo-client', linuxdoClientSecret: 'fixture-linuxdo-secret',
    githubAuthorizeUrl: providerOrigin + '/github/authorize', githubTokenUrl: providerOrigin + '/github/token', githubUserUrl: providerOrigin + '/github/user',
    linuxdoAuthorizeUrl: providerOrigin + '/linuxdo/authorize', linuxdoTokenUrl: providerOrigin + '/linuxdo/token', linuxdoUserUrl: providerOrigin + '/linuxdo/user',
  } });
  const stderr = t.mock.method(console, 'error', () => {});
  const stdout = t.mock.method(console, 'info', () => {});
  const admin = new CookieJar(), local = new CookieJar(), linuxdo = new CookieJar(), github = new CookieJar();
  async function request(jar: CookieJar | null, method: string, path: string, body?: unknown, browserNavigation = false, requestOrigin = origin) {
    const url = new URL(path, requestOrigin);
    const headers: Record<string, string> = { host: url.host, 'x-forwarded-proto': url.protocol.slice(0, -1) };
    if (jar) headers.cookie = jar.getCookieStringSync(url.href, { sameSiteContext: browserNavigation ? 'lax' : 'strict' });
    if (!['GET', 'HEAD'].includes(method)) headers.origin = origin;
    if (browserNavigation) headers['sec-fetch-mode'] = 'navigate';
    const res = await app.inject({ method: method as any, url: url.pathname + url.search, headers, payload: body as any });
    const setCookies = res.headers['set-cookie'];
    if (jar && setCookies) for (const cookie of Array.isArray(setCookies) ? setCookies : [setCookies]) jar.setCookieSync(cookie, url.href);
    return res;
  }
  async function ok(jar: CookieJar | null, method: string, path: string, body?: unknown) {
    const res = await request(jar, method, path, body);
    assert.equal(res.statusCode, 200, `${path}: ${res.body}`); return res.json();
  }
  async function start(jar: CookieJar, name: string, bind = false) {
    const res = await request(jar, 'GET', `/api/auth/${name}/start${bind ? '?bind=1' : ''}`, undefined, true);
    assert.equal(res.statusCode, 302); return new URL(String(res.headers.location)).searchParams.get('state')!;
  }
  async function callback(jar: CookieJar, name: string, state: string, code: string, navigation = true) {
    return request(jar, 'GET', `/api/auth/${name}/callback?${new URLSearchParams({ state, code })}`, undefined, navigation);
  }
  let linuxdoId = '', localId = '';
  try {
    await createAdmin(pool, 'browser_oauth_admin', password);
    await ok(admin, 'POST', '/api/auth/login', { username: 'browser_oauth_admin', password });
    localId = (await ok(local, 'POST', '/api/auth/register', { username: 'browser_oauth_local', displayName: '本地名字', password })).user.id;
    await t.test('alias origins redirect before creating a cookie or OAuth state', async () => {
      const jar = new CookieJar();
      const before = (await pool.query('SELECT count(*) AS n FROM oauth_states')).rows[0].n;
      const res = await request(jar, 'GET', '/api/auth/linuxdo/start', undefined, true, 'https://alias.example.test');
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, origin + '/api/auth/linuxdo/start');
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal((await pool.query('SELECT count(*) AS n FROM oauth_states')).rows[0].n, before);
    });
    await t.test('Linux DO top-level cross-site return establishes a secure session for the first me request', async () => {
      profileNames.set('new-linuxdo', 'Linux DO 昵称');
      const state = await start(linuxdo, 'linuxdo');
      assert.equal(linuxdo.getCookieStringSync(origin + '/').includes('wisdom_oauth'), false, 'state cookie is scoped to the auth path');
      assert.ok(linuxdo.getCookieStringSync(origin + '/api/auth/linuxdo/callback', { sameSiteContext: 'lax' }).includes('wisdom_oauth='));
      const res = await callback(linuxdo, 'linuxdo', state, 'new-linuxdo');
      assert.equal(res.statusCode, 302); assert.equal(res.headers.location, origin + '/?login=success');
      const cookie = linuxdo.getCookiesSync(origin + '/').find(item => item.key === 'wisdom_session')!;
      assert.ok(cookie); assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'lax'); assert.equal(cookie.path, '/');
      assert.equal(linuxdo.getCookieStringSync(origin + '/api/auth/linuxdo/callback').includes('wisdom_oauth'), false, 'callback clears only the one-time state cookie');
      const stateAfter = await ok(linuxdo, 'GET', '/api/me'); linuxdoId = stateAfter.user.id;
      assert.equal(stateAfter.user.displayName, 'Linux DO 昵称'); assert.ok(stateAfter.user.username.startsWith('linuxdo_'));
      assert.deepEqual(exchanges.at(-1), { provider: 'linuxdo', redirectUri: origin + '/api/auth/linuxdo/callback' });
    });
    await t.test('repeated login uses the existing account and its current third-party nickname', async () => {
      await ok(linuxdo, 'POST', '/api/auth/logout'); profileNames.set('new-linuxdo', '更新的论坛昵称');
      assert.equal((await callback(linuxdo, 'linuxdo', await start(linuxdo, 'linuxdo'), 'new-linuxdo')).statusCode, 302);
      const state = await ok(linuxdo, 'GET', '/api/me'); assert.equal(state.user.id, linuxdoId); assert.equal(state.user.displayName, '更新的论坛昵称');
      assert.equal((await ok(linuxdo, 'GET', '/api/auth/identities')).items[0].displayName, '更新的论坛昵称');
    });
    await t.test('a bound local account switches to the provider nickname when it later signs in with that provider', async () => {
      profileNames.set('bound-linuxdo', '绑定的论坛昵称');
      const binding = await callback(local, 'linuxdo', await start(local, 'linuxdo', true), 'bound-linuxdo');
      assert.equal(binding.headers.location, origin + '/account?bound=1'); assert.equal((await ok(local, 'GET', '/api/me')).user.displayName, '本地名字');
      await ok(local, 'POST', '/api/auth/logout');
      assert.equal((await callback(local, 'linuxdo', await start(local, 'linuxdo'), 'bound-linuxdo')).statusCode, 302);
      const current = await ok(local, 'GET', '/api/me'); assert.equal(current.user.id, localId); assert.equal(current.user.displayName, '绑定的论坛昵称');
    });
    await t.test('a homepage return safely resumes its cookie-bound provider flow once', async () => {
      const jar = new CookieJar(), state = await start(jar, 'linuxdo');
      const landing = await request(jar, 'GET', '/api/auth/oauth-landing?' + new URLSearchParams({ code: 'homepage-return', state, provider: 'github' }), undefined, true);
      assert.equal(landing.statusCode, 302);
      const target = new URL(String(landing.headers.location)); assert.equal(target.origin, origin); assert.equal(target.pathname, '/api/auth/linuxdo/callback', 'untrusted query provider is ignored');
      assert.equal((await request(jar, 'GET', target.pathname + target.search, undefined, true)).statusCode, 302);
      assert.ok((await ok(jar, 'GET', '/api/me')).user.id);
      const replay = await request(jar, 'GET', target.pathname + target.search);
      assert.equal(replay.statusCode, 400); assert.equal(replay.json().error.code, 'invalid_oauth_state');
      const missingCookie = await request(new CookieJar(), 'GET', '/api/auth/oauth-landing?' + new URLSearchParams({ code: 'unused-code', state }));
      assert.equal(missingCookie.statusCode, 400);
    });
    await t.test('GitHub remains compatible and blank provider names fall back to the actual provider username', async () => {
      profileNames.set('github-nameless', '   ');
      assert.equal((await callback(github, 'github', await start(github, 'github'), 'github-nameless')).statusCode, 302);
      assert.equal((await ok(github, 'GET', '/api/me')).user.displayName, 'forum_username');
    });
    await t.test('admin listing and details expose bounded identity metadata without tokens or password data', async () => {
      assert.equal((await request(null, 'GET', '/api/admin/users')).statusCode, 401);
      assert.equal((await request(linuxdo, 'GET', '/api/admin/users')).statusCode, 403);
      assert.equal((await request(null, 'GET', '/api/admin/users/' + linuxdoId)).statusCode, 401);
      assert.equal((await request(linuxdo, 'GET', '/api/admin/users/' + linuxdoId)).statusCode, 403);
      const listing = await ok(admin, 'GET', '/api/admin/users?search=linuxdo_');
      const selected = listing.items.find((item: any) => item.id === linuxdoId); assert.ok(selected);
      const detail = await ok(admin, 'GET', '/api/admin/users/' + linuxdoId);
      assert.deepEqual(selected.identities, detail.identities); assert.equal(detail.identities.length, 1);
      const identity = detail.identities[0];
      assert.deepEqual(Object.keys(identity).sort(), ['createdAt', 'displayName', 'provider', 'providerUserId']);
      assert.equal(identity.provider, 'linuxdo'); assert.equal(identity.providerUserId, 'new-linuxdo'); assert.equal(identity.displayName, '更新的论坛昵称'); assert.ok(Number.isFinite(Date.parse(identity.createdAt)));
      const response = JSON.stringify({ listing, detail });
      for (const forbidden of ['discarded-provider-key', 'fixture-linuxdo-secret', 'password_hash', 'token_hash', 'client_secret']) assert.equal(response.includes(forbidden), false);
      const localListing = await ok(admin, 'GET', '/api/admin/users?search=browser_oauth_admin');
      assert.deepEqual(localListing.items[0].identities, []);
    });
    await t.test('a disabled bound account cannot receive a new third-party session', async () => {
      await ok(admin, 'PATCH', '/api/admin/users/' + localId, { status: 'banned' });
      const jar = new CookieJar();
      const result = await callback(jar, 'linuxdo', await start(jar, 'linuxdo'), 'bound-linuxdo', false);
      assert.equal(result.statusCode, 403); assert.equal(result.json().error.code, 'account_disabled');
      assert.equal((await ok(jar, 'GET', '/api/me')).user, null);
      await ok(admin, 'PATCH', '/api/admin/users/' + localId, { status: 'active' });
    });
    await t.test('navigation errors return actionable safe messages while JSON callback clients keep failure statuses', async () => {
      const code = 'never-copy-this-code', state = 'never-copy-this-state';
      const apiError = await callback(new CookieJar(), 'linuxdo', state, code, false);
      assert.equal(apiError.statusCode, 400); assert.equal(apiError.json().error.code, 'invalid_oauth_state');
      const browserError = await callback(new CookieJar(), 'linuxdo', state, code);
      assert.equal(browserError.statusCode, 302);
      const target = new URL(String(browserError.headers.location)); assert.equal(target.origin, origin); assert.equal(target.pathname, '/');
      assert.ok(target.searchParams.get('error')?.includes('同一浏览器'));
      assert.equal(String(browserError.headers.location).includes(code), false); assert.equal(String(browserError.headers.location).includes(state), false);
      assert.equal((await ok(new CookieJar(), 'GET', '/api/me')).user, null);
      const jar = new CookieJar();
      const providerError = await callback(jar, 'linuxdo', await start(jar, 'linuxdo'), 'bad-provider');
      assert.equal(providerError.statusCode, 302);
      const error = new URL(String(providerError.headers.location)).searchParams.get('error')!;
      assert.ok(error.includes('登录凭证') && error.includes('回调地址'));
      assert.equal(error.includes('raw-provider-secret-or-code'), false);
      assert.equal((await ok(jar, 'GET', '/api/me')).user, null);
    });
    await t.test('a return in a different browser preserves state and instructs restarting in the same browser', async () => {
      const initiatingBrowser = new CookieJar(), state = await start(initiatingBrowser, 'linuxdo');
      const missingCookie = await callback(new CookieJar(), 'linuxdo', state, 'browser-transfer');
      const error = new URL(String(missingCookie.headers.location)).searchParams.get('error')!;
      assert.ok(error.includes('同一浏览器') && error.includes('应用内浏览器'));
      assert.equal((await pool.query("SELECT count(*) AS n FROM oauth_states WHERE provider='linuxdo' AND expires_at>now()")).rows[0].n, 1, 'a missing cookie must not consume valid authorization state');
      assert.equal((await callback(initiatingBrowser, 'linuxdo', state, 'browser-transfer')).statusCode, 302, 'the matching initiating browser still completes the protected flow');
      const mismatchBrowser = new CookieJar(), mismatchState = await start(mismatchBrowser, 'linuxdo');
      const mismatch = await callback(mismatchBrowser, 'linuxdo', 'a-different-state', 'never-exchange');
      assert.ok(new URL(String(mismatch.headers.location)).searchParams.get('error')?.includes('不一致'));
      assert.equal((await callback(mismatchBrowser, 'linuxdo', mismatchState, 'matching-state')).statusCode, 302);
    });
    await t.test('expired and previously consumed states have distinct safe diagnostic stages', async () => {
      const jar = new CookieJar(), state = await start(jar, 'linuxdo');
      await pool.query("UPDATE oauth_states SET expires_at=now()-interval '1 minute' WHERE provider='linuxdo'");
      const expired = await callback(jar, 'linuxdo', state, 'never-exchange');
      assert.ok(new URL(String(expired.headers.location)).searchParams.get('error')?.includes('10 分钟'));
      assert.equal((await ok(jar, 'GET', '/api/me')).user, null);
      const consumed = new CookieJar(), consumedState = await start(consumed, 'linuxdo');
      await pool.query("DELETE FROM oauth_states WHERE provider='linuxdo'");
      const used = await callback(consumed, 'linuxdo', consumedState, 'never-exchange');
      assert.ok(new URL(String(used.headers.location)).searchParams.get('error')?.includes('已使用或失效'));
    });
    await t.test('callback logs contain only controlled provider, stage and error code without request or credential values', () => {
      const failures = stderr.mock.calls.map(call => ({ event: call.arguments[0], data: JSON.parse(call.arguments[1]) }));
      const completed = stdout.mock.calls.map(call => ({ event: call.arguments[0], data: JSON.parse(call.arguments[1]) }));
      assert.ok(failures.some(item => item.data.stage === 'state_cookie_missing' && item.data.code === 'invalid_oauth_state'));
      assert.ok(failures.some(item => item.data.stage === 'state_cookie_mismatch'));
      assert.ok(failures.some(item => item.data.stage === 'state_expired'));
      assert.ok(failures.some(item => item.data.stage === 'state_missing_or_used'));
      assert.ok(failures.some(item => item.data.stage === 'token_exchange' && item.data.code === 'oauth_provider_error'));
      assert.ok(completed.some(item => item.data.provider === 'linuxdo' && item.data.code === 'success'));
      for (const item of [...failures, ...completed]) {
        assert.ok(['oauth.callback.failed', 'oauth.callback.completed'].includes(item.event));
        assert.deepEqual(Object.keys(item.data).sort(), ['code', 'provider', 'stage']);
        assert.ok(['github', 'linuxdo', 'unknown'].includes(item.data.provider));
      }
      const output = JSON.stringify([...failures, ...completed]);
      for (const value of ['never-copy-this-code', 'never-copy-this-state', 'raw-provider-secret-or-code', 'fixture-linuxdo-secret', 'fixture-linuxdo-client', password, 'wisdom_oauth', 'wisdom_session', 'tree.example.test']) assert.equal(output.includes(value), false);
    });
  } finally {
    await app.close(); await pool.end(); await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
