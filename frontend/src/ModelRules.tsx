import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Model, type ModelRule } from './api';
import { Button, Dialog, Field, PanelTitle, QueryStatus, numberField, submitData, textField, useAction } from './ui';

export default function ModelRules({ modelId }: { modelId: string }) {
  const path = `/api/admin/models/${encodeURIComponent(modelId)}/rules`;
  const models = useQuery({ queryKey: ['admin', 'models'], queryFn: ({ signal }) => api<{ items: Model[] }>('/api/admin/models', { signal }) });
  const query = useQuery({ queryKey: ['model-rules', modelId], queryFn: ({ signal }) => api<{ items: ModelRule[]; total: number }>(path, { signal }) });
  const [editing, setEditing] = useState<ModelRule | null>(null);
  const [deleting, setDeleting] = useState<ModelRule | null>(null);
  const [filter, setFilter] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);
  const save = useAction<{ id?: string; position: number; input: string; text: string; enabled: boolean }>(body => api(`${path}${body.id ? `/${encodeURIComponent(body.id)}` : ''}`, { method: body.id ? 'PATCH' : 'POST', body }), '输入匹配规则已保存。', () => setEditing(null), ['model-rules', 'admin']);
  const remove = useAction<string>(id => api(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }), '输入匹配规则已删除。', () => { setEditing(null); setDeleting(null); }, ['model-rules', 'admin']);
  const model = models.data?.items.find(item => item.id === modelId);
  const nextPosition = Math.max(0, ...(query.data?.items.map(item => item.position) || [])) + 1;
  const normalizedFilter = filter.toLowerCase();
  const items = query.data?.items.filter(item => !filter || item.input.toLowerCase().includes(normalizedFilter) || item.text.toLowerCase().includes(normalizedFilter) || String(item.position).includes(filter)) || [];

  return <>
    <Link className="back-link" to="/admin/models">返回模型管理</Link>
    <section className="panel reply-panel rule-panel">
      <PanelTitle title={`${model?.displayName || modelId} 的输入匹配`} description={`当前 ${query.data?.total ?? 0} 条规则。客户最近一句话与输入文本完全一致时，返回指定回复。`} action={<Button variant="secondary" onClick={() => { setEditing(null); setDraftVersion(value => value + 1); }}>添加规则</Button>} />
      <p className="reply-model-note">例如：输入“你好”，返回“你好”。比较时会忽略首尾空格；启用的规则按编号匹配，未匹配时使用编号回复库或默认文本。</p>
      <div className="reply-section-links"><Link className="text-link" to={`/admin/models/${encodeURIComponent(modelId)}/replies`}>管理编号回复（{model?.replyCount ?? 0} 条）</Link></div>
      <QueryStatus query={query}>
        <div className="reply-workspace">
          <div className="reply-library">
            <Field label="查找规则"><input type="search" placeholder="输入编号、客户的话或回复" value={filter} onChange={event => setFilter(event.currentTarget.value)} /></Field>
            {items.length ? <ol className="reply-list rule-list">{items.map(item => <li key={item.id} className={editing?.id === item.id ? 'selected' : ''}>
              <button className="reply-select rule-select" onClick={() => setEditing(item)} aria-label={`编辑规则 ${item.position}`}>
                <span className="reply-position">{item.position}</span>
                <div className="rule-summary"><span className={`status ${item.enabled ? 'active' : 'disabled'}`}>{item.enabled ? '已启用' : '已停用'}</span><p><strong>客户：</strong>{item.input}</p><p><strong>回复：</strong>{item.text}</p></div>
              </button>
              <Button variant="quiet" onClick={() => setDeleting(item)} aria-label={`删除规则 ${item.position}`}>删除</Button>
            </li>)}</ol> : <p className="empty-state">{filter ? '没有匹配的规则。' : '还没有输入规则。添加第一条，让模型对指定输入作出固定回复。'}</p>}
          </div>
          <div className="reply-editor rule-editor">
            <h3>{editing ? `编辑规则 ${editing.position}` : '添加一条规则'}</h3>
            <form key={editing?.id || `new-${query.data?.total ?? 0}-${draftVersion}`} onSubmit={event => { const form = submitData(event); save.mutate({ id: editing?.id, position: numberField(form, 'position'), input: textField(form, 'input'), text: String(form.get('text') || ''), enabled: form.get('enabled') === 'on' }); }}>
              <Field label="编号" help="同一模型内不能重复；较小编号优先匹配。"><input name="position" type="number" min={1} max={1000000} step={1} required defaultValue={editing?.position || nextPosition} /></Field>
              <Field label="客户输入" help="完全匹配最近一条用户消息；区分大小写。"><textarea name="input" rows={3} required maxLength={2000} defaultValue={editing?.input || ''} placeholder="你好" /></Field>
              <Field label="指定回复"><textarea name="text" rows={6} required maxLength={20000} defaultValue={editing?.text || ''} placeholder="你好" /></Field>
              <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={editing?.enabled ?? true} />启用这条规则</label>
              <div className="button-row"><Button type="submit" pending={save.isPending}>{editing ? '保存规则' : '添加规则'}</Button>{editing && <Button type="button" variant="quiet" onClick={() => setEditing(null)}>取消编辑</Button>}</div>
            </form>
          </div>
        </div>
      </QueryStatus>
    </section>
    {deleting && <Dialog title={`删除规则 ${deleting.position}`} onClose={() => setDeleting(null)}><p className="muted">删除后，后续调用不再匹配这条规则。已接受请求的回复会保留。</p><div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => setDeleting(null)}>保留规则</Button><Button type="button" variant="danger" pending={remove.isPending} onClick={() => remove.mutate(deleting.id)}>确认删除</Button></div></Dialog>}
  </>;
}
