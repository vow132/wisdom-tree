import { providerName, type Identity } from './api';

export default function AdminIdentities({ identities }: { identities: readonly Identity[] }) {
  if (!identities.length) return <span className="admin-identity-empty">未绑定第三方账号</span>;
  return <ul className="admin-identities" aria-label="已绑定的第三方账号">
    {identities.map(identity => <li key={`${identity.provider}:${identity.providerUserId}`}>
      <div className="admin-identity-heading"><span className="admin-identity-provider">{providerName(identity.provider)}</span><strong>{identity.displayName.trim() || '未提供昵称'}</strong></div>
      <small className="admin-identity-id">账号 ID：<code>{identity.providerUserId}</code></small>
    </li>)}
  </ul>;
}
