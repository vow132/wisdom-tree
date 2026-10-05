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
    development: process.env.NODE_ENV !== 'production', apiKeyEncryptionKey: '', ...overrides,
  };
  merged.publicOrigin = new URL(merged.publicOrigin).origin;
  if (overrides.secureCookies === undefined && !process.env.COOKIE_SECURE) merged.secureCookies = merged.publicOrigin.startsWith('https://');
  merged.apiKeyEncryptionKey = loadApiKeyEncryptionKey(overrides.apiKeyEncryptionKey ?? process.env.API_KEY_ENCRYPTION_KEY, merged.development);
  return merged;
}
