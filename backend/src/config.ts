import './env.js';
import { loadApiKeyEncryptionKey } from './key-encryption.js';

export interface AppConfig {
  publicOrigin: string;
  secureCookies: boolean;
  sessionDays: number;
  githubClientId: string;
  githubClientSecret: string;
  linuxdoClientId: string;
  linuxdoClientSecret: string;
  githubAuthorizeUrl: string;
  githubTokenUrl: string;
  githubUserUrl: string;
  linuxdoAuthorizeUrl: string;
  linuxdoTokenUrl: string;
  linuxdoUserUrl: string;
  development: boolean;
  apiKeyEncryptionKey: string;
  appVersion: string;
  updateRepository: string;
  updateBranch: string;
}

export function readConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const publicOrigin = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
  const merged: AppConfig = {
    publicOrigin, secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : publicOrigin.startsWith('https://'), sessionDays: 7,
    githubClientId: process.env.GITHUB_CLIENT_ID || '', githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    linuxdoClientId: process.env.LINUXDO_CLIENT_ID || '', linuxdoClientSecret: process.env.LINUXDO_CLIENT_SECRET || '',
    githubAuthorizeUrl: 'https://github.com/login/oauth/authorize',
    githubTokenUrl: 'https://github.com/login/oauth/access_token', githubUserUrl: 'https://api.github.com/user',
    linuxdoAuthorizeUrl: 'https://connect.linux.do/oauth2/authorize',
    linuxdoTokenUrl: 'https://connect.linux.do/oauth2/token', linuxdoUserUrl: 'https://connect.linux.do/api/user',
    development: process.env.NODE_ENV !== 'production', apiKeyEncryptionKey: '',
    appVersion: process.env.APP_VERSION || '', updateRepository: process.env.UPDATE_REPOSITORY || 'vow132/wisdom-tree',
    updateBranch: process.env.UPDATE_BRANCH || 'codex/wisdom-tree', ...overrides,
  };
  merged.publicOrigin = new URL(merged.publicOrigin).origin;
  if (overrides.secureCookies === undefined && !process.env.COOKIE_SECURE) merged.secureCookies = merged.publicOrigin.startsWith('https://');
  merged.apiKeyEncryptionKey = loadApiKeyEncryptionKey(overrides.apiKeyEncryptionKey ?? process.env.API_KEY_ENCRYPTION_KEY, merged.development);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(merged.updateRepository) || merged.updateRepository.length > 200
    || !merged.updateBranch || merged.updateBranch.length > 200 || /[\s?#]/.test(merged.updateBranch)) throw new Error('Invalid update repository or branch.');
  if (!/^[a-f0-9]{40}$/.test(merged.appVersion)) merged.appVersion = '';
  return merged;
}
