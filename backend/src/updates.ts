import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Services } from './services.js';
import type { ClientLike, UserRow } from './types.js';
import { transaction } from './db.js';
import { fail, record } from './security.js';

const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const JOB_LEASE_MS = 2 * 60 * 60_000;
const AAD = Buffer.from('wisdom-tree:repository-update-token:v1');
type SettingsRow = { enabled: boolean; token_ciphertext: string | null };
type Job = { id: string; target_sha: string; status: string; run_id: string | null; run_url: string | null; expires_at: Date };
type Latest = { sha: string | null; checkedAt: string; unavailable: boolean };
export type UpdateStatus = {
  repositoryUrl: string; currentVersion: string | null; latestVersion: string | null;
  updateAvailable: boolean; phase: 'current' | 'available' | 'unknown' | 'running';
  canUpdate: boolean; checkedAt: string; runUrl?: string; message?: string;
};
function encryptToken(value: string, masterKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
function decryptToken(value: string, masterKey: string) {
  try {
    const [version, iv, tag, body, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !body || extra !== undefined) throw new Error('Invalid ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), Buffer.from(iv, 'base64url'));
    cipher.setAAD(AAD);
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
  } catch { fail(400, 'update_token_unavailable', '更新凭据无法解密，请重新填写仓库专用 Token。'); }
}

class RepositoryUpdater {
  private latestCache: Latest | undefined;
  private latestPromise: Promise<Latest> | undefined;
  private jobCheckedAt = 0;
  private jobCheck: Promise<void> | undefined;
  readonly repositoryUrl: string;
  private readonly apiRoot: string;
  constructor(private services: Services, private fetcher: typeof fetch) {
    this.repositoryUrl = 'https://github.com/' + services.config.updateRepository;
    this.apiRoot = 'https://api.github.com/repos/' + services.config.updateRepository;
  }
  private async github(path: string, options: RequestInit = {}, token?: string) {
    return this.fetcher(this.apiRoot + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WisdomTree-Updater', 'X-GitHub-Api-Version': '2026-03-10',
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } });
  }
  settings(row: SettingsRow) {
    return { enabled: row.enabled, tokenConfigured: !!row.token_ciphertext, repositoryUrl: this.repositoryUrl, branch: this.services.config.updateBranch };
  }
  async readSettings() { return (await this.services.pool.query<SettingsRow>('SELECT enabled,token_ciphertext FROM system_update_settings WHERE id=true')).rows[0]; }
  async latest(force = false): Promise<Latest> {
    if (!force && this.latestCache && Date.now() - Date.parse(this.latestCache.checkedAt) < (this.latestCache.unavailable ? FAILURE_CACHE_MS : CACHE_MS)) return this.latestCache;
    if (this.latestPromise) return this.latestPromise;
    this.latestPromise = (async () => {
      const checkedAt = new Date().toISOString();
      try {
        const response = await this.github('/commits/' + encodeURIComponent(this.services.config.updateBranch));
        if (!response.ok) throw new Error('Repository unavailable');
        const body = await response.json() as any;
        if (!/^[a-f0-9]{40}$/.test(body.sha)) throw new Error('Invalid version');
        return this.latestCache = { sha: body.sha, checkedAt, unavailable: false };
      } catch { return this.latestCache = { sha: null, checkedAt, unavailable: true }; }
    })();
    try { return await this.latestPromise; } finally { this.latestPromise = undefined; }
  }
  private async settleJobs() {
    const current = this.services.config.appVersion;
    await this.services.pool.query(`UPDATE system_update_jobs SET status='finished',updated_at=now()
      WHERE status IN ('dispatching','submitted') AND target_sha=$1`, [current]);
    // This check runs only during a user-initiated status read, at most once per
    // minute across visitors. No timer, worker or browser polling is scheduled.
    if (this.jobCheck) return this.jobCheck;
    if (Date.now() - this.jobCheckedAt < 60_000) return;
    this.jobCheckedAt = Date.now();
    this.jobCheck = (async () => {
      const job = (await this.services.pool.query<Job>(`SELECT * FROM system_update_jobs WHERE status IN ('dispatching','submitted') LIMIT 1`)).rows[0];
      if (!job) return;
      const settings = await this.readSettings();
      if (!settings.token_ciphertext) return;
      try {
        const token = decryptToken(settings.token_ciphertext, this.services.config.apiKeyEncryptionKey);
        const response = await this.github(job.run_id ? '/actions/runs/' + encodeURIComponent(job.run_id)
          : '/actions/workflows/cd.yml/runs?event=workflow_dispatch&head_sha=' + encodeURIComponent(job.target_sha) + '&per_page=100', {}, token);
        if (!response.ok) return;
        const body = await response.json() as any;
        const run = job.run_id ? body : Array.isArray(body.workflow_runs) ? body.workflow_runs.find((item: any) =>
          item?.head_sha === job.target_sha && item.event === 'workflow_dispatch'
          && typeof item.display_title === 'string'
          && new RegExp('(^|[^a-fA-F0-9-])' + job.id + '($|[^a-fA-F0-9-])').test(item.display_title)
          && Number.isSafeInteger(item.id) && item.id > 0) : undefined;
        if (!run) return;
        const runId = job.run_id || String(run.id);
        const runUrl = this.repositoryUrl + '/actions/runs/' + runId;
        if (run.status === 'completed') {
          await this.services.pool.query(`UPDATE system_update_jobs SET status=$2,run_id=$3,run_url=$4,updated_at=now()
            WHERE id=$1 AND status IN ('dispatching','submitted')`, [job.id, job.target_sha === this.services.config.appVersion ? 'finished' : 'failed', runId, runUrl]);
        } else if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) {
          await this.services.pool.query(`UPDATE system_update_jobs SET status='submitted',run_id=$2,run_url=$3,expires_at=$4,updated_at=now()
            WHERE id=$1 AND status IN ('dispatching','submitted')`, [job.id, runId, runUrl, new Date(Date.now() + JOB_LEASE_MS)]);
        }
      } catch { /* Preserve the pending job through transient network failures. */ }
    })();
    try { await this.jobCheck; } finally { this.jobCheck = undefined; }
  }
  async status(force = false): Promise<UpdateStatus> {
    const [latest, settings] = await Promise.all([this.latest(force), this.readSettings()]);
    await this.settleJobs();
    const job = (await this.services.pool.query<Job>(`SELECT * FROM system_update_jobs WHERE status IN ('dispatching','submitted') LIMIT 1`)).rows[0];
    const current = this.services.config.appVersion || null;
    const available = !!current && !!latest.sha && current !== latest.sha;
    const phase = job ? 'running' : latest.unavailable || !current ? 'unknown' : available ? 'available' : 'current';
    return { repositoryUrl: this.repositoryUrl, currentVersion: current, latestVersion: latest.sha, updateAvailable: available,
      phase, canUpdate: settings.enabled && !!settings.token_ciphertext, checkedAt: latest.checkedAt,
      ...(job ? { runUrl: this.repositoryUrl + (job.run_id ? '/actions/runs/' + encodeURIComponent(job.run_id) : '/actions/workflows/cd.yml') } : {}),
      ...(phase === 'unknown' ? { message: current ? '暂时无法检查 GitHub 更新，请在一分钟后手动重试。' : '此部署未提供版本号，暂时无法比较更新。' }
        : phase === 'running' ? { message: job?.run_id ? '更新已提交到 GitHub Actions；测试通过后自动备份并部署，可打开进度查看。'
          : '更新提交结果尚未确认；请打开 GitHub Actions 检查执行记录，确认前将保留此次请求，避免重复部署。' } : {}) };
  }
  async adminGuard(db: ClientLike, actor: UserRow) {
    await db.query('SELECT id FROM admin_guard WHERE id=true FOR UPDATE');
    const current = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [actor.id])).rows[0];
    if (!current || current.role !== 'admin' || current.status !== 'active') fail(403, 'forbidden', '管理员权限已失效。');
  }
  async configure(actor: UserRow, value: unknown) {
    const body = record(value);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'invalid_request', '开启状态必须是布尔值。');
    if (body.clearToken !== undefined && typeof body.clearToken !== 'boolean') fail(400, 'invalid_request', '清除凭据状态必须是布尔值。');
    if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 4096 || /[\r\n\0]/.test(body.token))) fail(400, 'invalid_request', 'Token 应为单行文本。');
    const replacing = typeof body.token === 'string' && !!body.token.trim();
    if (body.clearToken && replacing) fail(400, 'invalid_request', '不能同时填写并清除 Token。');
    const result = await transaction(this.services.pool, async db => {
      await this.adminGuard(db, actor);
      const row = (await db.query<SettingsRow>('SELECT enabled,token_ciphertext FROM system_update_settings WHERE id=true FOR UPDATE')).rows[0];
      const before = this.settings(row);
      const enabled = body.enabled ?? row.enabled;
      const encrypted = body.clearToken ? null : replacing ? encryptToken(body.token.trim(), this.services.config.apiKeyEncryptionKey) : row.token_ciphertext;
      if (enabled && !encrypted) fail(400, 'update_token_required', '开启一键更新前，请填写本仓库专用的 GitHub Token。');
      await db.query('UPDATE system_update_settings SET enabled=$1,token_ciphertext=$2,updated_at=now() WHERE id=true', [enabled, encrypted]);
      const item = this.settings({ enabled, token_ciphertext: encrypted });
      await this.services.audit(db, actor, 'update.configure', this.services.config.updateRepository, '管理员操作', before, item);
      return item;
    });
    return result;
  }
  async dispatch(actor: UserRow, value: unknown): Promise<UpdateStatus> {
    const body = record(value);
    if (typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{40}$/.test(body.expectedVersion)) fail(400, 'invalid_request', '请提供待更新的完整版本号。');
    await this.settleJobs();
    const existing = (await this.services.pool.query<Job>(`SELECT * FROM system_update_jobs WHERE status IN ('dispatching','submitted') LIMIT 1`)).rows[0];
    if (existing) {
      if (existing.target_sha !== body.expectedVersion) fail(409, 'update_in_progress', '已有更新正在执行或等待确认，请先查看 GitHub Actions 更新进度。');
      return this.status();
    }
    const latest = await this.latest(true);
    if (!latest.sha) fail(400, 'update_check_unavailable', '暂时无法检查 GitHub 更新，请在一分钟后手动重试。');
    const targetSha = latest.sha;
    if (latest.sha !== body.expectedVersion) fail(409, 'update_version_changed', '仓库版本已改变，请重新检查后更新。');
    if (!this.services.config.appVersion) fail(409, 'update_version_unknown', '服务器未提供当前版本，不能执行一键更新。');
    if (latest.sha === this.services.config.appVersion) return this.status();
    const accepted = await transaction(this.services.pool, async db => {
      await this.adminGuard(db, actor);
      const settings = (await db.query<SettingsRow>('SELECT enabled,token_ciphertext FROM system_update_settings WHERE id=true FOR UPDATE')).rows[0];
      if (!settings.enabled || !settings.token_ciphertext) fail(400, 'update_not_configured', '请先在管理 → 网站设置 → 网站更新配置专用 Token 并开启更新。');
      const pending = (await db.query<Job>(`SELECT * FROM system_update_jobs WHERE status IN ('dispatching','submitted') LIMIT 1`)).rows[0];
      if (pending) {
        if (pending.target_sha !== targetSha) fail(409, 'update_in_progress', '已有更新正在执行，请先查看更新进度。');
        return { jobId: pending.id, token: null };
      }
      const token = decryptToken(settings.token_ciphertext, this.services.config.apiKeyEncryptionKey);
      const jobId = randomUUID();
      await db.query(`INSERT INTO system_update_jobs(id,actor_id,target_sha,status,expires_at) VALUES($1,$2,$3,'dispatching',$4)`, [jobId, actor.id, targetSha, new Date(Date.now() + JOB_LEASE_MS)]);
      await this.services.audit(db, actor, 'update.request', targetSha, '管理员操作', { currentVersion: this.services.config.appVersion }, { targetVersion: targetSha, jobId });
      return { jobId, token };
    });
    if (!accepted.token) return this.status();
    let rejected = false;
    try {
      const response = await this.github('/actions/workflows/cd.yml/dispatches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: this.services.config.updateBranch, inputs: { deploy: true, expected_sha: targetSha, expected_origin: this.services.config.publicOrigin, update_request_id: accepted.jobId } }),
      }, accepted.token);
      if (![200, 201, 204].includes(response.status)) { rejected = true; throw new Error('Dispatch refused'); }
      const run = response.status === 204 ? {} : await response.json().catch(() => ({})) as any;
      const runId = typeof run.workflow_run_id === 'number' && Number.isSafeInteger(run.workflow_run_id) && run.workflow_run_id > 0 ? String(run.workflow_run_id) : null;
      const runUrl = runId ? this.repositoryUrl + '/actions/runs/' + runId : this.repositoryUrl + '/actions/workflows/cd.yml';
      await this.services.pool.query(`UPDATE system_update_jobs SET status='submitted',run_id=$2,run_url=$3,updated_at=now() WHERE id=$1 AND status IN ('dispatching','submitted')`, [accepted.jobId, runId, runUrl]);
      return { ...await this.status(), phase: 'running', runUrl, message: '更新已提交；GitHub Actions 会完成测试、备份和部署。请打开更新进度查看，完成后刷新页面。' };
    } catch {
      if (rejected) {
        await this.services.pool.query(`UPDATE system_update_jobs SET status='failed',updated_at=now() WHERE id=$1 AND status IN ('dispatching','submitted')`, [accepted.jobId]);
        fail(400, 'update_dispatch_failed', 'GitHub 未接受更新请求，请检查仓库专用 Token 的 Actions 读写权限和工作流配置后重试。');
      }
      // A timeout can occur after GitHub accepted the POST. Keep the singleton
      // job pending rather than dispatching a second deployment on another click.
      const runUrl = this.repositoryUrl + '/actions/workflows/cd.yml';
      await this.services.pool.query(`UPDATE system_update_jobs SET status='submitted',run_url=$2,updated_at=now() WHERE id=$1 AND status IN ('dispatching','submitted')`, [accepted.jobId, runUrl]);
      return { ...await this.status(), phase: 'running', runUrl, message: '网络中断，暂时无法确认更新提交结果；请打开工作流进度查看，避免重复提交。' };
    }
  }
}

export async function registerUpdates(app: FastifyInstance, services: Services, fetcher: typeof fetch = fetch) {
  const updater = new RepositoryUpdater(services, fetcher);
  app.get('/api/system/update', () => updater.status());
  app.get('/api/admin/update/settings', async request => {
    await services.requireAdmin(request);
    return updater.settings(await updater.readSettings());
  });
  app.patch('/api/admin/update/settings', async request => updater.configure(await services.requireAdmin(request), request.body));
  app.post('/api/admin/update', async (request, reply) => {
    const result = await updater.dispatch(await services.requireAdmin(request), request.body);
    return reply.code(result.phase === 'running' ? 202 : 200).send(result);
  });
}
