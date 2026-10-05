import { createContext, useContext, useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { useMutation, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, refreshState, type State } from './api';

export type Notice = { kind: 'success' | 'error' | 'info'; message: string };
export const NoticeContext = createContext<(notice: Notice) => void>(() => {});
export function useNotice() { return useContext(NoticeContext); }
export function useAction<T>(fn: (input: T) => Promise<unknown>, success?: string, done?: (result: unknown) => void, affected?: readonly string[]) {
  const notify = useNotice();
  return useMutation({
    mutationFn: fn,
    onSuccess: async result => {
      const refresh = refreshState(result as State, affected);
      done?.(result);
      if (success) notify({ kind: 'success', message: success });
      await refresh;
    },
    onError: error => notify({ kind: 'error', message: error.message }),
  });
}
export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  const id = useId();
  return <label className="field"><span>{label}</span>{children}{help && <small id={id}>{help}</small>}</label>;
}
export function Button({ children, pending = false, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean; variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button {...props} disabled={props.disabled || pending} aria-busy={pending} className={`button ${variant} ${props.className || ''}`}>{pending ? '处理中…' : children}</button>;
}
export function ErrorMessage({ error, retry }: { error: Error; retry?: () => void }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return <div className="error-state" role="alert"><strong>{forbidden ? '没有访问权限' : '暂时无法读取'}</strong><p>{error.message}</p>{retry && !forbidden && <Button variant="secondary" onClick={retry}>重试</Button>}</div>;
}
export function QueryStatus({ query, children, empty }: { query: Pick<UseQueryResult<unknown, Error>, 'isPending' | 'error' | 'refetch'>; children: ReactNode; empty?: boolean }) {
  if (query.isPending) return <p className="loading" role="status">正在读取…</p>;
  if (query.error) return <ErrorMessage error={query.error} retry={() => void query.refetch()} />;
  if (empty) return <div className="empty-state">暂无记录。</div>;
  return children;
}
export function Pager({ page, total, setPage, pageSize = 20 }: { page: number; total: number; setPage: (page: number) => void; pageSize?: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pager"><span>共 {total} 条 · 第 {page} / {pages} 页</span><div><Button variant="quiet" onClick={() => setPage(page - 1)} disabled={page <= 1}>上一页</Button><Button variant="quiet" onClick={() => setPage(page + 1)} disabled={page >= pages}>下一页</Button></div></div>;
}
export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { ref.current?.close(); active?.focus(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-header"><h2 id={titleId}>{title}</h2><button className="close-button" aria-label="关闭对话框" onClick={onClose}>关闭</button></div>{children}</dialog>;
}
export function PanelTitle({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="panel-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const notify = useNotice();
  return <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(value); notify({ kind: 'success', message: '已复制到剪贴板。' }); } catch { notify({ kind: 'error', message: '浏览器未开放剪贴板权限，请选中文字复制。' }); } }}>{label}</Button>;
}
export function submitData(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }
export const textField = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export const numberField = (form: FormData, name: string) => Number(form.get(name) ?? 0);
