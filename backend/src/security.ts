import { randomBytes, scrypt, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new AppError(status, code, message); }
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

// Authentication still uses SHA-256. Encryption only enables the owner's key list.
export function encryptApiKey(value: string, masterKey: string, userId: string, keyId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${userId}:${keyId}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptApiKey(value: string, masterKey: string, userId: string, keyId: string): string {
  try {
    const [version, iv, tag, encrypted, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined) throw new Error('Invalid encrypted key');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`${userId}:${keyId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    fail(503, 'api_key_decryption_failed', '密钥无法解密，请检查服务器的密钥加密配置。');
  }
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, value) => error ? reject(error) : resolve(value)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = (encoded || '').split('$');
  const valid = parts.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  const salt = valid ? parts[1] : '00000000000000000000000000000000';
  const calculated = await derive(password, salt);
  const expected = Buffer.from(valid ? parts[2] : '0'.repeat(128), 'hex');
  return timingSafeEqual(calculated, expected) && valid;
}
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', '请求体必须是 JSON 对象。');
  return value as Record<string, any>;
}
export function text(value: unknown, label: string, max = 128, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(400, 'invalid_request', `${label}长度应为 ${min}–${max} 个字符。`);
  return value.trim();
}
export function username(value: unknown): string {
  const result = text(value, '账号', 40, 3).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(result)) fail(400, 'invalid_request', '账号仅支持英文字母、数字、下划线和短横线。');
  return result;
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) fail(400, 'invalid_request', '密码长度应为 8–128 个字符。');
  return value;
}
export function integer(value: unknown, label: string, min = 0, max = 1000000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'invalid_request', `${label}必须是 ${min}–${max} 的整数。`);
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail(400, 'invalid_request', '用户或记录 ID 无效。');
  return value;
}
export function pagination(query: any): { page: number; pageSize: number; offset: number } {
  const page = Number(query?.page ?? 1); const pageSize = Number(query?.pageSize ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail(400, 'invalid_request', '分页参数无效。');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
export function idempotencyKey(value: unknown, required = false): string | null {
  if (value === undefined) { if (required) fail(400, 'idempotency_key_required', '请提供 Idempotency-Key。'); return null; }
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value)) fail(400, 'invalid_request', 'Idempotency-Key 必须是 1–128 位可见字符。');
  return value;
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const dateShanghai = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
