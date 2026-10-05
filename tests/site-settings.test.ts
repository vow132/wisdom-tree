import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../backend/src/app.js';
import { getPool } from '../backend/src/db.js';
import { runMigrations } from '../backend/src/migrate.js';
import { createAdmin } from '../backend/src/admin-cli.js';
import type { PoolLike } from '../backend/src/types.js';

test('site settings and decoded media persist with administrator protection and backup-safe history', { timeout: 90_000 }, async t => {
  const directory = join(tmpdir(), 'wisdom-site-settings-' + randomUUID());
  const uploads = join(directory, 'uploads');
  await mkdir(directory, { recursive: true });
  process.env.DATABASE_MODE = 'embedded';
  process.env.PGLITE_PATH = join(directory, 'db');
  const pool = await getPool();
  await runMigrations(pool);
  let failAudit = false;
  let loseAssetCommitAcknowledgement = false, committingAsset = false;
  let revokeActorAtGuard = false;
  let holdAssetWrite: Promise<void> | undefined, releaseAssetWrite: (() => void) | undefined, enteredAssetWrite: (() => void) | undefined;
  const guardedPool: PoolLike = {
    query: pool.query.bind(pool),
    async connect() {
      const db = await pool.connect();
      return {
        async query<T>(sql: string, params?: any[]) {
          if (revokeActorAtGuard && sql === 'SELECT * FROM users WHERE id=$1') {
            revokeActorAtGuard = false;
            await db.query("UPDATE users SET role='user' WHERE id=$1", params);
          }
          if (sql.startsWith('SELECT count(*) AS count,COALESCE(sum(byte_size),0)')) { enteredAssetWrite?.(); await holdAssetWrite; }
          if (sql.startsWith('INSERT INTO audit') && params?.[3] === 'site-settings.asset-upload') {
            if (failAudit) throw new Error('isolated asset audit failure');
            committingAsset = true;
          }
          if (sql === 'COMMIT' && committingAsset) {
            committingAsset = false;
            if (loseAssetCommitAcknowledgement) {
              loseAssetCommitAcknowledgement = false;
              await db.query(sql, params);
              throw new Error('isolated lost asset COMMIT acknowledgement');
            }
          }
          return db.query<T>(sql, params);
        },
        release: db.release.bind(db),
      };
    },
    end: pool.end.bind(pool),
  };
  const origin = 'https://site-settings.test.invalid';
  const config = { publicOrigin: origin, secureCookies: true, development: false, apiKeyEncryptionKey: randomBytes(32).toString('hex'), siteUploadDir: uploads };
  let app = await buildApp({ pool: guardedPool, config, updateFetch: async () => Response.json({ sha: 'a'.repeat(40) }) });
  const adminJar = new Map<string, string>(), userJar = new Map<string, string>();
  const password = 'Disposable-site-settings-test-2026';
  async function request(jar: Map<string, string> | null, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
    const outgoing: Record<string, string> = { host: new URL(origin).host, ...headers };
    if (jar) outgoing.cookie = [...jar].map(([key, value]) => key + '=' + value).join('; ');
    if (!['GET', 'HEAD'].includes(method) && outgoing.origin === undefined) outgoing.origin = origin;
    const response = await app.inject({ method: method as any, url: path, headers: outgoing, payload: payload as any });
    if (jar) for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
    return response;
  }
  async function ok(jar: Map<string, string> | null, method: string, path: string, payload?: unknown) {
    const response = await request(jar, method, path, payload);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${path}: ${response.statusCode} ${response.body}`);
    return response.json();
  }
  const get = () => ok(null, 'GET', '/api/site-settings');
  const patch = (body: unknown) => ok(adminJar, 'PATCH', '/api/admin/site-settings', body);
  const upload = (slot: string, buffer: Buffer, mimeType?: string) => ok(adminJar, 'POST', '/api/admin/site-settings/assets/' + slot, { data: buffer.toString('base64'), ...(mimeType ? { mimeType } : {}) });
  const pixel = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#4c935680' } }).png().toBuffer();
  const snapshot = async () => ({ settings: await get(), files: (await readdir(uploads)).sort(), assets: (await pool.query('SELECT * FROM site_assets ORDER BY filename')).rows });
  let logoUrl = '', faviconUrl = '', backgroundUrl = '';
  try {
    await createAdmin(pool, 'site_fixture_admin', password);
    await ok(adminJar, 'POST', '/api/auth/login', { username: 'site_fixture_admin', password });
    await ok(userJar, 'POST', '/api/auth/register', { username: 'site_fixture_user', password });
    await t.test('fresh site uses current text and built-in images without exposing private configuration', async () => {
      const initial = await get();
      assert.deepEqual(Object.keys(initial).sort(), ['browserTitle', 'faviconUrl', 'footerText', 'gardenBackgroundUrl', 'gardenSubtitle', 'logoUrl', 'siteName', 'updatedAt'].sort());
      assert.equal(initial.siteName, '智慧树');
      assert.equal(initial.browserTitle, '智慧树 · 养成与 API');
      assert.equal(initial.gardenSubtitle, '每天照料一点，让智慧慢慢生长。');
      assert.equal(initial.footerText, '一棵树，一个慢慢生长的花园。');
      assert.equal(initial.logoUrl, null); assert.equal(initial.faviconUrl, null); assert.equal(initial.gardenBackgroundUrl, null);
      assert.ok(Number.isFinite(Date.parse(initial.updatedAt)));
      assert.deepEqual(await ok(adminJar, 'GET', '/api/admin/site-settings'), initial);
      assert.equal((await request(null, 'GET', '/api/site-settings')).headers['cache-control'], 'no-store');
    });
    await t.test('admin access and Origin apply to text and uploads before any file is published', async () => {
      for (const [jar, status] of [[null, 401], [userJar, 403]] as const) {
        for (const [method, path, body] of [['GET', '/api/admin/site-settings', undefined], ['PATCH', '/api/admin/site-settings', { siteName: 'invalid actor' }], ['POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') }]] as const) {
          assert.equal((await request(jar, method, path, body)).statusCode, status);
        }
      }
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', { siteName: 'invalid origin' }, { origin: 'https://untrusted.invalid' })).statusCode, 403);
      assert.equal((await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') }, { origin: 'https://untrusted.invalid' })).statusCode, 403);
      assert.deepEqual(await readdir(uploads), []);
    });
    await t.test('text validation permits hiding optional copy and maintains strictly ordered versions', async () => {
      const initial = await get();
      const saved = await patch({ siteName: ' 花园名称 ', browserTitle: '我的智慧树', gardenSubtitle: '', footerText: ' ' });
      assert.equal(saved.siteName, '花园名称'); assert.equal(saved.browserTitle, '我的智慧树');
      assert.equal(saved.gardenSubtitle, ''); assert.equal(saved.footerText, '');
      assert.ok(Date.parse(saved.updatedAt) > Date.parse(initial.updatedAt));
      const next = await patch({ footerText: '新的页脚' });
      assert.ok(Date.parse(next.updatedAt) > Date.parse(saved.updatedAt));
      assert.equal(next.siteName, saved.siteName);
      assert.deepEqual(await patch({}), next, 'a no-op must not change the version or configuration');
      for (const invalid of [{ siteName: '' }, { siteName: ' ' }, { siteName: 'x'.repeat(61) }, { browserTitle: '' }, { browserTitle: 'x'.repeat(121) }, { gardenSubtitle: 'x'.repeat(201) }, { footerText: 'x'.repeat(301) }, { footerText: null }, { siteName: 'bad\u0000text' }, { browserTitle: 'line\nbreak' }, { gardenSubtitle: 4 }, { unknown: true }]) {
        assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', invalid)).statusCode, 400);
        assert.deepEqual(await get(), next);
      }
      const multiline = await patch({ gardenSubtitle: '第一行\r\n第二行', footerText: '第一段\n第二段' });
      assert.equal(multiline.gardenSubtitle, '第一行\n第二行'); assert.equal(multiline.footerText, '第一段\n第二段');
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', { gardenSubtitle: 'bad\u0000text' })).statusCode, 400);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', { footerText: 'bad\ttext' })).statusCode, 400);
      await patch({ gardenSubtitle: '', footerText: '新的页脚' });
    });
    await t.test('real PNG upload creates safe random WebP and publishes immutable media', async () => {
      const saved = await upload('logo', pixel, 'image/png');
      logoUrl = saved.logoUrl;
      assert.match(logoUrl, /^\/api\/site-assets\/[a-f0-9]{32}\.webp$/);
      assert.equal(saved.siteName, '花园名称');
      const media = await request(null, 'GET', logoUrl);
      assert.equal(media.statusCode, 200); assert.equal(media.headers['content-type'], 'image/webp');
      assert.equal(media.headers['x-content-type-options'], 'nosniff');
      assert.equal(media.headers['cache-control'], 'public, max-age=31536000, immutable');
      const metadata = await sharp(media.rawPayload).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 12); assert.equal(metadata.height, 8); assert.equal(metadata.hasAlpha, true);
      assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
      assert.equal((await pool.query('SELECT count(*) AS count FROM site_assets')).rows[0].count, 1);
    });
    await t.test('favicon and background uploads decode JPEG/WebP, resize and remove metadata', async () => {
      const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#639761' } }).withExif({ IFD0: { Copyright: 'DO_NOT_PUBLISH_EXIF' } }).jpeg().toBuffer();
      const savedIcon = await upload('favicon', jpeg, 'image/jpeg'); faviconUrl = savedIcon.faviconUrl;
      assert.equal(savedIcon.logoUrl, logoUrl);
      assert.match(faviconUrl, /\.png$/);
      const iconResponse = await request(null, 'GET', faviconUrl);
      const icon = await sharp(iconResponse.rawPayload).metadata();
      assert.equal(icon.format, 'png'); assert.equal(icon.width, 256); assert.equal(icon.height, 192); assert.equal(icon.exif, undefined);
      assert.equal(iconResponse.rawPayload.includes(Buffer.from('DO_NOT_PUBLISH_EXIF')), false);
      const webp = await sharp({ create: { width: 2800, height: 1800, channels: 3, background: '#305538' } }).webp().toBuffer();
      const background = await upload('garden-background', webp, 'image/webp'); backgroundUrl = background.gardenBackgroundUrl;
      assert.equal(background.faviconUrl, faviconUrl); assert.equal(background.logoUrl, logoUrl);
      const backgroundMedia = await request(null, 'GET', backgroundUrl);
      const decoded = await sharp(backgroundMedia.rawPayload).metadata();
      assert.equal(decoded.width, 2560); assert.equal(decoded.height, 1646); assert.equal(decoded.format, 'webp');
    });
    await t.test('bad formats, oversized dimensions, malformed Base64 and corrupt pixels leave all settings and files intact', async () => {
      const state = await snapshot();
      const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#111111' } }).png().toBuffer();
      const tooManyPixels = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#111111' } }).png().toBuffer();
      const corrupt = Buffer.from(pixel); corrupt[corrupt.length - 20] ^= 255;
      for (const body of [
        { data: 'not-base64' }, { data: '' }, { data: pixel.toString('base64') + '\n' }, { data: 'data:image/png;base64,' + pixel.toString('base64') },
        { data: '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>' },
        { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), mimeType: 'image/png' },
        { data: pixel.toString('base64'), mimeType: 'image/jpeg' }, { data: pixel.toString('base64'), filename: '../../outside.png' },
        { data: huge.toString('base64') }, { data: tooManyPixels.toString('base64') }, { data: pixel.subarray(0, 32).toString('base64') }, { data: corrupt.toString('base64') },
        { data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
      ]) {
        const response = await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', body);
        assert.equal(response.statusCode, 400, response.body);
        assert.deepEqual(await snapshot(), state);
      }
      assert.equal((await request(adminJar, 'POST', '/api/admin/site-settings/assets/invalid', { data: pixel.toString('base64') })).statusCode, 400);
      const valid = await upload('logo', pixel); logoUrl = valid.logoUrl;
      assert.match(logoUrl, /\.webp$/, 'failed inputs must release the upload slot for the next request');
    });
    await t.test('animated WebP is rejected before decoding while static uploads remain usable', async () => {
      const state = await snapshot();
      const otherFrame = await sharp(pixel).flatten({ background: '#ffffff' }).tint('#d44923').png().toBuffer();
      const animation = await sharp([pixel, otherFrame], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
      assert.ok(animation.includes(Buffer.from('ANIM')));
      assert.equal((await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: animation.toString('base64') })).statusCode, 400);
      assert.deepEqual(await snapshot(), state);
    });
    await t.test('concurrent image processing returns 429 immediately and text changes preserve uploaded slots', async () => {
      holdAssetWrite = new Promise<void>(resolve => { releaseAssetWrite = resolve; });
      const entered = new Promise<void>(resolve => { enteredAssetWrite = resolve; });
      const uploading = request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') });
      await entered;
      const rejected = await request(adminJar, 'POST', '/api/admin/site-settings/assets/favicon', { data: pixel.toString('base64') });
      assert.equal(rejected.statusCode, 429); assert.equal(rejected.json().error.code, 'upload_busy');
      releaseAssetWrite!(); holdAssetWrite = undefined; enteredAssetWrite = undefined;
      const uploaded = await uploading; assert.equal(uploaded.statusCode, 200); logoUrl = uploaded.json().logoUrl;
      const [name, copy] = await Promise.all([patch({ siteName: '并发花园' }), patch({ footerText: '仍然保存的页脚' })]);
      const current = await get();
      assert.equal(current.siteName, '并发花园'); assert.equal(current.footerText, '仍然保存的页脚');
      assert.equal(current.logoUrl, logoUrl); assert.equal(current.faviconUrl, faviconUrl); assert.equal(current.gardenBackgroundUrl, backgroundUrl);
      assert.notEqual(name.updatedAt, copy.updatedAt);
    });
    await t.test('foreign image paths are rejected and reset retains old published assets for restored backups', async () => {
      const current = await get();
      for (const bad of ['https://example.invalid/evil.svg', '//example.invalid/evil.png', '/etc/passwd', '/api/site-assets/' + 'f'.repeat(32) + '.webp', faviconUrl]) {
        assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', { logoUrl: bad })).statusCode, 400);
        assert.deepEqual(await get(), current);
      }
      assert.deepEqual(await patch({ logoUrl }), current, 'retaining the current slot URL is a harmless no-op');
      const files = (await readdir(uploads)).sort();
      const reset = await patch({ logoUrl: null });
      assert.equal(reset.logoUrl, null); assert.equal(reset.faviconUrl, faviconUrl); assert.equal(reset.gardenBackgroundUrl, backgroundUrl);
      assert.deepEqual((await readdir(uploads)).sort(), files);
      assert.equal((await request(null, 'GET', logoUrl)).statusCode, 200);
      assert.equal((await request(adminJar, 'PATCH', '/api/admin/site-settings', { logoUrl })).statusCode, 400, 'a past URL cannot overwrite a new slot selection');
    });
    await t.test('an audit/transaction failure removes only its new file and preserves committed configuration', async () => {
      const state = await snapshot(); failAudit = true;
      const response = await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') });
      failAudit = false;
      assert.equal(response.statusCode, 500);
      assert.deepEqual(await snapshot(), state);
      assert.equal((await request(null, 'GET', faviconUrl)).statusCode, 200);
    });
    await t.test('a role revoked between initial authentication and transaction acceptance cannot publish media', async () => {
      const state = await snapshot(); revokeActorAtGuard = true;
      const response = await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') });
      assert.equal(response.statusCode, 403); assert.equal(response.json().error.code, 'forbidden');
      assert.deepEqual(await snapshot(), state);
      assert.equal((await ok(adminJar, 'GET', '/api/me')).user.role, 'admin', 'the injected role change was rolled back with the rejected transaction');
    });
    await t.test('a lost COMMIT acknowledgement verifies acceptance and never deletes the newly committed picture', async () => {
      loseAssetCommitAcknowledgement = true;
      const saved = await upload('logo', pixel);
      logoUrl = saved.logoUrl;
      assert.match(logoUrl, /^\/api\/site-assets\/[a-f0-9]{32}\.webp$/);
      assert.equal((await request(null, 'GET', logoUrl)).statusCode, 200);
      assert.deepEqual(await get(), saved);
    });
    await t.test('path traversal and unmanaged files are inaccessible and are never deleted', async () => {
      const outside = join(directory, 'outside.txt'); await writeFile(outside, 'PRIVATE_SENTINEL');
      const unmanaged = 'f'.repeat(32) + '.png'; await writeFile(join(uploads, unmanaged), pixel);
      for (const path of ['/api/site-assets/..%2Foutside.txt', '/api/site-assets/%2e%2e%5coutside.txt', '/api/site-assets/not-an-image.svg', '/api/site-assets/' + unmanaged, '/api/site-assets/' + 'e'.repeat(32) + '.webp']) assert.equal((await request(null, 'GET', path)).statusCode, 404);
      await patch({ faviconUrl: null });
      assert.equal(await readFile(outside, 'utf8'), 'PRIVATE_SENTINEL');
      assert.deepEqual(await readFile(join(uploads, unmanaged)), pixel);
    });
    await t.test('restarting the API retains text, current images and historical media', async () => {
      const before = await get();
      await app.close();
      app = await buildApp({ pool: guardedPool, config, updateFetch: async () => Response.json({ sha: 'a'.repeat(40) }) });
      assert.deepEqual(await get(), before);
      assert.equal((await request(null, 'GET', backgroundUrl)).statusCode, 200);
      assert.equal((await request(null, 'GET', logoUrl)).statusCode, 200);
      const audits = (await ok(adminJar, 'GET', '/api/admin/audit')).items.filter((item: any) => item.action.startsWith('site-settings.'));
      assert.ok(audits.length > 0);
      assert.equal(JSON.stringify(audits).includes(pixel.toString('base64')), false, 'audit history records settings, not uploaded bodies');
    });
    await t.test('storage cap fails without files or configuration changes', async () => {
      await pool.query(`INSERT INTO site_assets(filename,slot,mime_type,byte_size,width,height)
        SELECT md5('capacity-fixture-' || number::text) || '.webp','logo','image/webp',1,1,1 FROM generate_series(1,1000) AS number`);
      const state = await snapshot();
      const response = await request(adminJar, 'POST', '/api/admin/site-settings/assets/logo', { data: pixel.toString('base64') });
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'asset_storage_full');
      assert.deepEqual(await snapshot(), state);
    });
  } finally {
    releaseAssetWrite?.();
    await app.close(); await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
