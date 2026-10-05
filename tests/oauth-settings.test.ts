import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { buildApp } from '../backend/src/app.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import { decryptOAuthSecret } from '../backend/src/oauth-settings.js';

type Jar = Map<string, string>;
const origin = 'http://127.0.0.1:5173';
const pass = 'Disposable-oauth-settings-test-2026';

test('administrator OAuth configuration, encryption and dynamic login availability', { timeout: 60000 }, async t => {
  const dataDir = join(tmpdir(), 'wisdom-oauth-settings-' + randomUUID());
  await mkdir(dataDir, { recursive: true });
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = dataDir;
  const master = randomBytes(32).toString('hex');
  const pool = await getPool();
  await runMigrations(pool);
  const exchanges: { provider: string; id: string; secret: string; redirect: string; verifier: string | null }[] = [];
  let slowStarted: (() => void) | undefined;
  let releaseSlow: (() => void) | undefined;
  let slowGate: Promise<void> | undefined;
  const provider = createServer(async (request, response) => {
    const path = request.url || '';
    const name = path.split('/')[1];
    if (path.endsWith('/token')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      const code = params.get('code') || 'identity';
      exchanges.push({ provider: name, id: params.get('client_id')!, secret: params.get('client_secret')!, redirect: params.get('redirect_uri')!, verifier: params.get('code_verifier') });
      if (code === 'slow-identity') { slowStarted?.(); await slowGate; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: name + ':' + code }));
    } else if (path.endsWith('/user')) {
      const code = (request.headers.authorization || '').split(':').at(-1);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: code, name: '隔离 OAuth 用户', active: true }));
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const mockOrigin = 'http://127.0.0.1:' + (provider.address() as { port: number }).port;
  const config = {
    publicOrigin: origin, secureCookies: false, development: true, apiKeyEncryptionKey: master,
    githubClientId: 'legacy-gh-client', githubClientSecret: 'legacy-gh-secret',
    linuxdoClientId: '', linuxdoClientSecret: '',
    githubAuthorizeUrl: mockOrigin + '/github/authorize', githubTokenUrl: mockOrigin + '/github/token', githubUserUrl: mockOrigin + '/github/user',
    linuxdoAuthorizeUrl: mockOrigin + '/linuxdo/authorize', linuxdoTokenUrl: mockOrigin + '/linuxdo/token', linuxdoUserUrl: mockOrigin + '/linuxdo/user',
  };
  let app = await buildApp({ pool, config });
  const adminJar: Jar = new Map(), userJar: Jar = new Map();
  async function request(jar: Jar | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
    if (jar) headers.cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    if (!['GET', 'HEAD'].includes(method) && headers.origin === undefined) headers.origin = origin;
    const res = await app.inject({ method: method as any, url: path, headers, payload: body as any });
    if (jar) for (const cookie of res.cookies) jar.set(cookie.name, cookie.value);
    return res;
  }
  async function ok(jar: Jar | null, method: string, path: string, body?: unknown) {
    const res = await request(jar, method, path, body);
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${path}: ${res.statusCode} ${res.body}`);
    return res.json();
  }
  const update = async (name: string, body: unknown) => (await ok(adminJar, 'PATCH', '/api/admin/oauth/' + name, body)).item;
  const settings = async () => (await ok(adminJar, 'GET', '/api/admin/oauth')).items;
  async function start(jar: Jar, name: string, binding = false) {
    const res = await request(jar, 'GET', `/api/auth/${name}/start${binding ? '?bind=1' : ''}`);
    assert.equal(res.statusCode, 302);
    const url = new URL(res.headers.location as string);
    return { state: url.searchParams.get('state')!, url };
  }
  const callback = (jar: Jar, name: string, state: string, code: string) => request(jar, 'GET', `/api/auth/${name}/callback?` + new URLSearchParams({ state, code }));
  let boundUserId = '';
  const ghSecret = 'new-github-fixture-secret';
  const ldSecret = 'new-linuxdo-fixture-secret';
  try {
    await createAdmin(pool, 'oauth_settings_admin', pass);
    await ok(adminJar, 'POST', '/api/auth/login', { username: 'oauth_settings_admin', password: pass });
    boundUserId = (await ok(userJar, 'POST', '/api/auth/register', { username: 'oauth_settings_user', password: pass })).user.id;

    await t.test('empty defaults are hidden and existing environment credentials remain compatible', async () => {
      const empty = await buildApp({ pool, config: { ...config, githubClientId: '', githubClientSecret: '' } });
      try {
        assert.deepEqual((await empty.inject('/api/me')).json().providers, { github: false, linuxdo: false });
        assert.equal((await empty.inject('/api/auth/github/start')).statusCode, 503);
      } finally { await empty.close(); }
      const items = await settings();
      assert.deepEqual(items.map((x: any) => [x.provider, x.enabled, x.available, x.source]), [['github', true, true, 'environment'], ['linuxdo', false, false, 'default']]);
      assert.equal(items[0].callbackUrl, origin + '/api/auth/github/callback');
      assert.deepEqual((await ok(null, 'GET', '/api/me')).providers, { github: true, linuxdo: false });
    });

    await t.test('admin permission, Origin, input types and missing credentials are enforced atomically', async () => {
      assert.equal((await request(null, 'GET', '/api/admin/oauth')).statusCode, 401);
      assert.equal((await request(userJar, 'GET', '/api/admin/oauth')).statusCode, 403);
      assert.equal((await request(userJar, 'PATCH', '/api/admin/oauth/github', { enabled: false })).statusCode, 403);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/oauth/github', { enabled: false }, { origin: 'https://untrusted.invalid' })).statusCode, 403);
      const initial = await settings();
      for (const body of [{ enabled: 'yes' }, { clearSecret: 'yes' }, { clientId: null }, { clientSecret: null }, { clientId: 'x'.repeat(513) }, { clientSecret: 'x'.repeat(4097) }, { enabled: true }, { clientSecret: 'replacement', clearSecret: true }]) {
        assert.equal((await request(adminJar, 'PATCH', '/api/admin/oauth/linuxdo', body)).statusCode, 400);
      }
      assert.deepEqual(await settings(), initial);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/oauth/unknown', {})).statusCode, 404);
      assert.equal((await request(null, 'GET', '/api/auth/unknown/start')).statusCode, 404);
      assert.equal((await request(null, 'GET', '/api/auth/unknown/callback')).statusCode, 404);
    });

    await t.test('new credentials are encrypted, audited without secrets and available without restart', async () => {
      await update('github', { enabled: true, clientId: 'db-gh-client', clientSecret: ghSecret });
      await update('linuxdo', { enabled: true, clientId: 'db-ld-client', clientSecret: ldSecret });
      const items = await settings();
      assert.ok(items.every((x: any) => x.available && x.source === 'database' && x.hasClientSecret));
      assert.deepEqual((await ok(null, 'GET', '/api/me')).providers, { github: true, linuxdo: true });
      const rows = (await pool.query('SELECT * FROM oauth_provider_settings ORDER BY provider')).rows;
      for (const row of rows) {
        const expected = row.provider === 'github' ? ghSecret : ldSecret;
        assert.notEqual(row.client_secret_ciphertext, expected);
        assert.equal(decryptOAuthSecret(row.client_secret_ciphertext, master, row.provider), expected);
      }
      assert.throws(() => decryptOAuthSecret(rows[0].client_secret_ciphertext, master, 'linuxdo'));
      const audit = await ok(adminJar, 'GET', '/api/admin/audit');
      const metadata = JSON.stringify({ items, audit });
      for (const secret of [ghSecret, ldSecret, config.githubClientSecret, ...rows.map(x => x.client_secret_ciphertext)]) assert.equal(metadata.includes(secret), false);
      assert.ok(audit.items.some((a: any) => a.action === 'oauth.update' && a.reason === '管理员操作'));
      assert.equal((await request(adminJar, 'GET', '/api/admin/oauth')).headers['cache-control'], 'no-store');
    });

    await t.test('GitHub login and Linux Do binding use the newly saved app credentials', async () => {
      const jar: Jar = new Map();
      const gh = await start(jar, 'github');
      assert.equal(gh.url.searchParams.get('client_id'), 'db-gh-client');
      assert.equal(gh.url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal((await callback(jar, 'github', gh.state, 'github-user')).statusCode, 302);
      assert.equal((await ok(jar, 'GET', '/api/me')).user.role, 'user');
      assert.deepEqual(exchanges.at(-1)?.id, 'db-gh-client');
      assert.equal(exchanges.at(-1)?.secret, ghSecret);
      assert.ok(exchanges.at(-1)?.verifier);
      const ld = await start(userJar, 'linuxdo', true);
      assert.equal((await callback(userJar, 'linuxdo', ld.state, 'linuxdo-bound')).statusCode, 302);
      assert.equal(exchanges.at(-1)?.secret, ldSecret);
      assert.equal(exchanges.at(-1)?.redirect, origin + '/api/auth/linuxdo/callback');
      assert.equal((await ok(userJar, 'GET', '/api/me')).user.id, boundUserId);
      assert.equal((await ok(userJar, 'GET', '/api/auth/identities')).items[0].provider, 'linuxdo');
    });

    await t.test('turning off hides public availability, refuses new flows and preserves bindings and sessions', async () => {
      const pending: Jar = new Map();
      const flow = await start(pending, 'github');
      const off = await update('github', { enabled: false });
      assert.equal(off.hasClientSecret, true);
      assert.equal(off.available, false);
      assert.equal((await request(null, 'GET', '/api/auth/github/start')).statusCode, 503);
      assert.equal((await callback(pending, 'github', flow.state, 'github-user')).statusCode, 503);
      await update('linuxdo', { enabled: false });
      assert.deepEqual((await ok(null, 'GET', '/api/me')).providers, { github: false, linuxdo: false });
      assert.equal((await ok(userJar, 'GET', '/api/me')).user.id, boundUserId);
      assert.equal((await ok(userJar, 'GET', '/api/auth/identities')).items.length, 1);
      assert.equal((await request(userJar, 'GET', '/api/auth/linuxdo/start?bind=1')).statusCode, 503);
    });

    await t.test('blank secret preserves the old value, replacements revoke pending flows and clear is explicit', async () => {
      const before = (await pool.query("SELECT * FROM oauth_provider_settings WHERE provider='github'")).rows[0];
      await update('github', { clientSecret: '   ' });
      const unchanged = (await pool.query("SELECT * FROM oauth_provider_settings WHERE provider='github'")).rows[0];
      assert.equal(unchanged.client_secret_ciphertext, before.client_secret_ciphertext);
      assert.equal(unchanged.revision, before.revision);
      await update('github', { enabled: true, clientSecret: '' });
      const jar: Jar = new Map();
      const flow = await start(jar, 'github');
      await update('github', { clientSecret: 'replacement-gh-secret' });
      assert.equal((await callback(jar, 'github', flow.state, 'github-user')).statusCode, 400);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/oauth/github', { clearSecret: true })).statusCode, 400);
      assert.equal((await settings())[0].hasClientSecret, true);
      const next = await start(jar, 'github');
      assert.equal((await callback(jar, 'github', next.state, 'github-user')).statusCode, 302);
      assert.equal(exchanges.at(-1)?.secret, 'replacement-gh-secret');
      const cleared = await update('github', { enabled: false, clearSecret: true });
      assert.equal(cleared.hasClientSecret, false);
      assert.equal((await pool.query("SELECT client_secret_ciphertext FROM oauth_provider_settings WHERE provider='github'")).rows[0].client_secret_ciphertext, null);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/oauth/github', { enabled: true })).statusCode, 400);
    });

    await t.test('configuration changes during a provider fetch prevent identity and session acceptance', async () => {
      await update('github', { enabled: true, clientSecret: ghSecret });
      const jar: Jar = new Map();
      const flow = await start(jar, 'github');
      const entered = new Promise<void>(resolve => { slowStarted = resolve; });
      slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
      const inFlight = callback(jar, 'github', flow.state, 'slow-identity');
      await entered;
      // This must finish while the HTTP provider is still waiting, proving no DB lock is held over network I/O.
      await update('github', { enabled: false });
      releaseSlow!();
      assert.equal((await inFlight).statusCode, 503);
      assert.equal((await pool.query("SELECT id FROM identities WHERE provider_user_id='slow-identity'")).rows.length, 0);
      assert.equal((await ok(jar, 'GET', '/api/me')).user, null);
    });

    await t.test('database override persists on rebuild and cannot be re-enabled by environment defaults', async () => {
      await app.close();
      app = await buildApp({ pool, config: { ...config, githubClientId: 'changed-env-id', githubClientSecret: 'changed-env-secret', linuxdoClientId: 'changed-env-ld-id', linuxdoClientSecret: 'changed-env-ld-secret' } });
      assert.deepEqual((await ok(null, 'GET', '/api/me')).providers, { github: false, linuxdo: false });
      const items = await settings();
      assert.deepEqual(items.map((x: any) => [x.source, x.clientId, x.enabled]), [['database', 'db-gh-client', false], ['database', 'db-ld-client', false]]);
      await update('linuxdo', { enabled: true });
      const fresh: Jar = new Map();
      const flow = await start(fresh, 'linuxdo');
      assert.equal((await callback(fresh, 'linuxdo', flow.state, 'linuxdo-bound')).statusCode, 302);
      assert.equal((await ok(fresh, 'GET', '/api/me')).user.id, boundUserId);
      assert.equal(exchanges.at(-1)?.id, 'db-ld-client');
      assert.equal(exchanges.at(-1)?.secret, ldSecret);
      const oldIdentity = (await ok(userJar, 'GET', '/api/auth/identities')).items;
      assert.equal(oldIdentity.length, 1);
    });
  } finally {
    releaseSlow?.();
    await app.close();
    await pool.end();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
