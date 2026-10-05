import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';
import sharp from 'sharp';

export const SITE_ASSET_FILENAME = /^[a-f0-9]{32}\.(png|webp)$/;
export const SITE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const SITE_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_TAR_BYTES = SITE_ARCHIVE_MAX_BYTES + MAX_FILES * 1024 + 10240;

type ArchiveEntry = { filename: string; size: number; digest: string };
export type ArchiveResult = { files: number; bytes: number; added: number };
type Queryable = { query(sql: string): Promise<{ rows: any[] }> };
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function error(message: string): never { throw new Error(message); }

export function emptySiteAssetArchive(): Buffer {
  // BusyBox rejects creating an archive from an empty -T list. A conventional
  // root-directory entry plus end blocks is portable and needs no data volume.
  const header = Buffer.alloc(512);
  header.write('./', 0); header.write('0000700\0', 100); header.write('0001750\0', 108); header.write('0001750\0', 116);
  header.write('00000000000\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
  header[156] = 53; header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

class TarReader {
  private iterator: AsyncIterator<Buffer>;
  private chunk = Buffer.alloc(0);
  private offset = 0;
  private total = 0;
  constructor(stream: Readable) { this.iterator = stream[Symbol.asyncIterator](); }
  async read(size: number, allowEnd = false): Promise<Buffer | null> {
    const output = Buffer.alloc(size);
    let copied = 0;
    while (copied < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (allowEnd && copied === 0) return null;
          error('Truncated tar archive.');
        }
        this.chunk = Buffer.from(next.value); this.offset = 0;
        this.total += this.chunk.length;
        if (this.total > MAX_TAR_BYTES) error('Archive exceeds the decompressed size limit.');
      }
      const length = Math.min(size - copied, this.chunk.length - this.offset);
      this.chunk.copy(output, copied, this.offset, this.offset + length);
      this.offset += length; copied += length;
    }
    return output;
  }
  async finishZeroPadding() {
    for (;;) {
      if (this.offset < this.chunk.length && this.chunk.subarray(this.offset).some(byte => byte !== 0)) error('Unexpected data after the tar end marker.');
      const next = await this.iterator.next();
      if (next.done) return;
      this.chunk = Buffer.from(next.value); this.offset = 0;
      this.total += this.chunk.length;
      if (this.total > MAX_TAR_BYTES) error('Archive exceeds the decompressed size limit.');
    }
  }
}

function tarString(header: Buffer, start: number, length: number) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some(byte => byte !== 0 && byte !== 32)) error('Invalid tar string field.');
  const value = field.subarray(0, end === -1 ? field.length : end);
  if (value.some(byte => byte < 32 || byte > 126)) error('Invalid tar filename encoding.');
  return value.toString('ascii');
}
function octal(header: Buffer, start: number, length: number) {
  const value = header.subarray(start, start + length).toString('latin1');
  if (!/^[0-7\x00 ]+$/.test(value)) error('Invalid tar numeric field.');
  const trimmed = value.replace(/[\x00 ]/g, '');
  const number = trimmed ? Number.parseInt(trimmed, 8) : 0;
  if (!Number.isSafeInteger(number)) error('Invalid tar numeric size.');
  return number;
}
async function validateImage(filename: string, data: Buffer) {
  const format = filename.endsWith('.png') ? 'png' : 'webp';
  if (format === 'png' ? !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.length < 20 || data.readUInt32LE(4) + 8 !== data.length) error('Archive image type does not match its filename.');
  try {
    const image = sharp(data, { failOn: 'warning', limitInputPixels: 8_000_000, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096
      || metadata.width * metadata.height > 8_000_000 || (metadata.pages ?? 1) !== 1) error('Invalid archive image dimensions or animation.');
    // Decode the complete image; metadata alone does not detect damaged pixels.
    await image.raw().toBuffer();
  } catch { error('Archive contains an invalid or damaged image.'); }
}

async function existingFile(directory: string, filename: string): Promise<Buffer | null> {
  let handle;
  try {
    const path = join(directory, filename);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > SITE_ASSET_MAX_BYTES) error('Unsafe existing image file.');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size || opened.size > SITE_ASSET_MAX_BYTES) error('Unsafe existing image file.');
    return await handle.readFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  } finally { await handle?.close(); }
}

/** Validates the complete gzip/tar before optionally adding any immutable images. */
export async function processSiteAssetArchive(input: Readable, uploadDirectory?: string): Promise<ArchiveResult> {
  sharp.concurrency(1); sharp.cache({ memory: 16, files: 0, items: 8 });
  let directory: string | null = null;
  if (uploadDirectory) {
    await mkdir(resolve(uploadDirectory), { recursive: true, mode: 0o700 });
    directory = await realpath(resolve(uploadDirectory));
  }
  // Stage on the persistent disk, not a gigabyte tmpfs on a 2 GB server.
  const staging = directory ? await mkdtemp(join(directory, '.restore-')) : null;
  if (staging) await chmod(staging, 0o700);
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  const onInputError = (cause: Error) => gunzip.destroy(cause);
  input.on('error', onInputError); input.pipe(gunzip);
  const reader = new TarReader(gunzip);
  const entries: ArchiveEntry[] = []; const names = new Set<string>();
  let bytes = 0, directorySeen = false;
  try {
    for (;;) {
      const header = await reader.read(512);
      if (!header) error('Missing tar end marker.');
      if (header.every(byte => byte === 0)) {
        const end = await reader.read(512);
        if (!end?.every(byte => byte === 0)) error('Invalid tar end marker.');
        await reader.finishZeroPadding(); break;
      }
      const expected = octal(header, 148, 8);
      const actual = header.reduce((sum, byte, position) => sum + (position >= 148 && position < 156 ? 32 : byte), 0);
      if (expected !== actual) error('Invalid tar header checksum.');
      const name = tarString(header, 0, 100), prefix = tarString(header, 345, 155), link = tarString(header, 157, 100);
      const magic = tarString(header, 257, 6);
      if (prefix || link || (magic !== 'ustar' && magic !== 'ustar ' && magic !== '')) error('Unsupported tar header.');
      const type = header[156], size = octal(header, 124, 12);
      if (type === 53) {
        if (!['.', './'].includes(name) || size !== 0 || directorySeen) error('Only a single archive root directory is allowed.');
        directorySeen = true; continue;
      }
      if (type !== 0 && type !== 48) error('Only ordinary image files may be restored.');
      const filename = name.startsWith('./') ? name.slice(2) : name;
      if (!SITE_ASSET_FILENAME.test(filename)) error('Invalid archive image filename.');
      if (names.has(filename)) error('Duplicate archive image filename.');
      if (size <= 0 || size > SITE_ASSET_MAX_BYTES) error('An archive image exceeds the 2 MiB limit.');
      bytes += size;
      if (bytes > SITE_ARCHIVE_MAX_BYTES || entries.length >= MAX_FILES) error('Archive exceeds the total image storage limit.');
      names.add(filename);
      const data = (await reader.read(size))!;
      const padding = await reader.read((512 - size % 512) % 512);
      if (padding?.some(byte => byte !== 0)) error('Invalid tar image padding.');
      await validateImage(filename, data);
      entries.push({ filename, size, digest: digest(data) });
      if (staging) await writeFile(join(staging, filename), data, { flag: 'wx', mode: 0o600 });
    }
    let added = 0;
    if (staging && directory) {
      // Check all collisions before adding anything to the live directory.
      for (const entry of entries) {
        const current = await existingFile(directory, entry.filename);
        if (current && (current.length !== entry.size || digest(current) !== entry.digest)) error('An existing immutable image has different contents.');
      }
      for (const entry of entries) {
        if (await existingFile(directory, entry.filename)) continue;
        const data = await readFile(join(staging, entry.filename));
        try { await writeFile(join(directory, entry.filename), data, { flag: 'wx', mode: 0o600, flush: true }); added++; }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
          const current = await existingFile(directory, entry.filename);
          if (!current || current.length !== entry.size || digest(current) !== entry.digest) error('An existing immutable image has different contents.');
        }
      }
      if (added && process.platform !== 'win32') {
        const handle = await open(directory, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    return { files: entries.length, bytes, added };
  } finally {
    input.off('error', onInputError); input.destroy(); gunzip.destroy();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Old pre-settings databases have no upload references and remain restorable. */
export async function checkSiteAssetReferences(pool: Queryable, uploadDirectory: string): Promise<number> {
  const table = await pool.query("SELECT to_regclass('public.site_assets') AS name");
  if (!table.rows[0]?.name) return 0;
  const assets = await pool.query('SELECT filename,byte_size FROM site_assets');
  const directory = resolve(uploadDirectory);
  for (const asset of assets.rows) {
    if (!SITE_ASSET_FILENAME.test(asset.filename) || !Number.isSafeInteger(Number(asset.byte_size)) || Number(asset.byte_size) <= 0 || Number(asset.byte_size) > SITE_ASSET_MAX_BYTES) error('Invalid database image metadata.');
    const content = await existingFile(directory, asset.filename);
    if (!content || content.length !== Number(asset.byte_size)) error('Restored database references missing or mismatched images; keep the API stopped and restore the matching upload archive.');
  }
  return assets.rows.length;
}

async function main() {
  const [command, archive] = process.argv.slice(2);
  const uploadDirectory = process.env.SITE_UPLOAD_DIR || '/var/lib/wisdom-tree/uploads';
  if (command === 'empty' && !archive) {
    process.stdout.write(emptySiteAssetArchive());
  } else if (command === 'validate' || command === 'merge') {
    if (process.argv.length > 4) error('Usage: site-media-archive.js validate|merge [archive.tar.gz]; omitted archive reads stdin.');
    const input = archive ? createReadStream(archive) : process.stdin;
    console.log(JSON.stringify(await processSiteAssetArchive(input, command === 'merge' ? uploadDirectory : undefined)));
  } else if (command === 'check-references' && !archive) {
    const { getPool } = await import('./db.js');
    const pool = await getPool();
    try { console.log(JSON.stringify({ references: await checkSiteAssetReferences(pool, uploadDirectory) })); }
    finally { await pool.end(); }
  } else error('Usage: site-media-archive.js empty | validate|merge [archive.tar.gz] | check-references');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(cause => { console.error((cause as Error).message); process.exitCode = 1; });
}
