import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import RepositoryStatus, { repositoryUrl, actionsProgressUrl, updateCapabilityChanged, type UpdateStatus } from '../frontend/src/RepositoryStatus.js';
import { NoticeContext, type Notice } from '../frontend/src/ui.js';
import { queryClient } from '../frontend/src/api.js';

test('repository badge checks only on arrival or explicit actions and restricts automatic updates to admins', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('HTMLElement', window.HTMLElement); install('CustomEvent', window.CustomEvent);
  install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client');
  const current: UpdateStatus = { repositoryUrl, currentVersion: 'old-sha', latestVersion: 'old-sha', updateAvailable: false, phase: 'current', canUpdate: false, checkedAt: '2026-10-05T00:00:00.000Z' };
  const available: UpdateStatus = { ...current, latestVersion: 'new-sha', updateAvailable: true, phase: 'available', canUpdate: true };
  let answer: UpdateStatus = current, networkError = false, intervalCount = 0;
  let release: (() => void) | undefined;
  const requests: { path: string; method: string; body?: unknown; headers: Record<string, string> }[] = [];
  const notices: Notice[] = [];
  const interval = globalThis.setInterval;
  install('setInterval', (...args: Parameters<typeof setInterval>) => { intervalCount++; return interval(...args); });
  install('fetch', async (input: string, options?: RequestInit) => {
    requests.push({ path: String(input), method: options?.method || 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined, headers: options?.headers as Record<string, string> });
    if (release === undefined && options?.method === 'POST') {
      await new Promise<void>(resolve => { release = resolve; });
    }
    if (networkError) throw new Error('offline');
    return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
  });
  const Location = () => { const location = useLocation(); return createElement('output', { id: 'location' }, location.pathname + location.hash); };
  let root: ReturnType<typeof createRoot> | undefined;
  const unmount = async () => { if (root) { await act(async () => { root?.unmount(); }); root = undefined; } };
  const render = async (admin: boolean) => {
    if (!root) root = createRoot(window.document.getElementById('root')!);
    await act(async () => { root!.render(createElement(React.StrictMode, {}, createElement(MemoryRouter, {}, createElement(NoticeContext.Provider, { value: notice => notices.push(notice) }, createElement(RepositoryStatus, { isAdmin: admin }), createElement(Location))))); });
  };
  const badge = () => window.document.querySelector<HTMLButtonElement>('.repository-update')!;
  const click = () => act(async () => { badge().click(); });

  try {
    await t.test('deployment progress links support configured forks and remain within their GitHub Actions routes', () => {
      const fork = { ...available, repositoryUrl: 'https://github.com/deploy-owner/my-tree', runUrl: 'https://github.com/deploy-owner/my-tree/actions/runs/42' };
      assert.equal(actionsProgressUrl(fork), fork.runUrl);
      assert.equal(actionsProgressUrl({ ...fork, runUrl: `${repositoryUrl}/actions/runs/42` }), null);
      assert.equal(actionsProgressUrl({ ...fork, repositoryUrl: 'https://github.com.evil.test/deploy-owner/my-tree' }), null);
      assert.equal(actionsProgressUrl({ ...fork, runUrl: fork.repositoryUrl + '/actions/../../other/actions/runs/42' }), null);
      assert.equal(actionsProgressUrl({ ...fork, repositoryUrl: 'https://github.com/deploy-owner/..', runUrl: 'https://github.com/deploy-owner/../actions/runs/42' }), null);
      assert.equal(actionsProgressUrl({ ...fork, runUrl: 'javascript:alert(1)' }), null);
    });
    await t.test('one initial check survives StrictMode; focus, reconnect and cache invalidation do not recheck', async () => {
      await render(false);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, '/api/system/update');
      assert.ok(badge().classList.contains('current'));
      const link = window.document.querySelector<HTMLAnchorElement>('.repository-link')!;
      assert.equal(link.href, repositoryUrl);
      assert.equal(link.target, '_blank');
      assert.equal(link.getAttribute('aria-label'), '打开智慧树 GitHub 仓库');
      assert.equal(link.querySelector('button'), null, 'navigation and update controls are independent targets');
      await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); await queryClient.invalidateQueries(); });
      await render(true);
      assert.equal(requests.length, 1, 'role changes do not trigger background checks');
      await click();
      assert.equal(requests.length, 2, 'a deliberate green-dot click checks exactly once');
    });
    await t.test('network failure is unknown instead of a green latest-version claim, and manual retry recovers', async () => {
      await unmount(); networkError = true;
      await render(false);
      assert.ok(badge().classList.contains('unknown'));
      assert.match(badge().getAttribute('aria-label')!, /失败.*重试/);
      assert.ok(!badge().classList.contains('current'));
      networkError = false; answer = current;
      const before = requests.length;
      await click();
      assert.equal(requests.length, before + 1);
      assert.ok(badge().classList.contains('current'));
    });
    await t.test('visitors see yellow and explanatory feedback without launching deployments', async () => {
      await unmount(); answer = available;
      await render(false);
      assert.ok(badge().classList.contains('available'));
      const before = requests.length;
      await click();
      assert.equal(requests.length, before);
      assert.match(notices.at(-1)!.message, /联系管理员/);
      assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    });
    await t.test('missing update credentials guide admins to settings, and saving capability changes makes no request', async () => {
      await unmount(); answer = { ...available, canUpdate: false };
      await render(true);
      const before = requests.length;
      await click();
      assert.equal(requests.length, before);
      assert.equal(window.document.getElementById('location')!.textContent, '/admin/site#website-update');
      assert.match(notices.at(-1)!.message, /配置一键更新凭据/);
      await act(async () => { updateCapabilityChanged(true); });
      assert.equal(requests.length, before);
    });
    await t.test('a configured admin starts one idempotent update; no polling follows acceptance', async () => {
      answer = { ...available, phase: 'running', runUrl: `${repositoryUrl}/actions/runs/1234`, message: '更新已启动。' };
      const before = requests.length;
      await act(async () => { badge().click(); badge().click(); });
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1)!.path, '/api/admin/update');
      assert.deepEqual(requests.at(-1)!.body, { expectedVersion: 'new-sha' });
      assert.ok(requests.at(-1)!.headers['Idempotency-Key']);
      assert.equal(badge().disabled, true);
      await act(async () => { release!(); });
      assert.ok(badge().classList.contains('running'));
      assert.equal(window.document.querySelector<HTMLAnchorElement>('.repository-progress')!.href, answer.runUrl);
      await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); });
      assert.equal(requests.length, before + 1);
      answer = current;
      await click();
      assert.equal(requests.length, before + 2, 'running state only refreshes after an explicit click');
      assert.equal(requests.at(-1)!.method, 'GET');
      assert.equal(window.document.querySelector('.repository-progress'), null);
      assert.ok(badge().classList.contains('current'));
      assert.equal(intervalCount, 0);
    });
  } finally {
    release?.();
    await unmount();
    queryClient.clear();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
