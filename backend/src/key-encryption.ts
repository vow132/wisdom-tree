import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from './env.js';

const valid = (value: string) => /^[a-f0-9]{64}$/i.test(value);

export function loadApiKeyEncryptionKey(
  configured: string | undefined,
  development: boolean,
  path = join(PROJECT_ROOT, '.local', 'api-key-encryption.key'),
): string {
  if (configured) {
    if (!valid(configured)) throw new Error('API_KEY_ENCRYPTION_KEY 必须为 64 位十六进制字符。');
    return configured.toLowerCase();
  }
  if (!development) throw new Error('生产环境必须配置 API_KEY_ENCRYPTION_KEY，以持久保存可查看的 API Key。');
  const read = () => {
    const value = readFileSync(path, 'utf8').trim();
    if (!valid(value)) throw new Error('本地 API Key 加密主密钥文件无效，请恢复备份；不会自动覆盖已有文件。');
    return value.toLowerCase();
  };
  try { return read(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(error instanceof Error && error.message.startsWith('本地 API') ? error.message : '无法读取本地 API Key 加密主密钥文件，请检查权限。');
  }
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {
    throw new Error('无法创建本地 API Key 加密主密钥目录，请检查目录权限。');
  }
  // Publish a completely written inode without replacing a concurrent creator's key.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch {
    throw new Error('无法创建本地 API Key 加密主密钥文件，请检查目录权限。');
  } finally { try { unlinkSync(temporary); } catch {} }
  return read();
}
