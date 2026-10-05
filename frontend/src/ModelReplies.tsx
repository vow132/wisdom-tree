import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Model, type ModelReply } from './api';
import { Button, Dialog, Field, PanelTitle, QueryStatus, numberField, submitData, useAction } from './ui';

export default function ModelReplies({ modelId }: { modelId: string }) {
  const path = `/api/admin/models/${encodeURIComponent(modelId)}/replies`;
  const models = useQuery({ queryKey: ['admin', 'models'], queryFn: ({ signal }) => api<{ items: Model[] }>('/api/admin/models', { signal }) });
  const query = useQuery({ queryKey: ['model-replies', modelId], queryFn: ({ signal }) => api<{ items: ModelReply[]; total: number }>(path, { signal }) });
  const [editing, setEditing] = useState<ModelReply | null>(null);
  const [deleting, setDeleting] = useState<ModelReply | null>(null);
  const [filter, setFilter] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);
  const save = useAction<{ id?: string; position: number; text: string }>(body => api(`${path}${body.id ? `/${encodeURIComponent(body.id)}` : ''}`, { method: body.id ? 'PATCH' : 'POST', body }), '模型回复已保存。', () => setEditing(null), ['model-replies', 'admin']);
  const remove = useAction<string>(id => api(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }), '这条回复已删除。', () => { setEditing(null); setDeleting(null); }, ['model-replies', 'admin']);
  const model = models.data?.items.find(item => item.id === modelId);
  const nextPosition = Math.max(0, ...(query.data?.items.map(item => item.position) || [])) + 1;
  const items = query.data?.items.filter(item => !filter || item.text.toLowerCase().includes(filter.toLowerCase()) || String(item.position).includes(filter)) || [];
  return <>
    <Link className="back-link" to="/admin/models">返回模型管理</Link>
    <section className="panel reply-panel"><PanelTitle title={`${model?.displayName || modelId} 的编号回复库`} description={`当前 ${query.data?.total ?? 0} 条回复。未命中输入规则时，每次按编号返回下一条，到末尾重新开始。`} action={<Button variant="secondary" onClick={() => { setEditing(null); setDraftVersion(value => value + 1); }}>添加回复</Button>} />
      {model?.isWisdomTree && <p className="reply-model-note">智慧树语录已导入编号回复库，当前 {query.data?.total ?? model.replyCount ?? 0} 条。花园中的智慧树和 API 的 <code>{modelId}</code> 共用这些内容；默认返回文本只在回复库为空时使用。</p>}
      <div className="reply-section-links"><Link className="text-link" to={`/admin/models/${encodeURIComponent(modelId)}/rules`}>管理输入匹配规则（{model?.ruleCount ?? 0} 条）</Link></div>
      <QueryStatus query={query}><div className="reply-workspace">
        <div className="reply-library"><Field label="查找回复"><input type="search" placeholder="输入编号或文字" value={filter} onChange={event => setFilter(event.currentTarget.value)} /></Field>
          {items.length ? <ol className="reply-list">{items.map(item => <li key={item.id} className={editing?.id === item.id ? 'selected' : ''}><button className="reply-select" onClick={() => setEditing(item)} aria-label={`编辑回复 ${item.position}`}><span className="reply-position">{item.position}</span><p>{item.text}</p></button><Button variant="quiet" onClick={() => setDeleting(item)} aria-label={`删除回复 ${item.position}`}>删除</Button></li>)}</ol> : <p className="empty-state">{filter ? '没有匹配的回复。' : '还没有多条回复，将使用模型的默认文本。'}</p>}
        </div>
        <div className="reply-editor"><h3>{editing ? `编辑第 ${editing.position} 条` : '添加一条回复'}</h3><form key={editing?.id || `new-${query.data?.total ?? 0}-${draftVersion}`} onSubmit={event => { const form = submitData(event); save.mutate({ id: editing?.id, position: numberField(form, 'position'), text: String(form.get('text') || '') }); }}>
          <Field label="编号" help="编号决定返回顺序，同一模型内不能重复。"><input name="position" type="number" min={1} max={1000000} step={1} required defaultValue={editing?.position || nextPosition} /></Field>
          <Field label="返回的话"><textarea name="text" rows={8} required maxLength={20000} defaultValue={editing?.text || ''} placeholder="例如：今天也要好好照料你的花园。" /></Field>
          <div className="button-row"><Button type="submit" pending={save.isPending}>{editing ? '保存回复' : '添加回复'}</Button>{editing && <Button type="button" variant="quiet" onClick={() => setEditing(null)}>取消编辑</Button>}</div>
        </form></div>
      </div></QueryStatus>
    </section>
    {deleting && <Dialog title={`删除第 ${deleting.position} 条回复`} onClose={() => setDeleting(null)}><p className="muted">删除后新调用不再选中这条内容，已接受请求的回复快照会保留。</p><div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => setDeleting(null)}>保留回复</Button><Button type="button" variant="danger" pending={remove.isPending} onClick={() => remove.mutate(deleting.id)}>确认删除</Button></div></Dialog>}
  </>;
}
