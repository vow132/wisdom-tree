import { QueryClient } from '@tanstack/react-query';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'banned' | 'deleted';
  coins: number;
  fertilizer: number;
}
export interface Rules { dailyFertilizer: number; inventoryLimit: number; coinsPerFeed: number; growthPerFeed: number; apiRateLimit: number }
export interface Tree { seedClaimed: boolean; planted: boolean; height: number }
export interface State { user: User | null; tree: Tree | null; rules: Rules; daily: { date: string; claimed: number | boolean; remaining: number } | null; providers: { github: boolean; linuxdo: boolean }; reward?: number | { coins?: number; fertilizer?: number; growth?: number }; tip?: string; dialogue?: Dialogue }
export interface Model { id: string; displayName: string; coinsPerCall: number; enabled: boolean; replyText?: string; streamChunkChars?: number; streamDelayMs?: number; isWisdomTree?: boolean; replyCount?: number; ruleCount?: number }
export interface ModelReply { id: string; position: number; text: string }
export interface ModelRule { id: string; position: number; input: string; text: string; enabled: boolean }
export interface Dialogue { modelId: string; modelDisplayName: string; replyId: string | null; content: string; index: number; total: number; fallback?: boolean }
export interface ApiKey { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; key?: string | null; recoverable?: boolean }
export interface Identity { provider: string; providerUserId: string; displayName: string; createdAt: string }
export interface AdminUser extends User { identities: Identity[] }
export interface OAuthProviderConfig { provider: 'github' | 'linuxdo'; enabled: boolean; available: boolean; clientId: string; hasClientSecret: boolean; callbackUrl: string; source: 'database' | 'environment' | 'default' }
export interface Usage { id: string; modelId: string; coinsCharged: number; createdAt: string; endpoint: string; status: string; username?: string; userId?: string }
export interface Ledger { id: string; kind: string; coinsDelta: number; fertilizerDelta: number; reason: string; createdAt: string }
export interface Audit { id: string; actorId: string; actorName: string; action: string; targetId: string; reason: string; before: unknown; after: unknown; createdAt: string }
export interface Page<T> { items: T[]; total: number }
export interface UserDetail { user: User; tree: Tree | null; identities: Identity[]; keys: ApiKey[]; usage: Usage[]; ledger: Ledger[] }
export interface Stats { users: number; activeUsers: number; models: number; requests: number; coinsIssued: number; coinsSpent: number }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; idempotency?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotency) headers['Idempotency-Key'] = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(path, { method: options.method || 'GET', headers, credentials: 'same-origin', body: options.body !== undefined ? JSON.stringify(options.body) : undefined, signal: options.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', '连接服务失败，请检查网络后重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) void queryClient.invalidateQueries({ queryKey: ['me'] });
    throw new ApiError(response.status, data?.error?.code || 'REQUEST_FAILED', data?.error?.message || `请求失败（${response.status}），请稍后重试。`);
  }
  return data as T;
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false }, mutations: { retry: false } } });
export async function refreshState(state?: State, affected?: readonly string[]) {
  if (state?.rules && 'user' in state) {
    const previous = queryClient.getQueryData<State>(['me']);
    if (previous?.user?.id !== state.user?.id) queryClient.removeQueries({ predicate: query => !['me', 'site-settings'].includes(String(query.queryKey[0])) });
    queryClient.setQueryData(['me'], state);
    // The action response is authoritative. Update the scene without another GET.
    await queryClient.invalidateQueries({ predicate: query => !['me', 'site-settings'].includes(String(query.queryKey[0])), refetchType: 'none' });
    return;
  }
  await queryClient.invalidateQueries({ predicate: query => query.queryKey[0] !== 'site-settings' && (!affected || affected.includes(String(query.queryKey[0]))) });
}
export const time = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
export const number = (value: number | null | undefined) => new Intl.NumberFormat('zh-CN').format(value ?? 0);
export const signed = (value: number) => value > 0 ? `+${number(value)}` : number(value);
export const providerName = (value: string) => value === 'github' ? 'GitHub' : value === 'linuxdo' ? 'Linux DO' : value;
export const statusName = (value: string) => ({ active: '正常', banned: '已封禁', deleted: '已删除', completed: '完成', success: '成功', accepted: '已受理', failed: '失败' } as Record<string, string>)[value] || value;
