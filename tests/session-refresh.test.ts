import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { oauthLandingUrl, useSessionRefresh } from '../frontend/src/session-refresh.js';
import { queryClient, type State } from '../frontend/src/api.js';

test('OAuth return refreshes the session once and browser history restores refresh only on a persisted pageshow', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('HTMLElement', window.HTMLElement); install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client');
  const state: State = { user: { id: 'linuxdo-user', username: 'linuxdo_123', displayName: '第三方名字', role: 'user', status: 'active', coins: 0, fertilizer: 0 }, tree: null, daily: null, providers: { github: true, linuxdo: true }, rules: { dailyFertilizer: 5, inventoryLimit: 10, coinsPerFeed: 10, growthPerFeed: 1, apiRateLimit: 60 } };
  let refetches = 0, authenticated = 0, intervals = 0;
  let returnedState = state, networkFailure = false, queryError: Error | undefined;
  const failures: string[] = [];
  const refetch = async () => {
    refetches++;
    if (networkFailure) throw new Error('network unavailable');
    if (!queryError) queryClient.setQueryData(['me'], returnedState);
    return { data: returnedState, error: queryError };
  };
  const interval = globalThis.setInterval;
  install('setInterval', (...args: Parameters<typeof setInterval>) => { intervals++; return interval(...args); });
  const Harness = () => {
    useSessionRefresh(refetch, () => authenticated++, message => failures.push(message));
    const location = useLocation();
    return createElement('output', {}, location.pathname + location.search + location.hash);
  };
  let root: ReturnType<typeof createRoot> | undefined;
  const unmount = async () => { if (root) { await act(async () => { root?.unmount(); }); root = undefined; } };
  const mount = async (entry: string) => {
    await unmount();
    root = createRoot(window.document.getElementById('root')!);
    await act(async () => { root!.render(createElement(React.StrictMode, {}, createElement(MemoryRouter, { initialEntries: [entry] }, createElement(Harness)))); });
  };
  try {
    await t.test('login success replaces stale guest state and removes its one-shot marker without removing unrelated URL data', async () => {
      queryClient.setQueryData(['me'], { ...state, user: null });
      await mount('/?login=success&tab=garden#tree');
      assert.equal(refetches, 1, 'StrictMode replays do not duplicate the session request');
      assert.equal(authenticated, 1);
      assert.equal(queryClient.getQueryData<State>(['me'])!.user!.displayName, '第三方名字');
      assert.equal(window.document.querySelector('output')!.textContent, '/?tab=garden#tree');
    });
    await t.test('binding success invalidates existing identity cache and consumes its marker once', async () => {
      queryClient.setQueryData(['identities'], { items: [] });
      await mount('/account?bound=1');
      assert.equal(refetches, 2);
      assert.equal(authenticated, 2);
      assert.equal(queryClient.getQueryState(['identities'])!.isInvalidated, true);
      assert.equal(window.document.querySelector('output')!.textContent, '/account');
    });
    await t.test('ordinary navigation/focus causes no refresh, persisted pageshow refreshes once, and cleanup removes its listener', async () => {
      await mount('/account');
      assert.equal(refetches, 2);
      await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: false })); });
      assert.equal(refetches, 2);
      await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); });
      assert.equal(refetches, 3);
      await unmount();
      await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); });
      assert.equal(refetches, 3);
      assert.equal(intervals, 0);
    });
    await t.test('a success redirect without a real session gives a visible failure once and preserves identity cache', async () => {
      returnedState = { ...state, user: null };
      queryClient.removeQueries({ queryKey: ['identities'] });
      queryClient.setQueryData(['identities'], { items: [] });
      const authenticatedBefore = authenticated;
      await mount('/?login=success');
      assert.equal(refetches, 4);
      assert.equal(authenticated, authenticatedBefore);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /会话尚未建立/);
      assert.equal(queryClient.getQueryState(['identities'])!.isInvalidated, false);
      assert.equal(window.document.querySelector('output')!.textContent, '/');
      await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); });
      assert.equal(failures.length, 1, 'ordinary cached guest pages do not display OAuth failures');
      returnedState = state;
    });
    await t.test('network failure on an OAuth return is reported and does not start polling', async () => {
      networkFailure = true;
      const authenticatedBefore = authenticated;
      await mount('/account?bound=1');
      assert.equal(refetches, 6);
      assert.equal(authenticated, authenticatedBefore);
      assert.equal(failures.length, 2);
      assert.match(failures[1], /检查网络/);
      assert.equal(window.document.querySelector('output')!.textContent, '/account');
      assert.equal(intervals, 0);
      networkFailure = false;
    });
    await t.test('a resolved TanStack query error with stale authenticated data is not treated as login success', async () => {
      queryError = new Error('request failed');
      const authenticatedBefore = authenticated;
      await mount('/?login=success');
      assert.equal(refetches, 7);
      assert.equal(authenticated, authenticatedBefore);
      assert.equal(failures.length, 3);
      assert.match(failures[2], /检查网络/);
      await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); });
      assert.equal(authenticated, authenticatedBefore);
      assert.equal(failures.length, 3);
      assert.equal(intervals, 0);
      queryError = undefined;
    });
    await t.test('misconfigured home callbacks send only OAuth fields to a fixed same-origin backend landing route', () => {
      assert.equal(oauthLandingUrl('?code=abc%2B123&state=opaque&redirect_uri=https%3A%2F%2Fevil.test&provider=github'), '/api/auth/oauth-landing?code=abc%2B123&state=opaque');
      assert.equal(oauthLandingUrl('?error=access_denied&state=opaque'), '/api/auth/oauth-landing?state=opaque&error=access_denied');
      assert.equal(oauthLandingUrl('?code=abc'), null);
      assert.equal(oauthLandingUrl('?state=opaque'), null);
      assert.equal(oauthLandingUrl('?login=success'), null);
    });
  } finally {
    await unmount();
    queryClient.clear();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
