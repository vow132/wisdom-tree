import { useState } from 'react';
import { api, type State } from './api';
import { Button, Dialog, Field, submitData, textField, useAction } from './ui';

export default function Auth({ state, onClose }: { state: State; onClose: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const providers = (['github', 'linuxdo'] as const).filter(provider => state.providers[provider]);
  const action = useAction<{ username: string; password: string; displayName?: string }>(body => api(`/api/auth/${mode}`, { method: 'POST', body }), mode === 'login' ? '登录成功，欢迎回来。' : '账号已创建，可以领取种子了。', onClose);
  return <Dialog title={mode === 'login' ? '登录你的花园' : '创建账号'} onClose={onClose}>
    <p className="muted">种下智慧树，积累金币，连接你的 Agent。</p>
    {providers.length > 0 && <><div className="auth-providers">
      {providers.map(provider => <a key={provider} href={`/api/auth/${provider}/start`} className="provider-button">{provider === 'github' ? 'GitHub 登录' : 'Linux DO 登录'}</a>)}
    </div><div className="divider">账号与密码</div></>}
    <form onSubmit={event => { const form = submitData(event); action.mutate({ username: textField(form, 'username'), password: String(form.get('password') ?? ''), ...(mode === 'register' ? { displayName: textField(form, 'displayName') } : {}) }); }}>
      <Field label="用户名"><input name="username" autoComplete="username" required maxLength={40} autoFocus /></Field>
      {mode === 'register' && <Field label="显示名称"><input name="displayName" autoComplete="nickname" maxLength={60} placeholder="你的花园主人名字" /></Field>}
      <Field label="密码" help={mode === 'register' ? '至少 8 位。' : undefined}><input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 8 : undefined} /></Field>
      <Button type="submit" pending={action.isPending} className="full-width">{mode === 'login' ? '登录' : '注册并登录'}</Button>
    </form>
    <p className="auth-switch">{mode === 'login' ? '还没有账号？' : '已经有账号？'}<button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? '注册' : '去登录'}</button></p>
  </Dialog>;
}
