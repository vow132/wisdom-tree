import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, number, queryClient, type State } from './api';
import { Button, ErrorMessage, NoticeContext, useAction, type Notice } from './ui';
import Auth from './Auth';
import Garden from './Garden';
import Account from './Account';
import Admin from './Admin';
import ThemeSelector from './Theme';

export default function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => api<State>('/api/me', { signal }) });
  const [auth, setAuth] = useState(false);
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([]);
  const notify = useCallback((notice: Notice) => { const id = Date.now() + Math.random(); setNotices(items => [...items.slice(-2), { ...notice, id }]); window.setTimeout(() => setNotices(items => items.filter(item => item.id !== id)), notice.kind === 'error' ? 9000 : 5000); }, []);
  const location = useLocation();
  const previousUser = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!me.data) return;
    const userId = me.data.user?.id || null;
    if (previousUser.current !== undefined && previousUser.current !== userId) queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'me' });
    previousUser.current = userId;
  }, [me.data?.user?.id]);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => { const params = new URLSearchParams(location.search); const error = params.get('error'); if (error) notify({ kind: 'error', message: `账号授权失败：${error}` }); }, [location.search, notify]);
  return <NoticeContext.Provider value={notify}>
    <header className="site-header"><div className="header-inner"><Link to="/" className="brand">智慧树<span>养成与 API</span></Link><nav aria-label="主导航"><NavLink to="/" end>花园</NavLink><NavLink to="/api">API 控制台</NavLink><NavLink to="/account">我的账号</NavLink>{me.data?.user?.role === 'admin' && <NavLink to="/admin">管理</NavLink>}</nav><div className="header-account"><ThemeSelector />{me.data?.user ? <><span className="coin-balance">{number(me.data.user.coins)} <small>金币</small></span><span className="header-name">{me.data.user.displayName || me.data.user.username}</span><Logout /></> : <Button variant="secondary" onClick={() => setAuth(true)} disabled={!me.data}>登录</Button>}</div></div></header>
    <main className={`main ${location.pathname.startsWith('/admin') ? 'admin-main' : ''}`}>
      {me.isPending ? <div className="page-loading" role="status"><h1>正在打开花园…</h1><p>连接你的智慧树。</p></div> : me.error ? <ErrorMessage error={me.error} retry={() => void me.refetch()} /> : me.data && <Routes>
        <Route path="/" element={<Garden key={me.data.user?.id || 'guest'} state={me.data} onLogin={() => setAuth(true)} />} />
        <Route path="/api" element={<Account state={me.data} view="api" onLogin={() => setAuth(true)} />} />
        <Route path="/account" element={<Account state={me.data} view="account" onLogin={() => setAuth(true)} />} />
        <Route path="/admin/*" element={<Admin state={me.data} onLogin={() => setAuth(true)} />} />
        <Route path="*" element={<div className="empty-state"><h1>这个页面还没有种下东西</h1><Link to="/">返回花园</Link></div>} />
      </Routes>}
    </main>
    <footer className="site-footer"><span>一棵树，一个慢慢生长的花园。</span><Link to="/api">查看模型与接入说明</Link></footer>
    {auth && me.data && <Auth state={me.data} onClose={() => setAuth(false)} />}
    <div className="notices" aria-live="polite">{notices.map(item => <div className={`notice ${item.kind}`} key={item.id}><span>{item.message}</span><button aria-label="关闭提示" onClick={() => setNotices(items => items.filter(notice => notice.id !== item.id))}>关闭</button></div>)}</div>
  </NoticeContext.Provider>;
}
function Logout() {
  const action = useAction<void>(() => api('/api/auth/logout', { method: 'POST' }), '已退出登录。');
  return <Button variant="quiet" onClick={() => action.mutate()} pending={action.isPending}>退出</Button>;
}
