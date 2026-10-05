import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, number, time, statusName, type Audit, type Model, type Page, type Rules, type State, type Stats, type Usage, type User, type UserDetail } from './api';
import { Button, Dialog, Field, Pager, PanelTitle, QueryStatus, numberField, submitData, textField, useAction, useNotice } from './ui';
import { LedgerTable, UsageTable } from './Account';
import ModelReplies from './ModelReplies';
import ModelRules from './ModelRules';
import OAuthAdmin from './OAuthAdmin';
import AdminIdentities from './AdminIdentities';
import SiteSettingsPanel from './SiteSettings';
import Users, { clearCurrentSession, clearRemovedSession, UserActionDialog, type UserOperation, type UserOperationResult } from './AdminUsers';
import './AdminIdentities.css';
import './AdminUsers.css';

export default function Admin({ state, onLogin }: { state: State; onLogin: () => void }) {
  const location = useLocation();
  if (!state.user) return <section className="signin-prompt"><h1>管理控制台</h1><p>请使用管理员账号登录。</p><Button onClick={onLogin}>登录</Button></section>;
  if (state.user.role !== 'admin') return <section className="error-state"><h1>没有管理权限</h1><p>此页面只向管理员开放。</p><Link to="/">返回花园</Link></section>;
  const segments = location.pathname.split('/').filter(Boolean);
  const tab = segments[1] || 'users';
  return <div className="admin-layout"><aside className="admin-sidebar"><h1>管理控制台</h1><nav aria-label="管理导航">{[['users', '用户管理'], ['models', '模型管理'], ['oauth', '第三方登录'], ['site', '网站设置'], ['settings', '养成与 API 规则'], ['usage', '全站调用记录'], ['audit', '管理审计']].map(([id, label]) => <NavLink key={id} to={`/admin/${id}`} className={tab === id ? 'active' : ''}>{label}</NavLink>)}</nav><p>操作由服务器鉴权，所有管理变更记录到审计日志。</p></aside><div className="admin-content"><AdminStats />{tab === 'models' ? segments[2] && segments[3] === 'replies' ? <ModelReplies key={segments[2]} modelId={decodeURIComponent(segments[2])} /> : segments[2] && segments[3] === 'rules' ? <ModelRules key={segments[2]} modelId={decodeURIComponent(segments[2])} /> : <ModelAdmin /> : tab === 'oauth' ? <OAuthAdmin /> : tab === 'site' ? <SiteSettingsPanel /> : tab === 'settings' ? <Settings /> : tab === 'usage' ? <AdminUsage /> : tab === 'audit' ? <AuditPanel /> : tab === 'users' && segments[2] ? <UserDetailPanel id={decodeURIComponent(segments[2])} currentUserId={state.user.id} /> : <Users currentUserId={state.user.id} />}</div></div>;
}

function AdminStats() {
  const query = useQuery({ queryKey: ['admin', 'stats'], queryFn: ({ signal }) => api<Stats>('/api/admin/stats', { signal }) });
  return <section className="admin-stats" aria-label="全站概况"><QueryStatus query={query}>{query.data && <dl>{[['用户', query.data.users], ['正常用户', query.data.activeUsers], ['模型', query.data.models], ['生成请求', query.data.requests], ['发放金币', query.data.coinsIssued], ['消费金币', query.data.coinsSpent]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number(Number(value))}</dd></div>)}</dl>}</QueryStatus></section>;
}

function UserDetailPanel({ id, currentUserId }: { id: string; currentUserId: string }) {
  const query = useQuery({ queryKey: ['admin', 'user', id], queryFn: ({ signal }) => api<UserDetail>(`/api/admin/users/${encodeURIComponent(id)}`, { signal }) });
  const navigate = useNavigate();
  const update = useAction<unknown>(body => api<{ user: User }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }), '用户资料已更新。', value => {
    const result = value as { user: User };
    if (id === currentUserId && (result.user.status !== 'active' || result.user.role !== 'admin')) { clearCurrentSession(); navigate('/', { replace: true }); }
  });
  const adjust = useAction<unknown>(body => api(`/api/admin/users/${encodeURIComponent(id)}/adjust`, { method: 'POST', body }), '余额与肥料已调整。');
  const password = useAction<unknown>(body => api(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: 'POST', body }), '密码已重置，该用户的现有登录会话已失效。', () => {
    if (id === currentUserId) { clearCurrentSession(); navigate('/', { replace: true }); }
  });
  const remove = useAction<void>(() => api<UserOperationResult>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }), '用户及所有关联账户数据已彻底删除。', value => {
    const result = value as UserOperationResult;
    setOperation(null);
    navigate(clearRemovedSession(result, currentUserId) ? '/' : '/admin/users', { replace: true });
  });
  const changeStatus = useAction<UserOperation>(input => api<UserOperationResult>('/api/admin/users/batch', { method: 'POST', body: { ids: [id], action: input.action } }), undefined, value => {
    const result = value as UserOperationResult;
    setOperation(null);
    notify({ kind: 'success', message: result.action === 'ban' ? '用户已封禁，现有登录会话已失效。' : '用户已解封。' });
    if (clearRemovedSession(result, currentUserId)) navigate('/', { replace: true });
  });
  const notify = useNotice();
  const [operation, setOperation] = useState<UserOperation | null>(null);
  const operationPending = remove.isPending || changeStatus.isPending;
  const [section, setSection] = useState<'usage' | 'ledger' | 'keys'>('usage');
  return <><Link className="back-link" to="/admin/users">返回用户列表</Link><QueryStatus query={query}>{query.data && <>
    <section className="panel"><PanelTitle title={query.data.user.displayName || query.data.user.username} description={`用户 ID：${query.data.user.id}`} /><dl className="account-facts"><div><dt>金币</dt><dd>{number(query.data.user.coins)}</dd></div><div><dt>肥料</dt><dd>{number(query.data.user.fertilizer)}</dd></div><div><dt>树高</dt><dd>{number(query.data.tree?.height || 0)} 英尺</dd></div><div><dt>种植状态</dt><dd>{query.data.tree?.planted ? '已种下' : query.data.tree?.seedClaimed ? '已领取种子' : '未领取'}</dd></div></dl><section className="admin-user-identity-summary" aria-label="第三方登录"><h3>第三方登录</h3><AdminIdentities identities={query.data.identities} /></section></section>
    <section className="panel"><PanelTitle title="资料与权限" description="修改资料、角色或账户状态，保存后立即生效。" /><form key={`${query.data.user.username}-${query.data.user.displayName}-${query.data.user.role}-${query.data.user.status}`} onSubmit={event => { const form = submitData(event); update.mutate({ username: textField(form, 'username'), displayName: textField(form, 'displayName'), role: textField(form, 'role'), status: textField(form, 'status') }); }}><div className="form-grid"><Field label="用户名"><input name="username" defaultValue={query.data.user.username} required maxLength={40} /></Field><Field label="显示名称"><input name="displayName" defaultValue={query.data.user.displayName} required maxLength={60} /></Field><Field label="角色"><select name="role" defaultValue={query.data.user.role}><option value="user">用户</option><option value="admin">管理员</option></select></Field><Field label="状态"><select name="status" defaultValue={query.data.user.status}><option value="active">正常</option><option value="banned">封禁</option></select></Field></div><Button type="submit" pending={update.isPending}>保存资料与权限</Button></form></section>
    <div className="admin-form-columns"><section className="panel"><PanelTitle title="调整余额" description="正数增加，负数扣减；最终余额不能小于 0。" /><form onSubmit={event => { const form = submitData(event); adjust.mutate({ coinsDelta: numberField(form, 'coinsDelta'), fertilizerDelta: numberField(form, 'fertilizerDelta') }); }}><Field label="金币增减"><input name="coinsDelta" type="number" step="1" defaultValue="0" required /></Field><Field label="肥料增减"><input name="fertilizerDelta" type="number" step="1" defaultValue="0" required /></Field><Button type="submit" pending={adjust.isPending}>确认调整</Button></form></section><section className="panel"><PanelTitle title="重置密码" description="保存后，该用户需要重新登录。" /><form onSubmit={event => { const form = submitData(event); password.mutate({ password: String(form.get('password') || '') }); event.currentTarget.reset(); }}><Field label="新密码" help="至少 8 位。"><input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field><Button type="submit" pending={password.isPending}>重置密码并退出会话</Button></form></section></div>
    <section className="panel"><PanelTitle title="用户记录" /><div className="tabs" role="tablist" aria-label="用户记录">{[['usage', '调用记录'], ['ledger', '收支账本'], ['keys', 'API 密钥']].map(([key, label]) => <button key={key} role="tab" aria-selected={section === key} onClick={() => setSection(key as typeof section)}>{label}</button>)}</div>{section === 'usage' ? query.data.usage.length ? <UsageTable items={query.data.usage} /> : <div className="empty-state">暂无调用记录。</div> : section === 'ledger' ? query.data.ledger.length ? <LedgerTable items={query.data.ledger} /> : <div className="empty-state">暂无收支记录。</div> : query.data.keys.length ? <div className="table-scroll"><table><thead><tr><th>名称</th><th>前缀</th><th>创建</th><th>最后使用</th><th>状态</th></tr></thead><tbody>{query.data.keys.map(key => <tr key={key.id}><td>{key.name}</td><td><code>{key.prefix}</code></td><td>{time(key.createdAt)}</td><td>{time(key.lastUsedAt)}</td><td>{key.revokedAt ? '已撤销' : '可用'}</td></tr>)}</tbody></table></div> : <div className="empty-state">暂无 API 密钥。</div>}</section>
    <section className="panel danger-zone"><PanelTitle title="账户操作" description="封禁会保留账户数据；删除会彻底移除账户及所有关联数据，无法恢复。" /><div className="button-row user-detail-actions"><Button variant="secondary" disabled={operationPending} onClick={() => setOperation({ action: query.data!.user.status === 'banned' ? 'unban' : 'ban', users: [query.data!.user] })}>{query.data.user.status === 'banned' ? '解封用户' : '封禁用户'}</Button><Button variant="danger" disabled={operationPending} onClick={() => setOperation({ action: 'delete', users: [query.data!.user] })}>彻底删除用户</Button></div></section>
  </>}</QueryStatus>{operation && <UserActionDialog operation={operation} currentUserId={currentUserId} pending={operationPending} onCancel={() => { if (!operationPending) setOperation(null); }} onConfirm={() => { if (operation.action === 'delete') remove.mutate(); else changeStatus.mutate(operation); }} />}</>;
}

function ModelAdmin() {
  const query = useQuery({ queryKey: ['admin', 'models'], queryFn: ({ signal }) => api<{ items: Model[]; defaultReplyText: string }>('/api/admin/models', { signal }) });
  const [editing, setEditing] = useState<Model | 'new' | null>(null);
  const save = useAction<{ originalId?: string; body: unknown }>(({ originalId, body }) => api(`/api/admin/models${originalId ? `/${encodeURIComponent(originalId)}` : ''}`, { method: originalId ? 'PATCH' : 'POST', body }), '模型配置已保存。', () => setEditing(null));
  const remove = useAction<string>(id => api(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' }), '模型已软删除。');
  const current = editing && editing !== 'new' ? editing : null;
  return <section className="panel model-admin-panel">
    <PanelTitle title="模型管理" description="输入匹配规则优先；未匹配时按编号回复，回复库为空时才使用默认文本。" action={<Button onClick={() => setEditing('new')}>添加模型</Button>} />
    <QueryStatus query={query} empty={!query.data?.items.length}>
      <div className="table-scroll"><table className="model-admin-table"><thead><tr><th>模型</th><th>价格</th><th>状态</th><th>回复配置</th><th>流式设置</th><th>操作</th></tr></thead><tbody>{query.data?.items.map(model => <tr key={model.id}>
        <td><strong>{model.displayName}</strong><code className="cell-subline">{model.id}</code>{model.isWisdomTree && <small className="model-garden-marker">花园智慧树使用此模型</small>}</td>
        <td>{number(model.coinsPerCall)} 金币 / 次</td><td>{model.enabled ? '已启用' : '已停用'}</td>
        <td><span className="model-reply-count">编号回复 {model.replyCount ?? 0} 条</span><small className="cell-subline">输入规则 {model.ruleCount ?? 0} 条</small></td>
        <td>{model.streamChunkChars ?? '—'} 字 / {model.streamDelayMs ?? '—'} ms</td>
        <td><div className="button-row model-actions"><Button variant="secondary" onClick={() => setEditing(model)}>编辑</Button><Link className="button secondary" to={`/admin/models/${encodeURIComponent(model.id)}/replies`}>管理回复</Link><Link className="button secondary" to={`/admin/models/${encodeURIComponent(model.id)}/rules`}>输入匹配</Link><Button variant="danger" pending={remove.isPending && remove.variables === model.id} onClick={() => { if (window.confirm(`删除模型“${model.displayName}”（${model.id}）？后续请求将无法使用此模型，历史调用记录会保留。`)) remove.mutate(model.id); }}>删除</Button></div></td>
      </tr>)}</tbody></table></div>
    </QueryStatus>
    {editing && <Dialog title={editing === 'new' ? '添加模型' : '编辑模型'} onClose={() => setEditing(null)} wide>
      {current && <div className="model-replies-summary"><div><strong>{current.isWisdomTree ? '智慧树语录库' : '编号回复库'}：{current.replyCount ?? 0} 条</strong><p>{current.isWisdomTree ? '已导入的智慧树文案在编号回复库中。下方默认文本只在回复库为空时使用。' : '编号回复在独立回复库中编辑，下方是回复库为空时使用的默认内容。'}</p></div><Link className="button secondary" to={`/admin/models/${encodeURIComponent(current.id)}/replies`} onClick={() => setEditing(null)}>管理 {current.replyCount ?? 0} 条回复</Link></div>}
      <form onSubmit={event => { const form = submitData(event); save.mutate({ originalId: current?.id, body: { id: textField(form, 'id'), displayName: textField(form, 'displayName'), coinsPerCall: numberField(form, 'coinsPerCall'), enabled: form.get('enabled') === 'on', replyText: String(form.get('replyText') || ''), streamChunkChars: numberField(form, 'streamChunkChars'), streamDelayMs: numberField(form, 'streamDelayMs') } }); }}>
        <div className="form-grid">
          <Field label="模型 ID" help={current ? '修改后，请同步更新 Agent 和 SDK 中使用的模型 ID。历史调用记录会保留。' : 'Agent 和 SDK 调用时使用的模型标识。'}><input name="id" required defaultValue={current?.id || ''} maxLength={120} autoFocus /></Field>
          <Field label="显示名称"><input name="displayName" required defaultValue={current?.displayName || ''} maxLength={120} /></Field>
          <Field label="每次生成请求的金币价格"><input name="coinsPerCall" type="number" step="1" min="0" required defaultValue={current?.coinsPerCall ?? 1} /></Field>
          <Field label="流式每块字符数"><input name="streamChunkChars" type="number" step="1" min="1" required defaultValue={current?.streamChunkChars ?? 8} /></Field>
          <Field label="流式块间隔（毫秒）"><input name="streamDelayMs" type="number" step="1" min="0" required defaultValue={current?.streamDelayMs ?? 30} /></Field>
          <label className="checkbox-field"><input type="checkbox" name="enabled" defaultChecked={current?.enabled ?? true} />启用此模型</label>
        </div>
        <Field label="默认返回文本（回复库为空时）" help="输入未匹配规则且编号回复库为空时，返回此内容。"><textarea name="replyText" rows={5} required maxLength={20000} defaultValue={current?.replyText ?? query.data?.defaultReplyText ?? ''} placeholder="回复库为空时返回的内容" /></Field>
        {current && <div className="reply-section-links"><Link className="text-link" to={`/admin/models/${encodeURIComponent(current.id)}/rules`} onClick={() => setEditing(null)}>设置输入匹配规则（{current.ruleCount ?? 0} 条）</Link></div>}
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button type="submit" pending={save.isPending}>保存模型</Button></div>
      </form>
    </Dialog>}
  </section>;
}

function Settings() {
  const query = useQuery({ queryKey: ['admin', 'settings'], queryFn: ({ signal }) => api<Rules>('/api/admin/settings', { signal }) });
  const save = useAction<unknown>(body => api('/api/admin/settings', { method: 'PATCH', body }), '养成与 API 规则已更新。');
  const fields: { key: keyof Rules; label: string; min: number; help: string }[] = [{ key: 'dailyFertilizer', label: '每日肥料', min: 0, help: '每个账号每日可领取的袋数。' }, { key: 'inventoryLimit', label: '肥料库存上限', min: 0, help: '领取每日补给时的库存上限。' }, { key: 'coinsPerFeed', label: '每次施肥奖励金币', min: 0, help: '奖励写入金币账本。' }, { key: 'growthPerFeed', label: '每次施肥成长高度', min: 1, help: '单位为英尺，至少 1。' }, { key: 'apiRateLimit', label: '每分钟 API 请求上限', min: 1, help: '服务端针对 API 调用执行的速率限制。' }];
  return <section className="panel"><PanelTitle title="养成与 API 规则" description="规则以服务器配置为准，保存后向所有用户生效。" /><QueryStatus query={query}>{query.data && <form key={JSON.stringify(query.data)} onSubmit={event => { const form = submitData(event); save.mutate({ ...Object.fromEntries(fields.map(field => [field.key, numberField(form, field.key)])) }); }}><div className="form-grid">{fields.map(field => <Field label={field.label} help={field.help} key={field.key}><input name={field.key} type="number" step="1" min={field.min} required defaultValue={query.data![field.key]} /></Field>)}</div><Button type="submit" pending={save.isPending}>保存规则</Button></form>}</QueryStatus></section>;
}

function AdminUsage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ userId: '', modelId: '' });
  const query = useQuery({ queryKey: ['admin', 'usage', page, filters], queryFn: ({ signal }) => api<Page<Usage>>(`/api/admin/usage?page=${page}&pageSize=20&userId=${encodeURIComponent(filters.userId)}&modelId=${encodeURIComponent(filters.modelId)}`, { signal }) });
  return <section className="panel"><PanelTitle title="全站调用记录" description="按用户与模型检查已受理请求和金币扣费。" /><form className="filter-form" onSubmit={event => { const form = submitData(event); setFilters({ userId: textField(form, 'userId'), modelId: textField(form, 'modelId') }); setPage(1); }}><Field label="用户 ID"><input name="userId" placeholder="全部用户" /></Field><Field label="模型 ID"><input name="modelId" placeholder="全部模型" /></Field><Button type="submit" variant="secondary">筛选</Button></form><QueryStatus query={query} empty={!query.data?.items.length}><UsageTable items={query.data?.items || []} /></QueryStatus>{query.data && <Pager page={page} total={query.data.total} setPage={setPage} />}</section>;
}

function AuditPanel() {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['admin', 'audit', page], queryFn: ({ signal }) => api<Page<Audit>>(`/api/admin/audit?page=${page}&pageSize=20`, { signal }) });
  return <section className="panel"><PanelTitle title="管理审计" description="查看管理员和变更前后的数据；管理操作自动留档。" /><QueryStatus query={query} empty={!query.data?.items.length}><div className="table-scroll"><table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>目标</th><th>变更数据</th></tr></thead><tbody>{query.data?.items.map(item => <tr key={item.id}><td>{time(item.createdAt)}</td><td>{item.actorName || item.actorId}</td><td>{item.action}</td><td><code>{item.targetId || '—'}</code></td><td><details><summary>查看变更</summary><strong>变更前</strong><pre>{JSON.stringify(item.before, null, 2)}</pre><strong>变更后</strong><pre>{JSON.stringify(item.after, null, 2)}</pre></details></td></tr>)}</tbody></table></div></QueryStatus>{query.data && <Pager page={page} total={query.data.total} setPage={setPage} />}</section>;
}
