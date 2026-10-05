import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../backend/src/app.js';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { createAdmin } from '../backend/src/admin-cli.js';

type Jar = Map<string, string>;
type GithubCall = { url: string; method: string; headers: Headers; body: unknown };
const origin = 'https://wisdom-update.test.invalid';
const password = 'Disposable-update-test-password-2026';
const installed = 'a'.repeat(40), next = 'b'.repeat(40), later = 'c'.repeat(40);
const fixtureToken = 'update-fixture-token', replacementToken = 'replacement-update-fixture-token';

test('system updates protect credentials and coalesce checks and administrator deployments', { timeout: 90000 }, async t => {
  const dataDir = join(tmpdir(), 'wisdom-system-update-' + randomUUID());
  await mkdir(dataDir, { recursive: true });
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = dataDir;
  const pool = await getPool();
  await runMigrations(pool);
  const calls: GithubCall[] = [];
  let latest = next;
  let failHead = false, failDispatch = false, uncertainDispatch = false, legacyDispatch = false;
  let failRuns = false;
  let runStatus = 'in_progress';
  let discoveredRuns: Record<string, unknown>[] = [];
  let headGate: Promise<void> | undefined, releaseHead: (() => void) | undefined, enteredHead: (() => void) | undefined;
  let dispatchGate: Promise<void> | undefined, releaseDispatch: (() => void) | undefined, enteredDispatch: (() => void) | undefined;
  const updateFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://api.github.com', 'the update token must be sent only to GitHub API');
    assert.ok(url.pathname.startsWith('/repos/vow132/wisdom-tree/'), 'the repository comes from trusted configuration');
    assert.equal(init.redirect, 'error', 'an API redirect cannot forward the token to another host');
    const headers = new Headers(init.headers);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.toString(), method, headers, body });
    if (method === 'GET') {
      if (url.pathname.includes('/actions/')) {
        assert.equal(headers.get('authorization'), 'Bearer ' + fixtureToken);
        if (failRuns) throw new Error('isolated GitHub run network failure ' + fixtureToken);
        if (url.pathname.endsWith('/actions/workflows/cd.yml/runs')) {
          assert.equal(url.searchParams.get('event'), 'workflow_dispatch');
          assert.equal(url.searchParams.get('per_page'), '100');
          assert.match(url.searchParams.get('head_sha') || '', /^[a-f0-9]{40}$/);
          return Response.json({ workflow_runs: discoveredRuns });
        }
        assert.match(url.pathname, /\/actions\/runs\/\d+$/);
        return Response.json({ id: Number(url.pathname.split('/').at(-1)), status: runStatus });
      }
      assert.equal(url.pathname, '/repos/vow132/wisdom-tree/commits/codex%2Fwisdom-tree');
      enteredHead?.(); await headGate;
      if (failHead) throw new Error('isolated GitHub metadata network failure');
      return Response.json({ sha: latest, object: { sha: latest }, commit: { message: 'Disposable update fixture' } });
    }
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/repos/vow132/wisdom-tree/actions/workflows/cd.yml/dispatches');
    enteredDispatch?.(); await dispatchGate;
    if (uncertainDispatch) throw new Error('response lost after GitHub accepted request ' + fixtureToken);
    if (failDispatch) return Response.json({ message: 'denied ' + fixtureToken }, { status: 403 });
    if (legacyDispatch) return new Response(null, { status: 204 });
    return Response.json({ workflow_run_id: 123456, html_url: 'https://github.com/vow132/wisdom-tree/actions/runs/123456' });
  };
  const baseConfig = {
    publicOrigin: origin, secureCookies: true, development: false, apiKeyEncryptionKey: randomBytes(32).toString('hex'),
    githubClientId: '', githubClientSecret: '', linuxdoClientId: '', linuxdoClientSecret: '',
    appVersion: installed, updateRepository: 'vow132/wisdom-tree', updateBranch: 'codex/wisdom-tree',
  };
  let app = await buildApp({ pool, config: baseConfig, updateFetch });
  const adminJar: Jar = new Map(), userJar: Jar = new Map();
  let adminId = '';
  async function request(jar: Jar | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { host: new URL(origin).host, ...extra };
    if (jar) headers.cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ');
    if (!['GET', 'HEAD'].includes(method) && headers.origin === undefined) headers.origin = origin;
    const response = await app.inject({ method: method as any, url: path, headers, payload: body as any });
    if (jar) for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  }
  async function ok(jar: Jar | null, method: string, path: string, body?: unknown) {
    const response = await request(jar, method, path, body);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${path}: ${response.statusCode} ${response.body}`);
    return response.json();
  }
  const settings = () => ok(adminJar, 'GET', '/api/admin/update/settings');
  const configure = (body: unknown) => ok(adminJar, 'PATCH', '/api/admin/update/settings', body);
  const status = () => ok(null, 'GET', '/api/system/update');
  const deploy = (version = latest) => request(adminJar, 'POST', '/api/admin/update', { expectedVersion: version });
  const dispatches = () => calls.filter(call => call.method === 'POST');
  const checks = () => calls.filter(call => call.method === 'GET');
  async function rebuild(version = installed) {
    await app.close();
    app = await buildApp({ pool, config: { ...baseConfig, appVersion: version }, updateFetch });
  }
  async function updateStorage() {
    const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%update%' ORDER BY table_name")).rows;
    assert.ok(tables.length > 0, 'the update migration persists configuration and job state');
    return Promise.all(tables.map(async ({ table_name }) => {
      assert.match(table_name, /^[a-z_]+$/);
      return { table: table_name, rows: (await pool.query(`SELECT * FROM ${table_name}`)).rows };
    }));
  }
  try {
    await createAdmin(pool, 'update_fixture_admin', password);
    adminId = (await ok(adminJar, 'POST', '/api/auth/login', { username: 'update_fixture_admin', password })).user.id;
    await ok(userJar, 'POST', '/api/auth/register', { username: 'update_fixture_user', password });

    await t.test('fresh settings are disabled, public metadata has no user-role or credential fields', async () => {
      assert.deepEqual(await settings(), { enabled: false, tokenConfigured: false, repositoryUrl: 'https://github.com/vow132/wisdom-tree', branch: 'codex/wisdom-tree' });
      const current = await status();
      assert.equal(current.currentVersion, installed);
      assert.equal(current.latestVersion, next);
      assert.equal(current.repositoryUrl, 'https://github.com/vow132/wisdom-tree');
      assert.equal(current.updateAvailable, true);
      assert.equal(current.phase, 'available');
      assert.equal(current.canUpdate, false);
      for (const field of ['role', 'token', 'tokenCiphertext', 'tokenConfigured', 'clientSecret']) assert.equal(field in current, false);
      assert.equal((await request(null, 'GET', '/api/system/update')).headers['cache-control'], 'no-store');
    });

    await t.test('admin authentication, active status and Origin are required before GitHub access', async () => {
      const before = calls.length;
      for (const [jar, expected] of [[null, 401], [userJar, 403]] as const) {
        assert.equal((await request(jar, 'GET', '/api/admin/update/settings')).statusCode, expected);
        assert.equal((await request(jar, 'PATCH', '/api/admin/update/settings', { enabled: false })).statusCode, expected);
        assert.equal((await request(jar, 'POST', '/api/admin/update', { expectedVersion: next })).statusCode, expected);
      }
      assert.equal((await request(adminJar, 'POST', '/api/admin/update', { expectedVersion: next }, { origin: 'https://untrusted.invalid' })).statusCode, 403);
      const missing = await app.inject({ method: 'POST', url: '/api/admin/update', headers: { cookie: [...adminJar].map(([k, v]) => k + '=' + v).join('; ') }, payload: { expectedVersion: next } });
      assert.equal(missing.statusCode, 403);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/update/settings', { enabled: false }, { origin: 'https://untrusted.invalid' })).statusCode, 403);
      assert.equal(calls.length, before, 'rejected users and CSRF requests do not call GitHub');
      for (const body of [{ enabled: true }, { enabled: 'yes' }, { token: null }, { clearToken: 'yes' }, { token: fixtureToken, clearToken: true }]) {
        assert.equal((await request(adminJar, 'PATCH', '/api/admin/update/settings', body)).statusCode, 400);
      }
      assert.equal((await settings()).tokenConfigured, false);
    });

    await t.test('tokens are encrypted, write-only and never appear in audit or public metadata', async () => {
      const saved = await configure({ enabled: true, token: fixtureToken });
      assert.deepEqual(saved, { enabled: true, tokenConfigured: true, repositoryUrl: 'https://github.com/vow132/wisdom-tree', branch: 'codex/wisdom-tree' });
      const stored = await updateStorage();
      assert.equal(JSON.stringify(stored).includes(fixtureToken), false);
      assert.ok(stored.some(table => table.rows.some(row => Object.entries(row).some(([key, value]) => key.includes('ciphertext') && typeof value === 'string' && value.length > 20))), 'the saved token is represented by ciphertext');
      const visible = JSON.stringify({ saved, settings: await settings(), audit: await ok(adminJar, 'GET', '/api/admin/audit'), status: await status() });
      assert.equal(visible.includes(fixtureToken), false);
      assert.equal((await status()).canUpdate, true);
      await rebuild();
      assert.equal((await settings()).tokenConfigured, true, 'database update configuration survives rebuilding the app');
    });

    await t.test('blank tokens preserve ciphertext, replacement is explicit and clearing requires disabling', async () => {
      const before = JSON.stringify(await updateStorage());
      await configure({ enabled: true, token: '   ' });
      const preserved = await updateStorage();
      // updated_at may change; compare only ciphertext values.
      const encrypted = (text: string) => [...text.matchAll(/"[^"]*ciphertext":"([^"]+)"/g)].map(match => match[1]);
      assert.deepEqual(encrypted(JSON.stringify(preserved)), encrypted(before));
      await configure({ enabled: true, token: replacementToken });
      assert.notDeepEqual(encrypted(JSON.stringify(await updateStorage())), encrypted(before));
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/update/settings', { enabled: true, clearToken: true })).statusCode, 400);
      assert.equal((await settings()).tokenConfigured, true);
      const cleared = await configure({ enabled: false, clearToken: true });
      assert.equal(cleared.tokenConfigured, false);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/update/settings', { enabled: true })).statusCode, 400);
      await configure({ enabled: true, token: fixtureToken });
      const visible = JSON.stringify({ audit: await ok(adminJar, 'GET', '/api/admin/audit'), storage: await updateStorage() });
      assert.equal(visible.includes(fixtureToken), false);
      assert.equal(visible.includes(replacementToken), false);
    });

    await t.test('concurrent public checks share one fetch and subsequent requests use the cache', async () => {
      await rebuild(); calls.length = 0;
      const entered = new Promise<void>(resolve => { enteredHead = resolve; });
      headGate = new Promise<void>(resolve => { releaseHead = resolve; });
      const pending = Array.from({ length: 15 }, () => status());
      await entered;
      assert.equal(checks().length, 1, 'all simultaneous visitors share a single upstream metadata request');
      releaseHead!();
      const results = await Promise.all(pending);
      assert.ok(results.every(result => result.latestVersion === next && result.phase === 'available'));
      headGate = undefined; enteredHead = undefined;
      await Promise.all(Array.from({ length: 10 }, () => status()));
      assert.equal(checks().length, 1, 'new page requests within the cache lifetime do not fetch GitHub again');
    });

    await t.test('outdated or invalid targets are rejected without dispatching', async () => {
      const before = dispatches().length;
      assert.equal((await deploy(installed)).statusCode, 409);
      assert.equal(dispatches().length, before);
      assert.equal((await request(adminJar, 'POST', '/api/admin/update', { expectedVersion: 'not-a-commit' })).statusCode, 400);
    });

    await t.test('a concurrent accepted target dispatches once and releases the database before network I/O', async () => {
      const before = dispatches().length;
      const entered = new Promise<void>(resolve => { enteredDispatch = resolve; });
      dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
      const first = deploy(next);
      await entered;
      const second = deploy(next);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let configuration;
      try {
        configuration = await Promise.race([settings(), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('update dispatch holds a database lock over network I/O')), 2000);
        })]);
      } finally { clearTimeout(deadline); }
      assert.equal(configuration.enabled, true);
      assert.equal(dispatches().length, before + 1);
      releaseDispatch!();
      const replies = await Promise.all([first, second]);
      assert.ok(replies.every(reply => reply.statusCode === 202));
      dispatchGate = undefined; enteredDispatch = undefined;
      assert.equal(dispatches().length, before + 1);
      const accepted = dispatches().at(-1)!;
      assert.equal(accepted.headers.get('authorization'), 'Bearer ' + fixtureToken);
      const acceptedJob = (await pool.query("SELECT id FROM system_update_jobs WHERE status='submitted'")).rows[0];
      assert.match(acceptedJob.id, /^[a-f0-9-]{36}$/);
      assert.deepEqual(accepted.body, { ref: 'codex/wisdom-tree', inputs: { deploy: true, expected_sha: next, expected_origin: origin, update_request_id: acceptedJob.id } });
      const replay = await deploy(next);
      assert.equal(replay.statusCode, 202);
      assert.equal(dispatches().length, before + 1, 'a later replay of the accepted target does not dispatch again');
      const running = await status();
      assert.equal(running.phase, 'running');
      assert.equal(running.runUrl, 'https://github.com/vow132/wisdom-tree/actions/runs/123456');
      assert.equal(JSON.stringify(running).includes(fixtureToken), false);
    });

    await t.test('expired known queued and running jobs renew their lease instead of allowing another dispatch', async () => {
      const before = dispatches().length;
      for (const state of ['queued', 'in_progress']) {
        await pool.query("UPDATE system_update_jobs SET expires_at=now()-interval '1 minute' WHERE status='submitted'");
        await rebuild(); runStatus = state;
        assert.equal((await status()).phase, 'running');
        assert.equal((await deploy(next)).statusCode, 202);
        assert.equal(dispatches().length, before);
        const pending = (await pool.query("SELECT status,expires_at FROM system_update_jobs WHERE status='submitted'")).rows[0];
        assert.ok(new Date(pending.expires_at).getTime() > Date.now() + 110 * 60_000);
      }
      runStatus = 'in_progress';
    });

    await t.test('unreachable run metadata never releases an expired known job or exposes its token', async () => {
      await pool.query("UPDATE system_update_jobs SET expires_at=now()-interval '1 minute' WHERE status='submitted'");
      await rebuild(); failRuns = true;
      const before = dispatches().length;
      const pending = await status();
      assert.equal(pending.phase, 'running');
      assert.equal(JSON.stringify(pending).includes(fixtureToken), false);
      assert.equal((await deploy(next)).statusCode, 202);
      assert.equal(dispatches().length, before);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM system_update_jobs WHERE status='submitted'")).rows[0].n, 1);
      failRuns = false;
    });

    await t.test('a confirmed completed workflow without the installed target permits a new manual attempt', async () => {
      await rebuild(); runStatus = 'completed';
      const before = dispatches().length;
      assert.equal((await status()).phase, 'available');
      assert.equal((await pool.query("SELECT status FROM system_update_jobs ORDER BY created_at DESC LIMIT 1")).rows[0].status, 'failed');
      assert.equal((await deploy(next)).statusCode, 202);
      assert.equal(dispatches().length, before + 1);
      runStatus = 'in_progress';
    });

    await t.test('an installed target finishes the active job and reports the current version without polling', async () => {
      await rebuild(next);
      const before = dispatches().length;
      const current = await status();
      assert.equal(current.currentVersion, next);
      assert.equal(current.latestVersion, next);
      assert.equal(current.phase, 'current');
      assert.equal(current.updateAvailable, false);
      assert.equal(dispatches().length, before);
      assert.ok((await updateStorage()).some(table => table.rows.some(row => Object.values(row).includes(next))), 'the accepted target remains in persisted job history');
    });

    await t.test('network metadata failures are cached for one minute and recover on a later manual check', async t => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      await rebuild(next); failHead = true;
      const before = dispatches().length;
      const replies = await Promise.all(Array.from({ length: 8 }, () => status()));
      assert.ok(replies.every(reply => reply.phase === 'unknown' && reply.currentVersion === next && reply.updateAvailable === false));
      assert.ok(replies.every(reply => !JSON.stringify(reply).includes(fixtureToken)));
      assert.equal((await deploy(later)).statusCode, 400);
      assert.equal(dispatches().length, before);
      failHead = false;
      const beforeRecovery = checks().length;
      assert.equal((await status()).phase, 'unknown');
      t.mock.timers.tick(59_000);
      assert.equal((await status()).phase, 'unknown');
      assert.equal(checks().length, beforeRecovery, 'failed checks share a short cache instead of hammering GitHub');
      t.mock.timers.tick(1_001);
      assert.equal((await status()).phase, 'current');
      assert.equal(checks().length, beforeRecovery + 1, 'a failure is not cached for the successful five-minute lifetime');
      t.mock.timers.tick(299_000);
      assert.equal((await status()).phase, 'current');
      assert.equal(checks().length, beforeRecovery + 1, 'successful results retain the five-minute cache');
    });

    await t.test('a failed dispatch is retryable and legacy 204 responses are accepted without leaking secrets', async () => {
      latest = later; await rebuild(next); failDispatch = true;
      const before = dispatches().length;
      const failed = await deploy(later);
      assert.equal(failed.statusCode, 400);
      assert.equal(failed.body.includes(fixtureToken), false, 'upstream error messages cannot expose the token');
      assert.equal(dispatches().length, before + 1);
      failDispatch = false; legacyDispatch = true;
      const retry = await deploy(later);
      assert.equal(retry.statusCode, 202, retry.body);
      assert.equal(dispatches().length, before + 2, 'a failed job does not permanently block retrying that target');
      assert.equal((await status()).phase, 'running');
      const visible = JSON.stringify({ settings: await settings(), audit: await ok(adminJar, 'GET', '/api/admin/audit'), status: await status() });
      assert.equal(visible.includes(fixtureToken), false);
    });

    await t.test('an uncertain dispatch result stays pending and replaying never submits it twice', async () => {
      await rebuild(later);
      assert.equal((await status()).phase, 'current', 'the previous legacy job finishes when its target is installed');
      latest = 'd'.repeat(40); await rebuild(later);
      uncertainDispatch = true;
      const before = dispatches().length;
      const uncertain = await deploy(latest);
      assert.equal(uncertain.statusCode, 202, uncertain.body);
      assert.equal(uncertain.json().phase, 'running');
      assert.equal(uncertain.body.includes(fixtureToken), false);
      assert.equal(uncertain.json().runUrl, 'https://github.com/vow132/wisdom-tree/actions/workflows/cd.yml');
      assert.equal(dispatches().length, before + 1);
      const retry = await deploy(latest);
      assert.equal(retry.statusCode, 202);
      assert.equal(dispatches().length, before + 1, 'losing the upstream response does not permit a duplicate workflow dispatch');
      const active = (await pool.query("SELECT target_sha,status FROM system_update_jobs WHERE status IN ('dispatching','submitted')")).rows;
      assert.deepEqual(active, [{ target_sha: latest, status: 'submitted' }]);
      uncertainDispatch = false;

      for (const pendingStatus of ['submitted', 'dispatching']) {
        await pool.query("UPDATE system_update_jobs SET status=$1,expires_at=now()-interval '1 minute' WHERE status IN ('dispatching','submitted')", [pendingStatus]);
        failRuns = true; await rebuild(later);
        assert.equal((await status()).phase, 'running', 'a run lookup network failure cannot release an uncertain dispatch');
        assert.equal((await deploy(latest)).statusCode, 202);
        assert.equal(dispatches().length, before + 1);
        failRuns = false; discoveredRuns = []; await rebuild(later);
        const unknown = await status();
        assert.equal(unknown.phase, 'running');
        assert.ok(unknown.message.includes('尚未确认'));
        assert.equal(unknown.runUrl, 'https://github.com/vow132/wisdom-tree/actions/workflows/cd.yml');
        assert.equal((await deploy(latest)).statusCode, 202);
        assert.equal((await deploy(next)).statusCode, 409);
        assert.equal(dispatches().length, before + 1, 'expired uncertain jobs, including a crash during dispatch, remain singletons');
      }
      const uncertainJob = (await pool.query("SELECT id,target_sha FROM system_update_jobs WHERE status IN ('dispatching','submitted')")).rows[0];
      discoveredRuns = [
        { id: 111, head_sha: 'e'.repeat(40), event: 'workflow_dispatch', display_title: '网站更新 ' + uncertainJob.id, status: 'queued' },
        { id: 222, head_sha: latest, event: 'push', display_title: '网站更新 ' + uncertainJob.id, status: 'queued' },
        { id: 333, head_sha: latest, event: 'workflow_dispatch', display_title: '网站更新 ' + randomUUID(), status: 'queued' },
        { id: 7654321, head_sha: latest, event: 'workflow_dispatch', display_title: '网站更新 ' + uncertainJob.id, status: 'queued', html_url: 'https://untrusted.invalid/stolen-token' },
      ];
      await rebuild(later);
      const found = await status();
      assert.equal(found.phase, 'running');
      assert.equal(found.runUrl, 'https://github.com/vow132/wisdom-tree/actions/runs/7654321');
      const discovered = (await pool.query("SELECT run_id,status,expires_at FROM system_update_jobs WHERE id=$1", [uncertainJob.id])).rows[0];
      assert.equal(discovered.run_id, '7654321');
      assert.equal(discovered.status, 'submitted');
      assert.ok(new Date(discovered.expires_at).getTime() > Date.now() + 110 * 60_000);
      assert.equal((await deploy(latest)).statusCode, 202);
      assert.equal(dispatches().length, before + 1);
      discoveredRuns = [];
      await rebuild(latest);
      assert.equal((await status()).phase, 'current');
    });

    await t.test('a discovered completed workflow settles an uncertain job before a new manual attempt', async () => {
      const previous = latest;
      latest = 'e'.repeat(40); await rebuild(previous);
      const before = dispatches().length;
      assert.equal((await deploy(latest)).statusCode, 202);
      const job = (await pool.query("SELECT id FROM system_update_jobs WHERE status='submitted'")).rows[0];
      discoveredRuns = [{ id: 8765432, head_sha: latest, event: 'workflow_dispatch', display_title: '网站更新 ' + job.id, status: 'completed' }];
      await rebuild(previous);
      assert.equal((await status()).phase, 'available');
      const completed = (await pool.query('SELECT status,run_id FROM system_update_jobs WHERE id=$1', [job.id])).rows[0];
      assert.deepEqual(completed, { status: 'failed', run_id: '8765432' });
      assert.equal(dispatches().length, before + 1, 'completion never submits a retry by itself');
      discoveredRuns = [];
      assert.equal((await deploy(latest)).statusCode, 202);
      assert.equal(dispatches().length, before + 2, 'a confirmed terminal result permits a new explicit attempt');
      await rebuild(latest);
      assert.equal((await status()).phase, 'current');
    });

    await t.test('an existing session loses update access immediately when its administrator is banned', async () => {
      await pool.query("UPDATE users SET status='banned' WHERE id=$1", [adminId]);
      const before = calls.length;
      assert.ok([401, 403].includes((await request(adminJar, 'GET', '/api/admin/update/settings')).statusCode));
      assert.ok([401, 403].includes((await deploy(later)).statusCode));
      assert.equal(calls.length, before);
    });
  } finally {
    releaseHead?.(); releaseDispatch?.();
    await app.close(); await pool.end();
  }
});
