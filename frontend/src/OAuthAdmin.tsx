import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, providerName, queryClient, type OAuthProviderConfig } from './api';
import { Button, CopyButton, Field, PanelTitle, QueryStatus, useAction } from './ui';

type OAuthSettings = { items: OAuthProviderConfig[] };
type OAuthUpdate = { enabled: boolean; clientId: string; clientSecret?: string; clearSecret?: boolean };
const queryKey = ['admin', 'oauth'] as const;

export default function OAuthAdmin() {
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api<OAuthSettings>('/api/admin/oauth', { signal }) });
  return <section className="panel oauth-admin-panel">
    <PanelTitle title="第三方登录" description="配置 GitHub 和 Linux DO 的应用凭证，选择是否开放登录与账号绑定。" />
    <p className="oauth-intro">关闭后，登录页面会隐藏对应入口，已绑定的账号关系仍保留。保存后立即生效。</p>
    <QueryStatus query={query} empty={!query.data?.items.length}>
      <div className="oauth-provider-list">{query.data?.items.map(item => <ProviderForm key={item.provider} item={item} />)}</div>
    </QueryStatus>
  </section>;
}

function ProviderForm({ item }: { item: OAuthProviderConfig }) {
  const name = providerName(item.provider);
  const [enabled, setEnabled] = useState(item.enabled);
  const [clientId, setClientId] = useState(item.clientId);
  const [clientSecret, setClientSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [validation, setValidation] = useState('');
  const save = useAction<OAuthUpdate>(body => api<{ item: OAuthProviderConfig }>(`/api/admin/oauth/${item.provider}`, { method: 'PATCH', body }), `${name} 登录配置已保存。`, result => {
    const next = (result as { item: OAuthProviderConfig }).item;
    queryClient.setQueryData<OAuthSettings>(queryKey, previous => ({ items: (previous?.items || []).map(provider => provider.provider === next.provider ? next : provider) }));
    setEnabled(next.enabled);
    setClientId(next.clientId);
    setClientSecret('');
    setClearSecret(false);
    setValidation('');
    // Refresh the public availability once; there is no polling or OAuth-settings refetch.
    void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
  }, []);
  const ready = clientId.trim().length > 0 && (clientSecret.trim().length > 0 || (item.hasClientSecret && !clearSecret));
  const savedStatus = item.available ? '已开启' : item.enabled ? '配置不完整' : '已关闭';
  const sourceText = item.source === 'environment' ? '当前读取服务器环境变量；保存后由后台配置接管。' : item.source === 'database' ? '当前使用后台保存的配置。' : '尚未保存应用凭证。';
  return <form className="oauth-provider-form" aria-label={`${name} 登录配置`} onSubmit={event => {
    event.preventDefault();
    if (enabled && !ready) {
      setValidation('开启登录前，请填写 Client ID 和 Client Secret。清除密钥时请先关闭登录。');
      return;
    }
    setValidation('');
    save.mutate({ enabled, clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}), ...(clearSecret ? { clearSecret: true } : {}) });
  }}>
    <div className="oauth-provider-heading"><div><h3>{name}</h3><p>{sourceText}</p></div><span className={`status ${item.available ? '' : 'oauth-closed'}`}>{savedStatus}</span></div>
    <label className="checkbox-field oauth-enable"><input type="checkbox" name="enabled" checked={enabled} onChange={event => { setEnabled(event.target.checked); setValidation(''); }} disabled={save.isPending} />开启 {name} 登录</label>
    <div className="form-grid">
      <Field label="Client ID" help="在第三方平台创建 OAuth 应用后获取。"><input name="clientId" value={clientId} onChange={event => { setClientId(event.target.value); setValidation(''); }} autoComplete="off" spellCheck={false} maxLength={512} disabled={save.isPending} /></Field>
      <Field label="Client Secret" help={item.hasClientSecret ? '已保存密钥，留空会保留原密钥。完整值不会回显。' : '尚未保存密钥；开启登录前需填写。'}><input name="clientSecret" type="password" value={clientSecret} onChange={event => { setClientSecret(event.target.value); setValidation(''); }} placeholder={item.hasClientSecret ? '留空保留已保存密钥' : '输入应用密钥'} autoComplete="new-password" maxLength={4096} disabled={save.isPending || clearSecret} /></Field>
    </div>
    <Field label="授权回调地址" help="将此完整地址填入第三方应用的回调 URL 设置。它使用网站配置的公开地址。"><div className="copy-field oauth-callback"><input name="callbackUrl" readOnly value={item.callbackUrl} onFocus={event => event.currentTarget.select()} /><CopyButton value={item.callbackUrl} label="复制地址" /></div></Field>
    {item.hasClientSecret && <label className="checkbox-field oauth-clear-secret"><input type="checkbox" name="clearSecret" checked={clearSecret} onChange={event => { setClearSecret(event.target.checked); if (event.target.checked) setClientSecret(''); setValidation(''); }} disabled={save.isPending} />清除已保存的 Client Secret</label>}
    {validation && <p className="oauth-validation" role="alert">{validation}</p>}
    <div className="oauth-save-row"><Button type="submit" pending={save.isPending}>保存 {name} 配置</Button><p>启用且凭证完整时，才显示登录入口。</p></div>
  </form>;
}
