import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Auth from '../frontend/src/Auth.js';
import type { State } from '../frontend/src/api.js';

test('the real login dialog displays only available OAuth providers without polling', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('HTMLElement', window.HTMLElement); install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  // Detect browser input events after installing the DOM, rather than selecting
  // React's legacy non-DOM input-event shim during module initialization.
  const { createRoot } = await import('react-dom/client');
  // jsdom has dialog elements but no native modal implementation.
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
  let fetches = 0, timers = 0, closes = 0;
  install('fetch', async () => { fetches++; throw new Error('Rendering login providers must not make network requests.'); });
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  install('setTimeout', (...args: Parameters<typeof setTimeout>) => {
    // Native focus in jsdom may emit selectionchange using a one-shot timer.
    // Exclude only that browser implementation caller, never component timers.
    const caller = new Error().stack?.split('\n')[2] || '';
    if (!caller.includes('Selection-impl.js')) timers++;
    return timeout(...args);
  });
  install('setInterval', (...args: Parameters<typeof setInterval>) => { timers++; return interval(...args); });
  const windowTimeout = window.setTimeout.bind(window), windowInterval = window.setInterval.bind(window);
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => { timers++; return windowTimeout(...args); }) as typeof window.setTimeout;
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => { timers++; return windowInterval(...args); }) as typeof window.setInterval;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(window.document.getElementById('root')!);
  const state = (github: boolean, linuxdo: boolean): State => ({ user: null, tree: null, daily: null, providers: { github, linuxdo }, rules: { dailyFertilizer: 5, inventoryLimit: 10, coinsPerFeed: 10, growthPerFeed: 1, apiRateLimit: 60 } });
  const render = async (github: boolean, linuxdo: boolean) => {
    await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(Auth, { state: state(github, linuxdo), onClose: () => closes++ }))); });
  };
  const entries = () => Array.from(window.document.querySelectorAll<HTMLAnchorElement>('.auth-providers a'), entry => ({ text: entry.textContent, href: entry.getAttribute('href'), disabled: entry.getAttribute('aria-disabled') }));
  const assertProviders = (expected: string[]) => {
    assert.deepEqual(entries(), expected.map(provider => ({ text: provider === 'github' ? 'GitHub 登录' : 'Linux DO 登录', href: `/api/auth/${provider}/start`, disabled: null })));
    assert.equal(window.document.querySelectorAll('.auth-providers').length, expected.length ? 1 : 0);
    assert.equal(window.document.querySelectorAll('.divider').length, expected.length ? 1 : 0);
    assert.equal(window.document.querySelectorAll('input[name="username"]').length, 1, 'local account login remains available');
  };
  try {
    await t.test('neither provider hides third-party controls and the separator', async () => {
      await render(false, false); assertProviders([]);
      assert.equal(window.document.querySelector('dialog')?.getAttribute('open'), '');
      assert.ok(!window.document.body.textContent?.includes('尚未配置'));
    });
    await t.test('GitHub alone has one valid login link', async () => {
      await render(true, false); assertProviders(['github']);
    });
    await t.test('Linux DO alone has one valid login link', async () => {
      await render(false, true); assertProviders(['linuxdo']);
    });
    await t.test('both enabled providers are displayed', async () => {
      await render(true, true); assertProviders(['github', 'linuxdo']);
    });
    await t.test('an authoritative availability change removes a disabled option in place', async () => {
      await render(false, true); assertProviders(['linuxdo']);
      await render(false, false); assertProviders([]);
      assert.equal(closes, 0, 'configuration updates keep the login dialog open');
    });
    await t.test('switching to registration still hides unavailable providers', async () => {
      await render(true, false);
      const register = window.document.querySelector<HTMLButtonElement>('.auth-switch button')!;
      await act(async () => { register.click(); });
      assert.equal(window.document.querySelector('.dialog-header h2')?.textContent, '创建账号');
      assert.equal(window.document.querySelectorAll('input[name="displayName"]').length, 1);
      assertProviders(['github']);
      await render(false, false); assertProviders([]);
      const login = window.document.querySelector<HTMLButtonElement>('.auth-switch button')!;
      await act(async () => { login.click(); });
      assert.equal(window.document.querySelector('.dialog-header h2')?.textContent, '登录你的花园');
      assertProviders([]);
    });
    await t.test('provider rendering and mode changes create no requests or polling timers', async () => {
      assert.equal(fetches, 0);
      assert.equal(timers, 0);
    });
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
