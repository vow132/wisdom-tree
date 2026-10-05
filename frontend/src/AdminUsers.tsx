import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, number, queryClient, statusName, type AdminUser, type Page, type State } from './api';
import AdminIdentities from './AdminIdentities';
import { Button, Dialog, Field, Pager, PanelTitle, QueryStatus, submitData, textField, useAction, useNotice } from './ui';

export type UserAction = 'ban' | 'unban' | 'delete';
export interface UserOperation { action: UserAction; users: Pick<AdminUser, 'id' | 'username' | 'displayName'>[] }
export interface UserOperationResult { ok: true; action: UserAction; affected: number; ids: string[] }

const actionName: Record<UserAction, string> = { ban: '封禁', unban: '解封', delete: '彻底删除' };

export function clearCurrentSession() {
  // The server has already revoked this account's sessions. Remove private
  // cached data immediately instead of waiting for the next session response.
  void queryClient.cancelQueries({ queryKey: ['me'] });
  queryClient.setQueryData<State>(['me'], previous => previous ? { user: null, tree: null, daily: null, rules: previous.rules, providers: previous.providers } : previous);
  queryClient.removeQueries({ predicate: query => !['me', 'site-settings'].includes(String(query.queryKey[0])) });
}

export function clearRemovedSession(result: UserOperationResult, currentUserId: string) {
  if (result.action === 'unban' || !result.ids.includes(currentUserId)) return false;
  clearCurrentSession();
  return true;
}

export function UserActionDialog({ operation, currentUserId, pending, onCancel, onConfirm }: {
  operation: UserOperation;
  currentUserId: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { action, users } = operation;
  const includesSelf = action !== 'unban' && users.some(user => user.id === currentUserId);
  const label = actionName[action];
  return <Dialog title={`${users.length > 1 ? '批量' : ''}${label}用户`} onClose={onCancel} dismissible={!pending}>
    <p className="user-action-summary">{users.length === 1 ? <>即将{label}用户 <strong>{users[0].displayName || users[0].username}</strong>（{users[0].username}）。</> : <>即将{label}选中的 <strong>{users.length} 位用户</strong>。</>}</p>
    {users.length > 1 && <ul className="user-action-targets" aria-label="操作用户">{users.map(user => <li key={user.id}>{user.displayName || user.username}<span>（{user.username}）</span></li>)}</ul>}
    <p className={action === 'delete' ? 'user-action-warning' : 'user-action-note'}>{action === 'delete' ? '账户、智慧树、金币、肥料、第三方绑定、API 密钥、调用记录和收支账本将全部彻底移除，无法恢复。' : action === 'ban' ? '封禁后立即退出现有登录，阻止登录和 API 调用；账户数据会保留，可随时解封。' : '解封后可重新登录并使用 API，原有账户数据会保留。'}</p>
    {includesSelf && <p className="user-action-warning">包含你当前登录的账户。操作成功后，你将退出登录。</p>}
    <div className="dialog-actions"><Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>取消</Button><Button type="button" variant={action === 'unban' ? 'primary' : 'danger'} onClick={onConfirm} pending={pending}>{label}</Button></div>
  </Dialog>;
}

export default function Users({ currentUserId }: { currentUserId: string }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [operation, setOperation] = useState<UserOperation | null>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const notify = useNotice();
  const query = useQuery({ queryKey: ['admin', 'users', search, page], queryFn: ({ signal }) => api<Page<AdminUser>>(`/api/admin/users?search=${encodeURIComponent(search)}&page=${page}&pageSize=20`, { signal }) });
  const create = useAction<unknown>(body => api('/api/admin/users', { method: 'POST', body }), '用户已创建。', () => setCreateOpen(false));
  const batch = useAction<UserOperation>(input => api<UserOperationResult>('/api/admin/users/batch', { method: 'POST', body: { ids: input.users.map(user => user.id), action: input.action } }), undefined, value => {
    const result = value as UserOperationResult;
    setSelected(new Set());
    setOperation(null);
    notify({ kind: 'success', message: `已${actionName[result.action]} ${result.affected} 位用户。` });
    if (clearRemovedSession(result, currentUserId)) navigate('/', { replace: true });
  });
  const items = query.data?.items ?? [];
  const chosen = items.filter(user => selected.has(user.id));
  const allSelected = items.length > 0 && chosen.length === items.length;
  const locked = batch.isPending;
  const selectionDisabled = locked || query.isPending || query.isFetching || Boolean(query.error);

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = chosen.length > 0 && !allSelected;
  }, [chosen.length, allSelected]);
  useEffect(() => {
    if (!query.data || query.isFetching) return;
    const visible = new Set(query.data.items.map(user => user.id));
    setSelected(previous => {
      const next = new Set([...previous].filter(id => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
    const lastPage = Math.max(1, Math.ceil(query.data.total / 20));
    if (page > lastPage) { setSelected(new Set()); setPage(lastPage); }
  }, [query.data, query.isFetching, page]);

  const changePage = (next: number) => { if (!locked) { setSelected(new Set()); setPage(next); } };
  const ask = (action: UserAction, users: UserOperation['users']) => { if (!locked && users.length) setOperation({ action, users }); };
  const cancel = () => { if (!locked) setOperation(null); };
  return <section className="panel user-admin-panel">
    <PanelTitle title="用户管理" description="查看账户、树高与登录方式，支持封禁、解封和彻底删除。" action={<div className="button-row"><Button variant="secondary" disabled={locked || query.isFetching} onClick={() => void query.refetch()}>刷新列表</Button><Button disabled={locked} onClick={() => setCreateOpen(true)}>创建用户</Button></div>} />
    <form className="inline-form" onSubmit={event => { const form = submitData(event); if (!locked) { setSelected(new Set()); setSearch(textField(form, 'search')); setPage(1); } }}><Field label="搜索用户"><input name="search" placeholder="用户名或显示名称" type="search" disabled={locked} /></Field><Button variant="secondary" type="submit" disabled={locked}>搜索</Button></form>
    <div className="user-bulk-toolbar" aria-label="批量用户操作">
      <div className="user-selection-summary"><span role="status" aria-live="polite" aria-atomic="true">已选 <strong>{chosen.length}</strong> 位 · 仅当前页</span><Button variant="quiet" disabled={!chosen.length || locked} onClick={() => setSelected(new Set())}>清空选择</Button></div>
      <div className="button-row user-bulk-actions"><Button variant="secondary" disabled={!chosen.length || selectionDisabled} onClick={() => ask('ban', chosen)}>批量封禁</Button><Button variant="secondary" disabled={!chosen.length || selectionDisabled} onClick={() => ask('unban', chosen)}>批量解封</Button><Button variant="danger" disabled={!chosen.length || selectionDisabled} onClick={() => ask('delete', chosen)}>彻底删除</Button></div>
    </div>
    <QueryStatus query={query} empty={!items.length}>
      <div className="table-scroll"><table className="admin-user-table"><thead><tr>
        <th className="user-selection-cell"><label className="user-checkbox"><input ref={allRef} type="checkbox" aria-label="全选当前页用户" checked={allSelected} disabled={selectionDisabled || !items.length} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map(user => user.id)))} /><span>本页</span></label></th><th>用户</th><th>第三方登录</th><th>角色</th><th>状态</th><th>金币</th><th>肥料</th><th>操作</th>
      </tr></thead><tbody>{items.map(user => <tr key={user.id} className={selected.has(user.id) ? 'user-selected' : undefined}>
        <td className="user-selection-cell"><label className="user-checkbox"><input type="checkbox" aria-label={`选择用户 ${user.displayName || user.username}`} checked={selected.has(user.id)} disabled={selectionDisabled} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(user.id)) next.delete(user.id); else next.add(user.id); return next; })} /></label></td>
        <td className="admin-user-name"><strong>{user.displayName || user.username}</strong><small className="cell-subline">{user.username}</small></td><td className="admin-user-bindings"><AdminIdentities identities={user.identities || []} /></td><td>{user.role === 'admin' ? '管理员' : '用户'}</td><td><span className={`status ${user.status}`}>{statusName(user.status)}</span></td><td>{number(user.coins)}</td><td>{number(user.fertilizer)}</td>
        <td><div className="button-row user-row-actions"><Link className="button secondary" to={`/admin/users/${encodeURIComponent(user.id)}`} aria-label={`查看 ${user.displayName || user.username} 的详情`}>详情</Link><Button variant="secondary" disabled={locked} onClick={() => ask(user.status === 'banned' ? 'unban' : 'ban', [user])}>{user.status === 'banned' ? '解封' : '封禁'}</Button><Button variant="danger" disabled={locked} onClick={() => ask('delete', [user])}>删除</Button></div></td>
      </tr>)}</tbody></table></div>
    </QueryStatus>
    {query.data && <Pager page={page} total={query.data.total} setPage={changePage} disabled={locked} />}
    {operation && <UserActionDialog operation={operation} currentUserId={currentUserId} pending={batch.isPending} onCancel={cancel} onConfirm={() => batch.mutate(operation)} />}
    {createOpen && <Dialog title="创建本地用户" onClose={() => setCreateOpen(false)}><form onSubmit={event => { const form = submitData(event); create.mutate({ username: textField(form, 'username'), displayName: textField(form, 'displayName'), password: String(form.get('password') || ''), role: textField(form, 'role') }); }}><Field label="用户名"><input name="username" required maxLength={40} autoComplete="off" autoFocus /></Field><Field label="显示名称"><input name="displayName" required maxLength={60} /></Field><Field label="初始密码" help="至少 8 位。"><input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field><Field label="角色"><select name="role" defaultValue="user"><option value="user">用户</option><option value="admin">管理员</option></select></Field><div className="dialog-actions"><Button variant="secondary" type="button" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" pending={create.isPending}>创建用户</Button></div></form></Dialog>}
  </section>;
}
