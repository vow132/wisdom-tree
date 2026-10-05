import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useNotice } from './ui';

export const repositoryUrl = 'https://github.com/vow132/wisdom-tree';
const capabilityEvent = 'wisdom-tree-update-capability';
export function updateCapabilityChanged(canUpdate: boolean) {
  window.dispatchEvent(new CustomEvent(capabilityEvent, { detail: { canUpdate } }));
}
export interface UpdateStatus {
  repositoryUrl: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  phase: 'current' | 'available' | 'unknown' | 'running';
  canUpdate: boolean;
  checkedAt: string | null;
  runUrl?: string;
  message?: string;
}
export function actionsProgressUrl(status: UpdateStatus | null): string | null {
  if (!status?.runUrl || !/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(status.repositoryUrl)) return null;
  try {
    const repository = new URL(status.repositoryUrl);
    const progress = new URL(status.runUrl);
    // Canonical equality rejects dot segments in the configured repository;
    // the prefix also confines links to this deployment's own Actions pages.
    return repository.href === status.repositoryUrl && progress.href.startsWith(`${repository.href}/actions/`)
      ? progress.href : null;
  } catch { return null; }
}

function GitHubIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.09c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.69.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.12-1.25-5.12-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.09 1.16A10.77 10.77 0 0 1 12 6.2c.96 0 1.92.13 2.81.38 2.15-1.46 3.09-1.16 3.09-1.16.62 1.55.23 2.69.12 2.98.72.79 1.15 1.79 1.15 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" /></svg>;
}

export default function RepositoryStatus({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const initial = useRef<Promise<UpdateStatus> | null>(null);
  const actionPending = useRef(false);
  const notify = useNotice();
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    // Sharing this promise also deduplicates React StrictMode's effect replay.
    // No query invalidations, focus events or timers recheck GitHub in the background.
    initial.current ??= api<UpdateStatus>('/api/system/update', { signal: AbortSignal.timeout(20_000) });
    void initial.current.then(result => { if (mounted) setStatus(result); }, error => {
      if (mounted) setFailure(error instanceof Error ? error.message : '暂时无法检查版本。');
    }).finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    const changed = (event: Event) => {
      const canUpdate = (event as CustomEvent<{ canUpdate?: unknown }>).detail?.canUpdate;
      if (typeof canUpdate === 'boolean') setStatus(previous => previous ? { ...previous, canUpdate } : previous);
    };
    window.addEventListener(capabilityEvent, changed);
    return () => window.removeEventListener(capabilityEvent, changed);
  }, []);

  const label = busy ? '正在检查版本' : failure || status?.phase === 'unknown' ? '版本检查失败，点击重试'
    : status?.phase === 'running' ? '更新已启动，点击重新检查进度'
      : status?.updateAvailable ? isAdmin ? '发现新版本，点击自动更新' : '发现新版本，由管理员更新'
        : '已是最新版本，点击重新检查';
  const phase = busy ? 'checking' : failure || !status ? 'unknown' : status.phase;

  const act = async () => {
    if (actionPending.current || busy) return;
    if (!failure && status?.updateAvailable && status.phase !== 'running') {
      if (!isAdmin) { notify({ kind: 'info', message: '发现新版本，请联系管理员更新。' }); return; }
      if (!status.canUpdate) {
        notify({ kind: 'info', message: '请先在管理后台的网站设置中配置一键更新凭据。' });
        navigate('/admin/site#website-update');
        return;
      }
    }
    actionPending.current = true;
    setBusy(true);
    try {
      const updating = !failure && status?.updateAvailable && status.phase !== 'running' && isAdmin;
      const result = updating
        ? await api<UpdateStatus>('/api/admin/update', { method: 'POST', body: { expectedVersion: status!.latestVersion }, idempotency: true, signal: AbortSignal.timeout(20_000) })
        : await api<UpdateStatus>('/api/system/update', { signal: AbortSignal.timeout(20_000) });
      setStatus(result);
      setFailure(null);
      notify({ kind: result.phase === 'unknown' ? 'error' : 'info', message: result.message || (result.phase === 'running' ? '更新已启动，可查看 GitHub 上的部署进度。完成后重新打开页面。' : result.updateAvailable ? '发现新版本。' : '当前已是最新版本。') });
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新检查失败，请稍后重试。';
      setFailure(message);
      notify({ kind: 'error', message });
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };

  const progressUrl = actionsProgressUrl(status);
  return <div className="repository-controls">
    <a className="repository-link" href={repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="打开智慧树 GitHub 仓库" title="GitHub · 智慧树仓库"><GitHubIcon /></a>
    <button type="button" className={`repository-update ${phase}`} aria-label={label} title={label} aria-busy={busy} disabled={busy} onClick={() => void act()}><span className="repository-dot" aria-hidden="true" /></button>
    {status?.phase === 'running' && progressUrl && <a className="repository-progress" href={progressUrl} target="_blank" rel="noopener noreferrer">查看更新进度</a>}
  </div>;
}
