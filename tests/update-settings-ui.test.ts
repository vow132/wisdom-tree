import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UpdaterSettings, { type UpdateSettings } from '../frontend/src/UpdaterSettings.js';

test('website update settings preserve, replace and clear a write-only token without triggering a deployment', async t => {
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
  const requests: { method: string; body: Record<string, unknown> | null }[] = [];
  let item: UpdateSettings = { enabled: false, tokenConfigured: false, repositoryUrl: 'https://github.com/vow132/wisdom-tree', branch: 'codex/wisdom-tree' };
  install('fetch', async (path: string, options: RequestInit) => {
    assert.equal(path, '/api/admin/update/settings', 'settings never call GitHub or the deployment endpoint');
    const body = options.body ? JSON.parse(String(options.body)) : null;
    const method = options.method || 'GET';
    requests.push({ method, body });
    if (method === 'PATCH') item = { ...item, enabled: body.enabled, tokenConfigured: body.clearToken ? false : body.token ? true : item.tokenConfigured };
    return new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  let intervals = 0;
  const interval = globalThis.setInterval;
  install('setInterval', (...args: Parameters<typeof setInterval>) => { intervals++; return interval(...args); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false, gcTime: Infinity } } });
  const root = createRoot(window.document.getElementById('root')!);
  const submit = async () => {
    await act(async () => {
      window.document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  };
  const toggle = async (name: string) => { await act(async () => { window.document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.click(); }); };
  const tokenInput = () => window.document.querySelector<HTMLInputElement>('input[name="updateToken"]')!;
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(UpdaterSettings)));
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.equal(requests.length, 1);
    await t.test('missing token blocks enabling with an actionable inline message', async () => {
      await toggle('updateEnabled'); await submit();
      assert.equal(requests.length, 1);
      assert.ok(window.document.querySelector('[role="alert"]')?.textContent?.includes('GitHub Token'));
    });
    await t.test('a new token is write-only and cleared after saving', async () => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(tokenInput(), 'test-write-only-update-token');
        tokenInput().dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await submit();
      assert.deepEqual(requests.at(-1), { method: 'PATCH', body: { enabled: true, token: 'test-write-only-update-token' } });
      assert.equal(tokenInput().value, '');
      assert.ok(window.document.body.textContent?.includes('已开启自动更新'));
      assert.ok(!window.document.body.innerHTML.includes('test-write-only-update-token'));
      assert.equal(window.document.querySelector<HTMLInputElement>('input[name="repositoryUrl"]')?.readOnly, true);
      assert.equal(window.document.querySelector<HTMLInputElement>('input[name="branch"]')?.readOnly, true);
    });
    await t.test('empty input preserves the existing token instead of sending an empty value', async () => {
      await submit();
      assert.deepEqual(requests.at(-1), { method: 'PATCH', body: { enabled: true } });
      assert.equal(tokenInput().value, '');
    });
    await t.test('clearing a token requires disabling, then sends only the clear flag', async () => {
      await toggle('clearUpdateToken');
      const before = requests.length;
      await submit();
      assert.equal(requests.length, before);
      assert.equal(tokenInput().disabled, true);
      await toggle('updateEnabled'); await submit();
      assert.deepEqual(requests.at(-1), { method: 'PATCH', body: { enabled: false, clearToken: true } });
      assert.equal(window.document.querySelector('input[name="clearUpdateToken"]'), null);
      assert.equal(tokenInput().value, '');
      assert.equal(tokenInput().disabled, false);
    });
    assert.equal(requests.filter(request => request.method === 'GET').length, 1, 'saved settings update the cache without a second GET');
    assert.equal(intervals, 0, 'the settings form schedules no polling');
  } finally {
    await act(async () => { root.unmount(); }); client.clear(); dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
