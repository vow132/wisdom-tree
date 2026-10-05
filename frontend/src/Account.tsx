import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, number, queryClient, signed, time, providerName, statusName, type ApiKey, type Identity, type Ledger, type Model, type Page, type State, type Usage } from './api';
import { Button, CopyButton, Field, Pager, PanelTitle, QueryStatus, submitData, textField, useAction } from './ui';

export default function Account({ state, view, onLogin }: { state: State; view: 'api' | 'account'; onLogin: () => void }) {
  const [tab, setTab] = useState('keys');
  if (!state.user) return <div className="account-page"><div className="page-heading"><h1>{view === 'api' ? 'API 控制台' : '我的账号'}</h1><p>登录后管理密钥、查看用量，和你的智慧树一起积累金币。</p></div><div className="signin-prompt"><h2>连接你的花园</h2><p>登录你的账号，继续照料智慧树。</p><Button onClick={onLogin}>登录</Button></div>{view === 'api' && <Models />}</div>;
  if (view === 'account') return <div className="account-page"><div className="page-heading"><h1>我的账号</h1><p>管理登录方式，查看每一笔成长与消费。</p></div><section className="panel"><PanelTitle title={state.user.displayName || state.user.username} description={`用户名：${state.user.username}`} /><dl className="account-facts"><div><dt>账号状态</dt><dd>{statusName(state.user.status)}</dd></div><div><dt>角色</dt><dd>{state.user.role === 'admin' ? '管理员' : '用户'}</dd></div><div><dt>金币余额</dt><dd>{number(state.user.coins)}</dd></div><div><dt>肥料库存</dt><dd>{state.user.fertilizer} / {state.rules.inventoryLimit}</dd></div></dl></section><Identities state={state} /><LedgerPanel /></div>;
  return <div className="account-page"><div className="page-heading"><h1>API 控制台</h1><p>为 Agent 创建密钥，按模型的每次调用价格使用金币。</p></div><div className="api-summary"><div><span>可用金币</span><strong>{number(state.user.coins)}</strong></div><p>生成请求按次扣费，模型列表、Token 估算与健康检查免费。当前限速：每分钟 {state.rules.apiRateLimit} 次。</p></div><div className="tabs" role="tablist" aria-label="API 控制台内容">{[['keys', 'API 密钥'], ['models', '模型与接入'], ['usage', '调用记录'], ['ledger', '金币账本']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div><div role="tabpanel">{tab === 'keys' ? <Keys /> : tab === 'models' ? <><Models /><Integration /></> : tab === 'usage' ? <UsagePanel /> : <LedgerPanel />}</div></div>;
}

function Keys() {
  const query = useQuery({ queryKey: ['keys'], queryFn: ({ signal }) => api<{ items: ApiKey[] }>('/api/keys', { signal }) });
  const [createdId, setCreatedId] = useState<string>();
  const create = useAction<string>(name => api('/api/keys', { method: 'POST', body: { name } }), 'API 密钥已创建，可直接复制。', result => {
    const next = result as { key: string; item: ApiKey };
    setCreatedId(next.item.id);
    queryClient.setQueryData<{ items: ApiKey[] }>(['keys'], previous => ({ items: [{ ...next.item, key: next.key }, ...(previous?.items || [])] }));
  }, []);
  const revoke = useAction<string>(async id => { await api(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }); return { id }; }, '密钥已撤销，无法再用于调用。', result => {
    const { id } = result as { id: string };
    queryClient.setQueryData<{ items: ApiKey[] }>(['keys'], previous => ({ items: (previous?.items || []).map(key => key.id === id ? { ...key, revokedAt: new Date().toISOString(), key: null, recoverable: false } : key) }));
  }, []);
  return <section className="panel key-panel"><PanelTitle title="我的 API 密钥" description="新密钥使用 sk_ 前缀。登录后可在这里随时查看、复制完整密钥。" />
    <form className="inline-form key-create-form" onSubmit={event => { const form = submitData(event); create.mutate(textField(form, 'name')); event.currentTarget.reset(); }}><Field label="给密钥起个名字"><input name="name" placeholder="例如：桌面 Agent" required maxLength={64} /></Field><Button type="submit" pending={create.isPending}>创建密钥</Button></form>
    <QueryStatus query={query}><div className="key-list">{!query.data?.items.length ? <div className="key-empty"><h3>创建第一把密钥</h3><p>创建后复制到 Agent 的 API Key 设置，就能使用花园里的金币调用模型。</p></div> : query.data.items.map(key => <article className={`key-row ${key.id === createdId && !key.revokedAt ? 'is-new' : ''}`} key={key.id}>
      <header><h3>{key.name}</h3><span className={`status ${key.revokedAt ? 'deleted' : ''}`}>{key.revokedAt ? '已撤销' : key.id === createdId ? '刚刚创建' : '可用'}</span></header>
      {key.key && !key.revokedAt ? <div className="key-copy-field"><input aria-label={`${key.name} 的完整 API 密钥`} autoComplete="off" spellCheck={false} readOnly value={key.key} onFocus={event => event.target.select()} /><CopyButton value={key.key} label="复制密钥" /></div> : <p className="key-unavailable">{key.revokedAt ? '这把密钥已停用。' : '旧密钥只保存了摘要，无法恢复明文。请创建一把新密钥。'}<code>{key.prefix}…</code></p>}
      <footer><div><span>创建于 {time(key.createdAt)}</span><span>最后使用 {time(key.lastUsedAt)}</span></div><Button variant="danger" disabled={!!key.revokedAt} pending={revoke.isPending && revoke.variables === key.id} onClick={() => { if (window.confirm(`撤销“${key.name}”？使用这把密钥的 Agent 将无法继续调用。`)) revoke.mutate(key.id); }}>撤销密钥</Button></footer>
    </article>)}</div></QueryStatus>
  </section>;
}

export function Models() {
  const query = useQuery({ queryKey: ['models'], queryFn: ({ signal }) => api<{ items: Model[] }>('/api/models', { signal }) });
  return <section className="panel"><PanelTitle title="可用模型" description="以这里公布的价格为准，每个生成请求扣费一次。" /><QueryStatus query={query} empty={!query.data?.items.length}><div className="table-scroll"><table><thead><tr><th>模型 ID</th><th>名称</th><th>每次调用</th></tr></thead><tbody>{query.data?.items.map(model => <tr key={model.id}><td><code>{model.id}</code></td><td>{model.displayName}</td><td>{number(model.coinsPerCall)} 金币</td></tr>)}</tbody></table></div></QueryStatus></section>;
}

function Integration() {
  const base = `${window.location.origin}/v1`;
  const example = `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}",\n    api_key="YOUR_API_KEY",\n)\nresponse = client.chat.completions.create(\n    model="MODEL_ID",\n    messages=[{"role": "user", "content": "你好"}],\n)\nprint(response.choices[0].message.content)`;
  return <section className="panel"><PanelTitle title="连接 Agent" description="将下方地址和你创建的 API 密钥填入 Agent 的模型供应商设置。" /><Field label="OpenAI 兼容 Base URL"><div className="copy-field"><input readOnly value={base} onFocus={event => event.target.select()} /><CopyButton value={base} /></div></Field><Field label="Anthropic / Claude 兼容 Base URL" help="使用网站根地址，SDK 会自动追加 /v1/messages。"><div className="copy-field"><input readOnly value={window.location.origin} onFocus={event => event.target.select()} /><CopyButton value={window.location.origin} /></div></Field><div className="integration-details"><p><strong>模型名称</strong>使用上表中的模型 ID。</p><p><strong>OpenAI 认证</strong>请求头 <code>Authorization: Bearer YOUR_API_KEY</code>。</p><p><strong>Anthropic 认证</strong>请求头 <code>x-api-key: YOUR_API_KEY</code> 与 <code>anthropic-version: 2023-06-01</code>。</p><p><strong>兼容接口</strong>Chat Completions、Completions、Responses、Anthropic Messages 与 Token 估算。</p><p><strong>返回内容</strong>当前模型返回管理员配置的文本；支持 JSON 与流式响应。</p></div><div className="code-heading"><h3>Python 调用示例</h3><CopyButton value={example} label="复制示例" /></div><pre tabIndex={0}><code>{example}</code></pre><p className="muted">将 <code>MODEL_ID</code> 替换为可用模型 ID。API 密钥仅保存在你的 Agent 配置中。</p></section>;
}

export function UsageTable({ items }: { items: Usage[] }) { return <div className="table-scroll"><table><thead><tr>{items.some(item => item.username) && <th>用户</th>}<th>时间</th><th>模型</th><th>接口</th><th>扣费</th><th>状态</th></tr></thead><tbody>{items.map(item => <tr key={item.id}>{items.some(row => row.username) && <td>{item.username || '—'}</td>}<td>{time(item.createdAt)}</td><td><code>{item.modelId}</code></td><td><code>{item.endpoint}</code></td><td>{number(item.coinsCharged)} 金币</td><td>{statusName(item.status)}</td></tr>)}</tbody></table></div>; }
function UsagePanel() {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['usage', page], queryFn: ({ signal }) => api<Page<Usage>>(`/api/usage?page=${page}&pageSize=20`, { signal }) });
  return <section className="panel"><PanelTitle title="调用记录" description="每一笔已受理请求的扣费与接口状态。" /><QueryStatus query={query} empty={!query.data?.items.length}><UsageTable items={query.data?.items || []} /></QueryStatus>{query.data && <Pager page={page} setPage={setPage} total={query.data.total} />}</section>;
}
export function LedgerTable({ items }: { items: Ledger[] }) { return <div className="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>金币变化</th><th>肥料变化</th><th>说明</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{time(item.createdAt)}</td><td>{({ feed: '施肥奖励', api_charge: 'API 扣费', api: 'API 扣费', daily_fertilizer: '每日肥料', daily: '每日肥料', admin_adjustment: '管理员调整', adjustment: '管理员调整', seed: '领取种子', plant: '播种' } as Record<string, string>)[item.kind] || item.kind}</td><td className={item.coinsDelta > 0 ? 'positive' : ''}>{signed(item.coinsDelta)}</td><td>{signed(item.fertilizerDelta)}</td><td>{item.reason || '—'}</td></tr>)}</tbody></table></div>; }
function LedgerPanel() {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['ledger', page], queryFn: ({ signal }) => api<Page<Ledger>>(`/api/ledger?page=${page}&pageSize=20`, { signal }) });
  return <section className="panel"><PanelTitle title="金币与肥料账本" description="来自服务器的完整收支记录。" /><QueryStatus query={query} empty={!query.data?.items.length}><LedgerTable items={query.data?.items || []} /></QueryStatus>{query.data && <Pager page={page} setPage={setPage} total={query.data.total} />}</section>;
}

function Identities({ state }: { state: State }) {
  const query = useQuery({ queryKey: ['identities'], queryFn: ({ signal }) => api<{ items: Identity[] }>('/api/auth/identities', { signal }) });
  const remove = useAction<string>(provider => api(`/api/auth/identities/${provider}`, { method: 'DELETE' }), '登录方式已解除绑定。');
  const providers = (['github', 'linuxdo'] as const).filter(provider => state.providers[provider] || query.data?.items.some(item => item.provider === provider));
  return <section className="panel"><PanelTitle title="登录方式" description="查看已绑定的账号，或绑定已开启的第三方登录方式。" /><QueryStatus query={query}>{providers.length ? <div className="identity-list">{providers.map(provider => { const identity = query.data?.items.find(item => item.provider === provider); return <div className="identity-row" key={provider}><div><strong>{providerName(provider)}</strong><p>{identity ? `已绑定 · ${identity.displayName || identity.providerUserId}${state.providers[provider] ? '' : ' · 登录入口已关闭'}` : '尚未绑定'}</p></div>{identity ? <Button variant="danger" pending={remove.isPending && remove.variables === provider} onClick={() => { if (window.confirm(`解除 ${providerName(provider)} 绑定？服务会保留至少一种可用登录方式。`)) remove.mutate(provider); }}>解除绑定</Button> : <a href={`/api/auth/${provider}/start?bind=1`} className="button secondary">绑定账号</a>}</div>; })}</div> : <p className="muted identity-empty">当前使用账号密码登录，尚未开放第三方账号绑定。</p>}</QueryStatus></section>;
}
