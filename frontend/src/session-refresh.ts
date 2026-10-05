import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { queryClient, type State } from './api';

export function oauthLandingUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get('state') || (!params.get('code') && !params.get('error'))) return null;
  const landing = new URLSearchParams();
  for (const key of ['code', 'state', 'error']) {
    const value = params.get(key);
    if (value) landing.set(key, value);
  }
  return `/api/auth/oauth-landing?${landing.toString()}`;
}

export function useSessionRefresh(refetch: () => Promise<{ data?: State; error?: unknown }>, onAuthenticated: () => void, onFailure?: (message: string) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const consumed = useRef<string | null>(null);
  const authenticated = useRef(onAuthenticated);
  authenticated.current = onAuthenticated;
  const failed = useRef(onFailure);
  failed.current = onFailure;

  useEffect(() => {
    const landing = oauthLandingUrl(location.search);
    const params = new URLSearchParams(location.search);
    if (!landing && params.get('login') !== 'success' && params.get('bound') !== '1') return;
    const key = `${location.key}:${location.pathname}${location.search}`;
    if (consumed.current === key) return;
    consumed.current = key;
    if (landing) { window.location.replace(landing); return; }
    params.delete('login');
    params.delete('bound');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
    // OAuth returns are explicit events. Re-read the authoritative session once,
    // even when the browser restored a page that had cached guest data.
    void refetch().then(result => {
      if (result.error) {
        failed.current?.('暂时无法确认登录状态，请检查网络后重新登录。');
        return;
      }
      if (!result.data?.user) {
        failed.current?.('第三方授权已返回，但登录会话尚未建立。请在同一浏览器重新发起登录；若仍失败，请联系管理员检查回调记录。');
        return;
      }
      authenticated.current();
      return queryClient.invalidateQueries({ queryKey: ['identities'] });
    }).catch(() => failed.current?.('暂时无法确认登录状态，请检查网络后重新登录。'));
  }, [location.key, location.pathname, location.search, location.hash, navigate, refetch]);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void refetch().then(result => {
        if (result.error) return;
        if (result.data?.user) authenticated.current();
        return queryClient.invalidateQueries({ queryKey: ['identities'] });
      }).catch(() => undefined);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [refetch]);
}
