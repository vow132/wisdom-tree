import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Queryable, PoolLike } from './types.js';
import { fail, hash, record } from './security.js';

export type OAuthProvider = 'github' | 'linuxdo';
interface OAuthSettingsRow {
  provider: OAuthProvider; overridden: boolean; enabled: boolean; client_id: string;
  client_secret_ciphertext: string | null; revision: number | string;
}
export interface OAuthMetadata {
  provider: OAuthProvider; enabled: boolean; available: boolean; clientId: string;
  hasClientSecret: boolean; callbackUrl: string; source: 'database' | 'environment' | 'default';
}
export interface OAuthRuntime extends OAuthMetadata {
  clientSecret: string; authorizeUrl: string; tokenUrl: string; userUrl: string; fingerprint: string;
}

export function oauthProvider(value: unknown): OAuthProvider {
  if (value !== 'github' && value !== 'linuxdo') fail(404, 'not_found', '登录方式不存在。');
  return value;
}
// The authentication tag binds a stored secret to its purpose and provider, so it
// cannot be substituted with an API key ciphertext or another provider's secret.
function secretAAD(provider: OAuthProvider) { return Buffer.from(`wisdom-tree:oauth-client-secret:v1:${provider}`, 'utf8'); }
export function encryptOAuthSecret(value: string, masterKey: string, provider: OAuthProvider): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), iv, { authTagLength: 16 });
  cipher.setAAD(secretAAD(provider));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptOAuthSecret(value: string, masterKey: string, provider: OAuthProvider): string {
  try {
    const [version, iv, tag, encrypted, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined) throw new Error('Invalid OAuth secret');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(secretAAD(provider));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { fail(503, 'oauth_secret_decryption_failed', '第三方登录配置无法解密，请检查服务器的加密配置。'); }
}

export class OAuthSettings {
  constructor(private pool: PoolLike, private config: AppConfig) {}
  private environment(provider: OAuthProvider) {
    const c = this.config;
    return provider === 'github'
      ? { clientId: c.githubClientId, secret: c.githubClientSecret, authorizeUrl: c.githubAuthorizeUrl, tokenUrl: c.githubTokenUrl, userUrl: c.githubUserUrl }
      : { clientId: c.linuxdoClientId, secret: c.linuxdoClientSecret, authorizeUrl: c.linuxdoAuthorizeUrl, tokenUrl: c.linuxdoTokenUrl, userUrl: c.linuxdoUserUrl };
  }
  private metadata(row: OAuthSettingsRow): OAuthMetadata {
    const env = this.environment(row.provider);
    const clientId = row.overridden ? row.client_id : env.clientId;
    const hasClientSecret = row.overridden ? !!row.client_secret_ciphertext : !!env.secret;
    const enabled = row.overridden ? row.enabled : !!(env.clientId && env.secret);
    return { provider: row.provider, enabled, available: enabled && !!clientId && hasClientSecret, clientId, hasClientSecret,
      callbackUrl: `${this.config.publicOrigin}/api/auth/${row.provider}/callback`,
      source: row.overridden ? 'database' : env.clientId || env.secret ? 'environment' : 'default' };
  }
  private runtime(row: OAuthSettingsRow, includeSecret: boolean): OAuthRuntime {
    const env = this.environment(row.provider);
    const metadata = this.metadata(row);
    const storedSecret = row.overridden ? row.client_secret_ciphertext || '' : env.secret;
    const fingerprint = hash(JSON.stringify([row.provider, row.revision, row.overridden, metadata.enabled, metadata.clientId, storedSecret,
      metadata.callbackUrl, env.authorizeUrl, env.tokenUrl, env.userUrl]));
    return { ...metadata, clientSecret: includeSecret && metadata.available && storedSecret ? row.overridden ? decryptOAuthSecret(storedSecret, this.config.apiKeyEncryptionKey, row.provider) : storedSecret : '',
      authorizeUrl: env.authorizeUrl, tokenUrl: env.tokenUrl, userUrl: env.userUrl, fingerprint };
  }
  async list(db: Queryable = this.pool): Promise<OAuthMetadata[]> {
    const rows = (await db.query<OAuthSettingsRow>('SELECT * FROM oauth_provider_settings ORDER BY provider')).rows;
    return rows.map(row => this.metadata(row));
  }
  async providers(db: Queryable = this.pool) {
    const items = await this.list(db);
    return { github: items.some(item => item.provider === 'github' && item.available), linuxdo: items.some(item => item.provider === 'linuxdo' && item.available) };
  }
  async get(provider: OAuthProvider, db: Queryable = this.pool, lock = false, includeSecret = true): Promise<OAuthRuntime> {
    const row = (await db.query<OAuthSettingsRow>(`SELECT * FROM oauth_provider_settings WHERE provider=$1${lock ? ' FOR SHARE' : ''}`, [provider])).rows[0];
    if (!row) fail(503, 'provider_unavailable', '第三方登录配置尚未初始化。');
    return this.runtime(row, includeSecret);
  }
  async assertFlow(db: Queryable, provider: OAuthProvider, fingerprint: string): Promise<void> {
    const current = await this.get(provider, db, true, false);
    if (!current.available) fail(503, 'provider_unavailable', '此登录方式未开启或尚未配置。');
    if (!fingerprint || current.fingerprint !== fingerprint) fail(400, 'invalid_oauth_state', '登录配置已改变，请重新登录。');
  }
  async update(db: Queryable, provider: OAuthProvider, value: unknown): Promise<{ before: OAuthMetadata; item: OAuthMetadata; changed: boolean }> {
    const body = value === undefined ? {} : record(value);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'invalid_request', '开启状态必须是布尔值。');
    if (body.clearSecret !== undefined && typeof body.clearSecret !== 'boolean') fail(400, 'invalid_request', '清除密钥状态必须是布尔值。');
    if (body.clientId !== undefined && (typeof body.clientId !== 'string' || body.clientId.length > 512)) fail(400, 'invalid_request', 'Client ID 应为最多 512 个字符的文本。');
    if (body.clientSecret !== undefined && (typeof body.clientSecret !== 'string' || body.clientSecret.length > 4096)) fail(400, 'invalid_request', 'Client Secret 应为最多 4096 个字符的文本。');
    const replacingSecret = typeof body.clientSecret === 'string' && !!body.clientSecret.trim();
    if (body.clearSecret && replacingSecret) fail(400, 'invalid_request', '不能同时填写并清除 Client Secret。');
    const row = (await db.query<OAuthSettingsRow>('SELECT * FROM oauth_provider_settings WHERE provider=$1 FOR UPDATE', [provider])).rows[0];
    if (!row) fail(503, 'provider_unavailable', '第三方登录配置尚未初始化。');
    const before = this.metadata(row);
    if (body.enabled === undefined && body.clientId === undefined && !replacingSecret && !body.clearSecret) return { before, item: before, changed: false };
    const enabled = body.enabled ?? before.enabled;
    const clientId = body.clientId === undefined ? before.clientId : body.clientId.trim();
    let encrypted = row.client_secret_ciphertext;
    if (body.clearSecret) encrypted = null;
    else if (replacingSecret) encrypted = encryptOAuthSecret(body.clientSecret, this.config.apiKeyEncryptionKey, provider);
    else if (!row.overridden) {
      const envSecret = this.environment(provider).secret;
      encrypted = envSecret ? encryptOAuthSecret(envSecret, this.config.apiKeyEncryptionKey, provider) : null;
    }
    if (enabled && (!clientId || !encrypted)) fail(400, 'oauth_credentials_required', '开启此登录方式前，请填写 Client ID 和 Client Secret。');
    const changed = !row.overridden || row.enabled !== enabled || row.client_id !== clientId || row.client_secret_ciphertext !== encrypted;
    if (!changed) return { before, item: before, changed: false };
    const updated = (await db.query<OAuthSettingsRow>('UPDATE oauth_provider_settings SET overridden=true,enabled=$2,client_id=$3,client_secret_ciphertext=$4,revision=revision+1,updated_at=now() WHERE provider=$1 RETURNING *', [provider, enabled, clientId, encrypted])).rows[0];
    await db.query('DELETE FROM oauth_states WHERE provider=$1', [provider]);
    return { before, item: this.metadata(updated), changed: true };
  }
}
