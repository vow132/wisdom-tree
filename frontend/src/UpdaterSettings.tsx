import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Button, CopyButton, Field, PanelTitle, QueryStatus, useAction } from './ui';
import { updateCapabilityChanged } from './RepositoryStatus';

export interface UpdateSettings { enabled: boolean; tokenConfigured: boolean; repositoryUrl: string; branch: string }
type UpdateSettingsInput = { enabled: boolean; token?: string; clearToken?: boolean };
const queryKey = ['admin', 'update-settings'] as const;

export default function UpdaterSettings() {
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api<UpdateSettings>('/api/admin/update/settings', { signal }) });
  return <section className="panel updater-settings" id="website-update">
    <PanelTitle title="网站更新" description="配置仓库访问凭据，让管理员通过导航栏的更新提示部署新版本。" />
    <QueryStatus query={query}>{query.data && <UpdaterForm item={query.data} />}</QueryStatus>
  </section>;
}

function UpdaterForm({ item }: { item: UpdateSettings }) {
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(item.enabled);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [validation, setValidation] = useState('');
  const save = useAction<UpdateSettingsInput>(body => api<UpdateSettings>('/api/admin/update/settings', { method: 'PATCH', body }), '网站更新配置已保存。', result => {
    const next = result as UpdateSettings;
    client.setQueryData(queryKey, next);
    setEnabled(next.enabled);
    setToken('');
    setClearToken(false);
    setValidation('');
    updateCapabilityChanged(next.enabled && next.tokenConfigured);
  }, []);
  const ready = token.trim().length > 0 || (item.tokenConfigured && !clearToken);
  return <form aria-label="网站更新配置" onSubmit={event => {
    event.preventDefault();
    if (enabled && !ready) {
      setValidation('开启自动更新前，请填写 GitHub Token。清除令牌时请先关闭自动更新。');
      return;
    }
    setValidation('');
    save.mutate({ enabled, ...(token.trim() ? { token: token.trim() } : {}), ...(clearToken ? { clearToken: true } : {}) });
  }}>
    <p className="oauth-intro">当前状态：{item.enabled && item.tokenConfigured ? '已开启自动更新' : item.enabled ? '尚未配置访问令牌' : '自动更新已关闭'}。</p>
    <label className="checkbox-field oauth-enable"><input type="checkbox" name="updateEnabled" checked={enabled} onChange={event => { setEnabled(event.target.checked); setValidation(''); }} disabled={save.isPending} />开启自动更新</label>
    <div className="form-grid">
      <Field label="更新仓库"><div className="copy-field"><input name="repositoryUrl" readOnly value={item.repositoryUrl} onFocus={event => event.currentTarget.select()} /><CopyButton value={item.repositoryUrl} label="复制地址" /></div></Field>
      <Field label="部署分支"><input name="branch" readOnly value={item.branch} onFocus={event => event.currentTarget.select()} /></Field>
    </div>
    <Field label="GitHub Token" help={item.tokenConfigured ? '已保存令牌，留空保留原值，完整值不会回显。请使用仅能访问本仓库、拥有 Actions 读写及 Contents 读取权限的令牌。' : '尚未保存令牌。请使用仅能访问本仓库、拥有 Actions 读写及 Contents 读取权限的令牌。'}><input name="updateToken" type="password" value={token} onChange={event => { setToken(event.target.value); setValidation(''); }} placeholder={item.tokenConfigured ? '留空保留已保存令牌' : '输入仓库访问令牌'} autoComplete="new-password" spellCheck={false} maxLength={4096} disabled={save.isPending || clearToken} /></Field>
    {item.tokenConfigured && <label className="checkbox-field oauth-clear-secret"><input type="checkbox" name="clearUpdateToken" checked={clearToken} onChange={event => { setClearToken(event.target.checked); if (event.target.checked) setToken(''); setValidation(''); }} disabled={save.isPending} />清除已保存的 GitHub Token</label>}
    {validation && <p className="oauth-validation" role="alert">{validation}</p>}
    <div className="oauth-save-row"><Button type="submit" pending={save.isPending}>保存更新配置</Button><p>更新沿用现有 CI、备份与回滚；页面不会轮询更新状态。</p></div>
  </form>;
}
