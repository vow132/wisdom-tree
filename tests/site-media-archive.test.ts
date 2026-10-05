import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { checkSiteAssetReferences, emptySiteAssetArchive, processSiteAssetArchive, SITE_ASSET_MAX_BYTES } from '../backend/src/site-media-archive.js';

const pngName = 'a'.repeat(32) + '.png', webpName = 'b'.repeat(32) + '.webp';
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#217845' } }).png().toBuffer();
const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#b7ca98' } }).webp().toBuffer();
type Entry = { name: string; data?: Buffer; type?: string; size?: number; link?: string; prefix?: string; badChecksum?: boolean };
function tar(entries: Entry[], end = true) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), data = entry.data || Buffer.alloc(0);
    const put = (value: string, offset: number, length: number) => header.write(value, offset, Math.min(value.length, length), 'ascii');
    put(entry.name, 0, 100); put('0000600\0', 100, 8); put('0001750\0', 108, 8); put('0001750\0', 116, 8);
    put((entry.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124, 12);
    put('00000000000\0', 136, 12); header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0);
    put(entry.link || '', 157, 100); put('ustar\0', 257, 6); put('00', 263, 2); put(entry.prefix || '', 345, 155);
    const sum = header.reduce((total, value) => total + value, 0) + (entry.badChecksum ? 1 : 0);
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const input = (data: Buffer) => Readable.from([gzipSync(data)]);

test('safe site media archives validate images, merge immutably and verify restored references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wisdom-media-tests-'));
  try {
    await t.test('BusyBox-style root and ordinary PNG/WebP files validate without disk extraction', async () => {
      const result = await processSiteAssetArchive(input(tar([{ name: './', type: '5' }, { name: './' + pngName, data: png }, { name: webpName, data: webp }])));
      assert.deepEqual(result, { files: 2, bytes: png.length + webp.length, added: 0 });
      assert.deepEqual(await readdir(directory), []);
    });
    await t.test('an empty legacy archive is valid', async () => {
      assert.deepEqual(await processSiteAssetArchive(input(tar([]))), { files: 0, bytes: 0, added: 0 });
      assert.deepEqual(await processSiteAssetArchive(Readable.from([emptySiteAssetArchive()])), { files: 0, bytes: 0, added: 0 });
    });
    await t.test('validation completes before adding files and preserves previously stored images', async () => {
      const live = join(directory, 'valid-merge'); await mkdir(live);
      const old = 'c'.repeat(32) + '.png'; await writeFile(join(live, old), png);
      const archive = tar([{ name: pngName, data: png }, { name: webpName, data: webp }]);
      assert.equal((await processSiteAssetArchive(input(archive), live)).added, 2);
      assert.equal((await processSiteAssetArchive(input(archive), live)).added, 0);
      assert.deepEqual(await readFile(join(live, old)), png);
      assert.deepEqual((await readdir(live)).sort(), [pngName, webpName, old].sort());
    });
    await t.test('a later unsafe member rejects the whole merge before any new image appears', async () => {
      const live = join(directory, 'bad-member'); await mkdir(live);
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }, { name: '../escape.png', data: png }])), live), /filename/);
      assert.deepEqual(await readdir(live), []);
      assert.equal((await readdir(directory)).includes('escape.png'), false);
    });
    await t.test('same filename with different content is refused before any other image is added', async () => {
      const live = join(directory, 'collision'); await mkdir(live); await writeFile(join(live, webpName), png);
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }, { name: webpName, data: webp }])), live), /different contents/);
      assert.deepEqual(await readdir(live), [webpName]); assert.deepEqual(await readFile(join(live, webpName)), png);
    });
    for (const name of ['../' + pngName, '/' + pngName, 'folder/' + pngName, '././' + pngName, 'A'.repeat(32) + '.png', 'd'.repeat(32) + '.svg', 'favicon.ico']) {
      await t.test('rejects unsafe filename ' + name, async () => {
        await assert.rejects(processSiteAssetArchive(input(tar([{ name, data: png }]))), /filename/);
      });
    }
    await t.test('symbolic links, hard links, devices, nested directories and PAX overrides are refused', async () => {
      for (const type of ['1', '2', '3', '4', '5', '6', 'x', 'g']) {
        await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, type, link: type === '1' || type === '2' ? '../outside' : '', data: Buffer.alloc(0) }]))));
      }
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, prefix: '../outside', data: png }]))), /header/);
    });
    await t.test('duplicate members and oversized image declarations are refused', async () => {
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }, { name: pngName, data: png }]))), /Duplicate/);
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, size: SITE_ASSET_MAX_BYTES + 1 }]))), /2 MiB/);
    });
    await t.test('invalid checksum, truncated tar, malformed gzip and concatenated nonzero data are refused', async () => {
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png, badChecksum: true }]))), /checksum/);
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }], false))), /Truncated/);
      const compressed = gzipSync(tar([{ name: pngName, data: png }]));
      await assert.rejects(processSiteAssetArchive(Readable.from([compressed.subarray(0, compressed.length - 4)])));
      const invalid = Buffer.from(compressed); invalid[invalid.length - 8] ^= 128;
      await assert.rejects(processSiteAssetArchive(Readable.from([invalid])));
      await assert.rejects(processSiteAssetArchive(input(Buffer.concat([tar([]), tar([{ name: pngName, data: png }])]))), /end marker/);
    });
    await t.test('damaged or mislabeled images and nonzero tar padding are refused', async () => {
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: webpName, data: png }]))), /type/);
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png.subarray(0, 40) }]))), /damaged/);
      const archive = tar([{ name: pngName, data: png }]); archive[512 + png.length] = 1;
      await assert.rejects(processSiteAssetArchive(input(archive)), /padding/);
    });
    await t.test('late gzip corruption leaves the live directory untouched and removes staging', async () => {
      const live = join(directory, 'bad-crc'); await mkdir(live);
      const compressed = gzipSync(tar([{ name: pngName, data: png }])); compressed[compressed.length - 8] ^= 128;
      await assert.rejects(processSiteAssetArchive(Readable.from([compressed]), live));
      assert.deepEqual(await readdir(live), []);
    });
    await t.test('existing hard-linked files are never treated as safe immutable images', async () => {
      const live = join(directory, 'hardlink'); await mkdir(live);
      const outside = join(directory, 'hardlink-target'); await writeFile(outside, png); await link(outside, join(live, pngName));
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }])), live), /Unsafe existing/);
      assert.deepEqual(await readFile(outside), png);
    });
    await t.test('existing symbolic-linked files are refused', async subtest => {
      const live = join(directory, 'symlink'); await mkdir(live); const outside = join(directory, 'symlink-target'); await writeFile(outside, png);
      try { await symlink(outside, join(live, pngName)); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EPERM') { subtest.skip('Windows did not grant symbolic-link creation; Linux CI covers this case.'); return; } throw cause; }
      await assert.rejects(processSiteAssetArchive(input(tar([{ name: pngName, data: png }])), live), /Unsafe existing/);
      assert.deepEqual(await readFile(outside), png);
    });
    await t.test('legacy databases need no upload archive while restored image metadata must have matching files', async () => {
      const old = { async query() { return { rows: [{ name: null }] }; } };
      assert.equal(await checkSiteAssetReferences(old, join(directory, 'missing')), 0);
      const fixture = (assets: any[]) => ({ async query(sql: string) { return { rows: sql.includes('to_regclass') ? [{ name: 'site_assets' }] : assets }; } });
      const live = join(directory, 'references'); await mkdir(live); await writeFile(join(live, pngName), png);
      assert.equal(await checkSiteAssetReferences(fixture([{ filename: pngName, byte_size: png.length }]), live), 1);
      await assert.rejects(checkSiteAssetReferences(fixture([{ filename: webpName, byte_size: webp.length }]), live), /keep the API stopped/);
      await assert.rejects(checkSiteAssetReferences(fixture([{ filename: pngName, byte_size: png.length + 1 }]), live), /mismatched/);
      await assert.rejects(checkSiteAssetReferences(fixture([{ filename: '../escape.png', byte_size: 12 }]), live), /metadata/);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backup and restore shell flows pair files, preserve legacy volumes and hold missing-reference restores offline', { timeout: 30000 }, async t => {
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const directory = await mkdtemp(join(tmpdir(), 'wisdom-media-shell-tests-'));
  const source = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
  const node = process.execPath.replaceAll('\\', '/');
  const emptyArchive = join(directory, 'empty.tar.gz'); await writeFile(emptyArchive, gzipSync(tar([])));
  const bashEnvironment = join(directory, 'stub.bash');
  await writeFile(bashEnvironment, `
flock() { test "\${STUB_LOCK_FAILURE:-0}" != 1; }
docker() {
  printf '%s\\n' "$*" >> "$STUB_LOG"
  case "$*" in
    *'volume ls '*) if test "\${STUB_VOLUME_EXISTS:-1}" = 1; then printf 'wisdom-test_site_uploads\\n'; fi; return ;;
    *'volume inspect '*) test "\${STUB_VOLUME_EXISTS:-1}" = 1; return ;;
    *'network inspect '*) return 0 ;;
    *'inspect --format {{.Image}}'*) printf 'sha256:%064d\\n' 1; return ;;
    *'com.docker.compose.project'*) printf 'wisdom-test\\n'; return ;;
    *'inspect --format {{.State.Running}}'*) printf 'true\\n'; return ;;
    *'inspect --format {{range .Config.Env}}'*) printf 'DATABASE_URL=postgresql://wisdom:disposable@db:5432/wisdom\\n'; return ;;
    *'ps --all --quiet api'*) printf '%064d\\n' 2; return ;;
    *'pg_dump '*) printf 'valid-stub-dump\\n'; return ;;
    *'pg_restore --file=/dev/null'*) cat >/dev/null; return ;;
    *'pg_restore -U wisdom'*) cat >/dev/null; test "\${STUB_DATABASE_FAILURE:-0}" != 1; return ;;
    *'dist/site-media-archive.js validate'*) "$TASK_NODE" --import "$TASK_TSX" "$TASK_CLI" validate; return ;;
    *'dist/site-media-archive.js merge'*) SITE_UPLOAD_DIR="$STUB_UPLOAD_DIR" "$TASK_NODE" --import "$TASK_TSX" "$TASK_CLI" merge; return ;;
    *'dist/site-media-archive.js empty'*) "$TASK_NODE" --import "$TASK_TSX" "$TASK_CLI" empty; return ;;
    *'dist/site-media-archive.js check-references'*) if test "\${STUB_REFERENCE_FAILURE:-0}" = 1; then printf 'missing restored image\\n' >&2; return 1; fi; printf '{"references":0}\\n'; return ;;
    *'--entrypoint tar '*) cat "$STUB_ARCHIVE"; return ;;
    *' stop api'*|*' start api'*) return 0 ;;
    *) printf 'Unexpected Docker stub invocation: %s\\n' "$*" >&2; return 9 ;;
  esac
}
`);
  const fixtures = async (name: string) => {
    const root = join(directory, name); await mkdir(root); await writeFile(join(root, 'compose.yml'), 'services: {}\n');
    const env = 'POSTGRES_PASSWORD=disposable\nAPI_KEY_ENCRYPTION_KEY=' + '0'.repeat(64) + '\n';
    await writeFile(join(root, '.env'), env); await writeFile(join(root, 'fixture.dump'), 'valid-stub-dump');
    await writeFile(join(root, 'fixture.env'), env); const log = join(root, 'docker.log'); await writeFile(log, '');
    return { root, log };
  };
  const run = (root: string, log: string, script: string, args: string[], overrides: Record<string, string> = {}) => spawnSync(shell, [source + 'scripts/' + script, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, BASH_ENV: bashEnvironment.replaceAll('\\', '/'), STUB_LOG: log.replaceAll('\\', '/'), TASK_NODE: node,
      TASK_CLI: source + 'backend/src/site-media-archive.ts', TASK_TSX: import.meta.resolve('tsx'), STUB_ARCHIVE: emptyArchive.replaceAll('\\', '/'), STUB_UPLOAD_DIR: join(root, 'uploads').replaceAll('\\', '/'), ...overrides },
  });
  try {
    await t.test('backup creates matching dump/config/uploads while a missing volume is never mounted', async () => {
      const { root, log } = await fixtures('backup');
      const result = run(root, log, 'backup.sh', ['backups'], { STUB_VOLUME_EXISTS: '0' });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const files = (await readdir(join(root, 'backups'))).sort(); assert.equal(files.length, 3);
      const base = files.find(file => file.endsWith('.dump'))!.slice(0, -5);
      assert.deepEqual(files, [base + '.dump', base + '.env', base + '.uploads.tar.gz'].sort());
      const calls = await readFile(log, 'utf8'); assert.ok(calls.includes(' stop api')); assert.ok(calls.includes(' start api'));
      assert.ok(calls.includes('site-media-archive.js empty')); assert.equal(calls.includes('--mount'), false);
      assert.deepEqual(await processSiteAssetArchive(Readable.from([await readFile(join(root, 'backups', base + '.uploads.tar.gz'))])), { files: 0, bytes: 0, added: 0 });
    });
    await t.test('legacy dump restores without creating a missing image volume and checks references before starting', async () => {
      const { root, log } = await fixtures('legacy');
      const result = run(root, log, 'restore.sh', ['fixture.dump', '--replace-database'], { STUB_VOLUME_EXISTS: '0' });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const calls = await readFile(log, 'utf8'); assert.equal(calls.includes('--mount'), false);
      assert.ok(calls.indexOf('check-references') < calls.indexOf(' start api'));
      assert.ok(result.stderr.includes('Legacy dump has no upload archive'));
    });
    await t.test('missing images after a committed database restore keep the API stopped', async () => {
      const { root, log } = await fixtures('missing-references');
      const result = run(root, log, 'restore.sh', ['fixture.dump', '--replace-database'], { STUB_REFERENCE_FAILURE: '1' });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      const calls = await readFile(log, 'utf8'); assert.ok(calls.includes(' stop api')); assert.equal(calls.includes(' start api'), false);
      assert.ok(result.stderr.includes('API remains stopped'));
    });
    await t.test('a failed database transaction restarts the original API and keeps its images', async () => {
      const { root, log } = await fixtures('database-failure');
      const original = join(root, 'uploads'); await mkdir(original); await writeFile(join(original, pngName), png);
      await writeFile(join(root, 'fixture.uploads.tar.gz'), gzipSync(tar([{ name: webpName, data: webp }])));
      const result = run(root, log, 'restore.sh', ['fixture.dump', '--replace-database'], { STUB_DATABASE_FAILURE: '1' });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      const calls = await readFile(log, 'utf8'); assert.ok(calls.includes('merge')); assert.ok(calls.includes(' start api'));
      assert.deepEqual(await readFile(join(original, pngName)), png); assert.deepEqual(await readFile(join(original, webpName)), webp);
    });
    await t.test('damaged media fails read-only validation before stopping API or replacing the database', async () => {
      const { root, log } = await fixtures('damaged-archive'); await writeFile(join(root, 'fixture.uploads.tar.gz'), 'invalid-gzip');
      const result = run(root, log, 'restore.sh', ['fixture.dump', '--replace-database']);
      assert.notEqual(result.status, 0);
      const calls = await readFile(log, 'utf8'); assert.equal(calls.includes(' stop api'), false); assert.equal(calls.includes('pg_restore -U wisdom'), false);
    });
    await t.test('an existing deployment lock blocks maintenance before Docker is touched', async () => {
      const { root, log } = await fixtures('locked');
      const result = run(root, log, 'backup.sh', ['backups'], { STUB_LOCK_FAILURE: '1' });
      assert.equal(result.status, 1); assert.equal(await readFile(log, 'utf8'), '');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
