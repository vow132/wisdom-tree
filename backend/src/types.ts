export interface QueryResult<T = any> { rows: T[]; rowCount: number | null }
export interface Queryable { query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> }
export interface ClientLike extends Queryable { release(): void }
export interface PoolLike extends Queryable { connect(): Promise<ClientLike>; end(): Promise<void> }

export interface Rules {
  dailyFertilizer: number;
  inventoryLimit: number;
  coinsPerFeed: number;
  growthPerFeed: number;
  apiRateLimit: number;
}
export interface UserRow {
  id: string; username: string; display_name: string; password_hash: string | null;
  role: 'user' | 'admin'; status: 'active' | 'banned' | 'deleted'; coins: string | number;
  fertilizer: number; created_at: Date | string;
}
export interface ModelRow {
  id: string; display_name: string; coins_per_call: number; enabled: boolean;
  reply_text: string; stream_chunk_chars: number; stream_delay_ms: number;
  deleted_at: Date | string | null; created_at: Date | string;
  is_wisdom_tree: boolean; reply_count?: string | number; rule_count?: string | number;
}
export interface ModelReplyRow {
  id: string; model_id: string; position: number; text: string;
}
export interface ModelReplyRuleRow {
  id: string; model_id: string; position: number; input: string; text: string; enabled: boolean;
}
export interface ModelDialogue {
  modelId: string; modelDisplayName: string; replyId: string | null;
  content: string; index: number; total: number; fallback: boolean;
  ruleId?: string;
}
