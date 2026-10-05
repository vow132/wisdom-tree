import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { transaction } from './db.js';
import { AppError, fail, record } from './security.js';
import type { Services } from './services.js';
import type { ClientLike, UserRow } from './types.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 8_000_000;
const MAX_ASSETS = 1000;
const MAX_STORED_BYTES = 1024 * 1024 * 1024;
let uploadBusy = false;
const FILENAME = /^[a-f0-9]{32}\.(png|webp)$/;
const slots = { logo: 'logo_filename', favicon: 'favicon_filename', 'garden-background': 'garden_background_filename' } as const;
type Slot = keyof typeof slots;
type Row = {
  site_name: string; browser_title: string; garden_subtitle: string; footer_text: string;
  logo_filename: string | null; favicon_filename: string | null; garden_background_filename: string | null; updated_at: Date | string;
};
export type SiteSettings = {
  siteName: string; browserTitle: string; gardenSubtitle: string; footerText: string;
  logoUrl: string | null; faviconUrl: string | null; gardenBackgroundUrl: string | null; updatedAt: string;
};
const textFields = { siteName: ['site_name', 60, 1], browserTitle: ['browser_title', 120, 1], gardenSubtitle: ['garden_subtitle', 200, 0], footerText: ['footer_text', 300, 0] } as const;
const imageFields = { logoUrl: 'logo_filename', faviconUrl: 'favicon_filename', gardenBackgroundUrl: 'garden_background_filename' } as const;
const publicUrl = (filename: string | null) => filename ? '/api/site-assets/' + filename : null;
function publicSettings(row: Row): SiteSettings {
  return {
    siteName: row.site_name, browserTitle: row.browser_title, gardenSubtitle: row.garden_subtitle, footerText: row.footer_text,
    logoUrl: publicUrl(row.logo_filename), faviconUrl: publicUrl(row.favicon_filename), gardenBackgroundUrl: publicUrl(row.garden_background_filename),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
function slotName(value: unknown): Slot {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(slots, value)) fail(400, 'invalid_request', '图片位置无效。');
  return value as Slot;
}
async function adminGuard(db: ClientLike, actor: UserRow) {
  await db.query('SELECT id FROM admin_guard WHERE id=true FOR UPDATE');
  const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [actor.id])).rows[0];
  if (!current || current.role !== 'admin' || current.status !== 'active') fail(403, 'forbidden', '管理员权限已失效。');
}
function rejectAnimation(input: Buffer, format: string) {
  if (format === 'png') {
    let offset = 8;
    while (offset < input.length) {
      if (offset + 12 > input.length) fail(400, 'invalid_image', '图片文件不完整。');
      const length = input.readUInt32BE(offset), end = offset + 12 + length;
      if (end > input.length) fail(400, 'invalid_image', '图片文件不完整。');
      const name = input.toString('ascii', offset + 4, offset + 8);
      if (name === 'acTL') fail(400, 'invalid_image', '请上传静态图片，暂不支持动画。');
      offset = end;
      if (name === 'IEND') break;
    }
  } else if (format === 'webp') {
    if (input.length < 20 || input.readUInt32LE(4) + 8 !== input.length) fail(400, 'invalid_image', '图片文件不完整。');
    let offset = 12;
    while (offset < input.length) {
      if (offset + 8 > input.length) fail(400, 'invalid_image', '图片文件不完整。');
      const name = input.toString('ascii', offset, offset + 4), length = input.readUInt32LE(offset + 4);
      if (name === 'ANIM' || name === 'ANMF') fail(400, 'invalid_image', '请上传静态图片，暂不支持动画。');
      offset += 8 + length + (length % 2);
      if (offset > input.length) fail(400, 'invalid_image', '图片文件不完整。');
    }
  }
}
async function imageData(value: unknown, slot: Slot) {
  const body = record(value);
  if (Object.keys(body).some(key => key !== 'data' && key !== 'mimeType')) fail(400, 'invalid_request', '图片请求包含不支持的字段。');
  if (typeof body.data !== 'string' || !body.data || body.data.length > 4 * Math.ceil(MAX_INPUT_BYTES / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) fail(400, 'invalid_image', '图片须为不超过 2 MB 的完整 Base64 数据。');
  const input = Buffer.from(body.data, 'base64');
  if (input.length > MAX_INPUT_BYTES || input.toString('base64') !== body.data) fail(400, 'invalid_image', '图片须为不超过 2 MB 的完整 Base64 数据。');
  const format = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : input.length > 3 && input[0] === 255 && input[1] === 216 && input[2] === 255 ? 'jpeg'
      : input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
  if (!format || (body.mimeType !== undefined && body.mimeType !== 'image/' + format)) fail(400, 'invalid_image', '仅支持静态 PNG、JPEG 或 WebP 图片，文件类型必须匹配。');
  rejectAnimation(input, format);
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096
      || metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages ?? 1) !== 1) fail(400, 'invalid_image', '图片边长不能超过 4096 像素，总像素不能超过 800 万，且须为静态图片。');
    const dimension = slot === 'favicon' ? 256 : slot === 'logo' ? 1024 : 2560;
    const resized = image.rotate().resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
    // Buffer output fully decodes and re-encodes the pixels. No source filename,
    // EXIF, comments, SVG or embedded input bytes are published.
    const { data, info } = await (slot === 'favicon' ? resized.png() : resized.webp({ quality: 90 })).toBuffer({ resolveWithObject: true });
    if (data.length > MAX_INPUT_BYTES) fail(400, 'invalid_image', '转换后的图片超过 2 MB，请缩小图片后重试。');
    return { data, width: info.width, height: info.height, mimeType: slot === 'favicon' ? 'image/png' : 'image/webp', extension: slot === 'favicon' ? 'png' : 'webp' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(400, 'invalid_image', '图片无法完整解码，请重新导出 PNG、JPEG 或 WebP 后上传。');
  }
}

export async function registerSiteSettings(app: FastifyInstance, services: Services) {
  sharp.concurrency(1);
  sharp.cache({ memory: 16, files: 0, items: 8 });
  const configuredRoot = resolve(services.config.siteUploadDir);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const directory = await realpath(configuredRoot);
  async function read() { return publicSettings((await services.pool.query<Row>('SELECT * FROM site_settings WHERE id=true')).rows[0]); }
  app.get('/api/site-settings', async () => read());
  app.get('/api/admin/site-settings', async request => { await services.requireAdmin(request); return read(); });
  app.patch('/api/admin/site-settings', async request => {
    const actor = await services.requireAdmin(request), body = record(request.body);
    if (Object.keys(body).some(key => !Object.prototype.hasOwnProperty.call(textFields, key) && !Object.prototype.hasOwnProperty.call(imageFields, key))) fail(400, 'invalid_request', '设置包含不支持的字段。');
    for (const [key, [, max, min]] of Object.entries(textFields)) {
      if (body[key] === undefined) continue;
      const multiline = key === 'gardenSubtitle' || key === 'footerText';
      if (multiline && typeof body[key] === 'string') body[key] = body[key].replace(/\r\n/g, '\n');
      const controls = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
      if (typeof body[key] !== 'string' || body[key].trim().length < min || body[key].length > max || controls.test(body[key])) fail(400, 'invalid_request', '网站文字长度或格式无效。');
    }
    return transaction(services.pool, async db => {
      await adminGuard(db, actor);
      const previous = (await db.query<Row>('SELECT * FROM site_settings WHERE id=true FOR UPDATE')).rows[0];
      const next = { ...previous };
      for (const [key, [column]] of Object.entries(textFields)) if (body[key] !== undefined) (next as any)[column] = body[key].trim();
      for (const [key, column] of Object.entries(imageFields)) {
        if (body[key] === undefined) continue;
        if (body[key] !== null && body[key] !== publicUrl(previous[column])) fail(400, 'invalid_image_url', '图片地址无效；请上传图片，或恢复默认图片。');
        if (body[key] === null) next[column] = null;
      }
      if (JSON.stringify(publicSettings(previous)) === JSON.stringify(publicSettings(next))) return publicSettings(previous);
      const row = (await db.query<Row>(`UPDATE site_settings SET site_name=$1,browser_title=$2,garden_subtitle=$3,footer_text=$4,
        logo_filename=$5,favicon_filename=$6,garden_background_filename=$7,
        updated_at=GREATEST(date_trunc('milliseconds',clock_timestamp()),updated_at + interval '1 millisecond') WHERE id=true RETURNING *`,
      [next.site_name, next.browser_title, next.garden_subtitle, next.footer_text, next.logo_filename, next.favicon_filename, next.garden_background_filename])).rows[0];
      const result = publicSettings(row);
      await services.audit(db, actor, 'site-settings.update', 'site', '管理员操作', publicSettings(previous), result);
      return result;
    });
  });
  const uploadOwners = new WeakMap<FastifyRequest, UserRow>();
  app.post('/api/admin/site-settings/assets/:slot', {
    bodyLimit: 3 * 1024 * 1024,
    onRequest: async request => {
      if (uploadBusy) fail(429, 'upload_busy', '另一个图片正在处理中，请稍后重试。');
      const actor = await services.requireAdmin(request);
      if (uploadBusy) fail(429, 'upload_busy', '另一个图片正在处理中，请稍后重试。');
      uploadOwners.set(request, actor);
    },
  }, async request => {
    if (uploadBusy) fail(429, 'upload_busy', '另一个图片正在处理中，请稍后重试。');
    uploadBusy = true;
    try {
      const slot = slotName((request.params as any).slot);
      const actor = uploadOwners.get(request)!;
      const image = await imageData(request.body, slot);
      const filename = randomBytes(16).toString('hex') + '.' + image.extension;
      const path = join(directory, filename);
      let wroteFile = false;
      try {
        return await transaction(services.pool, async db => {
          await adminGuard(db, actor);
          const previous = (await db.query<Row>('SELECT * FROM site_settings WHERE id=true FOR UPDATE')).rows[0];
          const usage = (await db.query('SELECT count(*) AS count,COALESCE(sum(byte_size),0) AS bytes FROM site_assets')).rows[0];
          if (Number(usage.count) >= MAX_ASSETS || Number(usage.bytes) + image.data.length > MAX_STORED_BYTES) fail(409, 'asset_storage_full', '图片存储已达 1000 张或 1 GB 上限，请联系服务器管理员清理历史备份后再上传。');
          const file = await open(path, 'wx', 0o600);
          wroteFile = true;
          try { await file.writeFile(image.data); await file.sync(); } finally { await file.close(); }
          await db.query('INSERT INTO site_assets(filename,slot,mime_type,byte_size,width,height) VALUES($1,$2,$3,$4,$5,$6)', [filename, slot, image.mimeType, image.data.length, image.width, image.height]);
          const row = (await db.query<Row>(`UPDATE site_settings SET ${slots[slot]}=$1,
            updated_at=GREATEST(date_trunc('milliseconds',clock_timestamp()),updated_at + interval '1 millisecond') WHERE id=true RETURNING *`, [filename])).rows[0];
          const settings = publicSettings(row);
          await services.audit(db, actor, 'site-settings.asset-upload', slot, '管理员操作', publicSettings(previous), settings);
          return settings;
        });
      } catch (error) {
        // A lost COMMIT acknowledgement can leave a committed reference. Remove
        // only a confirmed uncommitted file; an unavailable database preserves it
        // rather than risking a broken current picture or a restored backup.
        if (wroteFile) {
          let uncommitted = false;
          try {
            const committed = (await services.pool.query('SELECT filename FROM site_assets WHERE filename=$1', [filename])).rows.length > 0;
            if (committed) return await read();
            uncommitted = true;
          } catch { /* Keep an uncertain file. */ }
          if (uncommitted) await unlink(path).catch(() => {});
        }
        throw error;
      }
    } finally { uploadBusy = false; uploadOwners.delete(request); }
  });
  app.get('/api/site-assets/:filename', async (request, reply) => {
    const filename = (request.params as any).filename;
    if (typeof filename !== 'string' || !FILENAME.test(filename)) fail(404, 'not_found', '图片不存在。');
    const asset = (await services.pool.query('SELECT mime_type,byte_size FROM site_assets WHERE filename=$1', [filename])).rows[0];
    if (!asset) fail(404, 'not_found', '图片不存在。');
    let handle;
    try {
      handle = await open(join(directory, filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== Number(asset.byte_size) || stat.size > MAX_INPUT_BYTES) fail(404, 'not_found', '图片不存在。');
      const content = await handle.readFile();
      reply.header('Content-Type', asset.mime_type).header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'public, max-age=31536000, immutable').header('Content-Length', String(content.length));
      return content;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(404, 'not_found', '图片不存在。');
    } finally { await handle?.close(); }
  });
}
