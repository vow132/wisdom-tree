import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import React, { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Users from '../frontend/src/AdminUsers.js';
import { queryClient, type AdminUser } from '../frontend/src/api.js';
import { NoticeContext, type Notice } from '../frontend/src/ui.js';

test('user management supports accessible page selection, confirmed bulk actions and pending locks without polling', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173/admin/users' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('HTMLElement', window.HTMLElement); install('FormData', window.FormData);
  install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(window.HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  const options = queryClient.getDefaultOptions();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: Infinity } });
  let users: AdminUser[] = Array.from({ length: 24 }, (_, index) => ({ id: randomUUID(), username: `fixture_${String(index + 1).padStart(2, '0')}`,
    displayName: `演示用户${index + 1}`, role: 'user', status: index === 1 ? 'banned' : 'active', coins: 10, fertilizer: 2, identities: [] }));
  const requests: { path: string; method: string; body?: { action: string; ids: string[] } }[] = [];
  const notices: Notice[] = [];
  let releaseBatch: (() => void) | undefined;
  let rejectNextBatch = false;
  let intervals = 0;
  const originalInterval = globalThis.setInterval;
  install('setInterval', (...args: Parameters<typeof setInterval>) => { intervals++; return originalInterval(...args); });
  install('fetch', async (path: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path.startsWith('/api/admin/users?') && method === 'GET') {
      const url = new URL(path, 'http://127.0.0.1:5173');
      const search = url.searchParams.get('search') || '', page = Number(url.searchParams.get('page') || 1);
      const filtered = users.filter(user => `${user.username}|${user.displayName}`.includes(search));
      return new Response(JSON.stringify({ items: filtered.slice((page - 1) * 20, page * 20), total: filtered.length }), { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/admin/users/batch' && method === 'POST') {
      await new Promise<void>(resolve => { releaseBatch = resolve; });
      releaseBatch = undefined;
      if (rejectNextBatch) {
        rejectNextBatch = false;
        return new Response(JSON.stringify({ error: { code: 'last_admin', message: '至少需要保留一位有效管理员。' } }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      if (body.action === 'delete') users = users.filter(user => !body.ids.includes(user.id));
      else users = users.map(user => body.ids.includes(user.id) ? { ...user, status: body.action === 'ban' ? 'banned' : 'active' } : user);
      return new Response(JSON.stringify({ ok: true, action: body.action, affected: body.ids.length, ids: body.ids }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected endpoint ${method} ${path}`);
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  const Route = () => createElement('output', { id: 'current-route' }, useLocation().pathname);
  const renderUsers = (currentUserId: string) => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(NoticeContext.Provider, { value: notice => notices.push(notice) }, createElement(MemoryRouter, { initialEntries: ['/admin/users'] }, createElement(Users, { currentUserId }), createElement(Route)))));
  const waitForUI = async (ready: () => boolean, message: string) => {
    const limit = Date.now() + 10_000;
    // React Query notifies subscribers on the next tick, after fetch settles.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    while (!ready() && Date.now() < limit) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(ready(), message);
  };
  const button = (text: string, container: ParentNode = window.document) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  const rowCheckboxes = () => [...window.document.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
  const all = () => window.document.querySelector<HTMLInputElement>('input[aria-label="全选当前页用户"]')!;
  const dialog = () => window.document.querySelector<HTMLDialogElement>('dialog')!;
  const selection = () => window.document.querySelector('.user-selection-summary [role="status"]')?.textContent;
  const batchRequests = () => requests.filter(item => item.path === '/api/admin/users/batch');
  const click = async (element: HTMLElement) => { assert.ok(element, 'click target must exist'); await act(async () => { element.click(); }); };
  const search = async (value: string) => {
    await act(async () => {
      const input = window.document.querySelector<HTMLInputElement>('input[name="search"]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    const expectedRows = Math.min(20, users.filter(user => `${user.username}|${user.displayName}`.includes(value)).length);
    await waitForUI(() => rowCheckboxes().length === expectedRows && !queryClient.isFetching() && !queryClient.isMutating(), 'search must settle to its visible result rows');
  };
  const finishBatch = async () => {
    assert.ok(releaseBatch, 'a pending bulk request must exist');
    await act(async () => { releaseBatch!(); });
    await waitForUI(() => queryClient.isMutating() === 0 && queryClient.isFetching() === 0 && !window.document.querySelector('button[aria-busy="true"]'), 'bulk action and refreshed list must settle');
  };
  try {
    await act(async () => { renderUsers('other-admin'); });
    await waitForUI(() => rowCheckboxes().length === 20 && !queryClient.isFetching(), 'first user page must load');

    await t.test('row checkboxes and partial selection use meaningful accessible labels', async () => {
      assert.equal(all().checked, false); assert.equal(all().indeterminate, false);
      for (const text of ['批量封禁', '批量解封', '彻底删除', '清空选择']) assert.equal(button(text).disabled, true);
      assert.equal(rowCheckboxes()[0].getAttribute('aria-label'), '选择用户 演示用户1');
      await click(rowCheckboxes()[0]);
      assert.equal(all().checked, false); assert.equal(all().indeterminate, true);
      assert.equal(selection(), '已选 1 位 · 仅当前页');
      await click(rowCheckboxes()[1]);
      assert.equal(selection(), '已选 2 位 · 仅当前页');
      await click(button('清空选择'));
      assert.equal(selection(), '已选 0 位 · 仅当前页'); assert.equal(all().indeterminate, false);
    });

    await t.test('select all is limited to the visible page and opening or cancelling a confirmation sends no mutation', async () => {
      await click(all());
      assert.equal(rowCheckboxes().filter(item => item.checked).length, 20);
      assert.equal(all().checked, true); assert.equal(selection(), '已选 20 位 · 仅当前页');
      await click(button('批量封禁'));
      assert.equal(dialog().querySelector('h2')?.textContent, '批量封禁用户');
      assert.equal(dialog().querySelectorAll('[aria-label="操作用户"] li').length, 20);
      assert.equal(batchRequests().length, 0);
      await click(button('取消', dialog()));
      assert.equal(window.document.querySelector('dialog'), null); assert.equal(batchRequests().length, 0);
      await click(button('下一页'));
      await waitForUI(() => rowCheckboxes().length === 4 && !queryClient.isFetching(), 'second page must contain the remaining four users');
      assert.equal(selection(), '已选 0 位 · 仅当前页'); assert.equal(all().checked, false);
      await click(all());
      await click(button('上一页'));
      await waitForUI(() => rowCheckboxes().length === 20 && !queryClient.isFetching(), 'return to the first page');
      assert.equal(selection(), '已选 0 位 · 仅当前页');
    });

    await t.test('submitting a search clears old selection and a single-row ban is still confirmed', async () => {
      await click(rowCheckboxes()[0]);
      await search('fixture_23');
      assert.equal(rowCheckboxes().length, 1); assert.equal(selection(), '已选 0 位 · 仅当前页');
      await click(button('封禁', window.document.querySelector('tbody')!));
      assert.equal(dialog().querySelector('h2')?.textContent, '封禁用户');
      assert.match(dialog().textContent || '', /阻止登录和 API 调用/);
      assert.equal(batchRequests().length, 0);
      await click(button('封禁', dialog()));
      await waitForUI(() => Boolean(releaseBatch) && Boolean(dialog().querySelector('button[aria-busy="true"]')), 'confirmed ban must start one request');
      assert.deepEqual(batchRequests()[0].body, { ids: [users[22].id], action: 'ban' });
      assert.equal(rowCheckboxes()[0].disabled, true);
      assert.equal(all().disabled, true);
      assert.equal(window.document.querySelector<HTMLInputElement>('input[name="search"]')!.disabled, true);
      assert.equal(button('搜索').disabled, true);
      assert.equal(button('取消', dialog()).disabled, true);
      assert.equal(dialog().querySelector<HTMLButtonElement>('button[aria-label="关闭对话框"]')!.disabled, true);
      const cancelEvent = new window.Event('cancel', { cancelable: true });
      await act(async () => { dialog().dispatchEvent(cancelEvent); });
      assert.equal(cancelEvent.defaultPrevented, true); assert.ok(dialog());
      await click(button('处理中…', dialog()));
      assert.equal(batchRequests().length, 1, 'a disabled pending confirm cannot submit again');
      await finishBatch();
      assert.equal(window.document.querySelector('dialog'), null);
      assert.equal(button('解封', window.document.querySelector('tbody')!).disabled, false);
      assert.ok(notices.some(item => item.message === '已封禁 1 位用户。'));
    });

    await t.test('multi-user unban is one request and updates the list after success', async () => {
      await search('');
      await click(rowCheckboxes()[0]); await click(rowCheckboxes()[1]);
      const ids = [users[0].id, users[1].id];
      await click(button('批量解封'));
      assert.equal(dialog().querySelector('h2')?.textContent, '批量解封用户');
      await click(button('解封', dialog()));
      await waitForUI(() => Boolean(releaseBatch), 'bulk unban must start');
      assert.equal(batchRequests().length, 2);
      assert.deepEqual(batchRequests()[1].body, { ids, action: 'unban' });
      await finishBatch();
      assert.equal(selection(), '已选 0 位 · 仅当前页');
      assert.equal(window.document.querySelectorAll('tbody .status.banned').length, 0);
    });

    await t.test('an administrator protection error keeps the selected users and confirmation available for recovery', async () => {
      await click(rowCheckboxes()[0]); await click(rowCheckboxes()[1]);
      await click(button('批量封禁'));
      rejectNextBatch = true;
      await click(button('封禁', dialog()));
      await waitForUI(() => Boolean(releaseBatch), 'rejected batch must begin');
      await finishBatch();
      assert.equal(selection(), '已选 2 位 · 仅当前页');
      assert.equal(button('封禁', dialog()).disabled, false);
      assert.ok(notices.some(item => item.kind === 'error' && /有效管理员/.test(item.message)));
      await click(button('取消', dialog()));
    });

    await t.test('bulk deletion describes all removed data and removes the selected rows after one confirmed request', async () => {
      const ids = [users[0].id, users[1].id];
      const before = batchRequests().length;
      await click(button('彻底删除'));
      assert.equal(dialog().querySelector('h2')?.textContent, '批量彻底删除用户');
      assert.match(dialog().textContent || '', /账户、智慧树、金币、肥料、第三方绑定、API 密钥、调用记录和收支账本将全部彻底移除，无法恢复/);
      assert.equal(batchRequests().length, before, 'deletion must await explicit confirmation');
      await click(button('彻底删除', dialog()));
      await waitForUI(() => Boolean(releaseBatch), 'confirmed deletion starts');
      assert.equal(batchRequests().length, before + 1); assert.deepEqual(batchRequests().at(-1)!.body, { ids, action: 'delete' });
      await finishBatch();
      assert.equal(selection(), '已选 0 位 · 仅当前页');
      assert.equal(window.document.querySelector('input[aria-label="选择用户 演示用户1"]'), null);
      assert.equal(window.document.querySelector('input[aria-label="选择用户 演示用户2"]'), null);
    });

    await t.test('a refreshed page discards selections for users removed elsewhere', async () => {
      await click(rowCheckboxes()[0]); await click(rowCheckboxes()[1]);
      const goneId = users[0].id;
      users = users.filter(user => user.id !== goneId);
      const beforeReads = requests.filter(item => item.method === 'GET').length;
      await click(button('刷新列表'));
      await waitForUI(() => !queryClient.isFetching() && selection() === '已选 1 位 · 仅当前页', 'refreshed selection must retain only users still present');
      assert.equal(rowCheckboxes().filter(item => item.checked).length, 1);
      assert.equal(requests.filter(item => item.method === 'GET').length, beforeReads + 1, 'explicit refresh makes one user-list request');
    });

    await t.test('confirmed deletion of the current account clears private caches and returns to the garden immediately', async () => {
      const ownUser = users[0];
      const rules = { dailyFertilizer: 5, inventoryLimit: 10, coinsPerFeed: 10, growthPerFeed: 1, apiRateLimit: 60 };
      const providers = { github: false, linuxdo: false };
      const publicBrand = { siteName: '智慧树' };
      queryClient.setQueryData(['me'], { user: ownUser, tree: { height: 3, planted: true, seedClaimed: true }, daily: { date: '2026-10-05', claimed: 5, remaining: 0 }, rules, providers, reward: 10, tip: 'private garden feedback', dialogue: { content: 'private dialogue' } });
      queryClient.setQueryData(['keys'], { items: ['private key placeholder'] });
      queryClient.setQueryData(['usage'], { items: ['private usage placeholder'] });
      queryClient.setQueryData(['site-settings'], publicBrand);
      await act(async () => { renderUsers(ownUser.id); });
      const ownRow = [...window.document.querySelectorAll('tbody tr')].find(row => row.querySelector('strong')?.textContent === ownUser.displayName)!;
      await click(button('删除', ownRow));
      assert.match(dialog().textContent || '', /包含你当前登录的账户/);
      assert.equal(dialog().querySelector('h2')?.textContent, '彻底删除用户');
      await click(button('彻底删除', dialog()));
      await waitForUI(() => Boolean(releaseBatch), 'self-deletion must start');
      await finishBatch();
      assert.deepEqual(queryClient.getQueryData(['me']), { user: null, tree: null, daily: null, rules, providers });
      assert.equal(queryClient.getQueryData(['keys']), undefined);
      assert.equal(queryClient.getQueryData(['usage']), undefined);
      assert.deepEqual(queryClient.getQueryData(['site-settings']), publicBrand);
      assert.equal(window.document.getElementById('current-route')?.textContent, '/');
    });

    const beforeEvents = requests.length;
    await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); });
    assert.equal(requests.length, beforeEvents, 'browser events add no user-list polling');
    assert.equal(intervals, 0, 'user management must not create polling intervals');
  } finally {
    releaseBatch?.();
    await act(async () => { root.unmount(); });
    queryClient.clear(); queryClient.setDefaultOptions(options); dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
