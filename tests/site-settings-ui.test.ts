import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SiteSettingsPanel, { validateSiteImage, maxImageBytes } from '../frontend/src/SiteSettings.js';
import { defaultSiteSettings, siteSettingsQueryKey, adminSiteSettingsQueryKey, saveSiteSettingsCache, useSiteSettings, type SiteSettings } from '../frontend/src/site-settings.js';
import { NoticeContext, type Notice } from '../frontend/src/ui.js';

test('website settings save text and uploaded images independently, update the public cache and never poll', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173/admin/site' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('HTMLElement', window.HTMLElement); install('File', window.File); install('FileReader', window.FileReader);
  install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  const imageUrls: string[] = [], revoked: string[] = [];
  const oldCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const oldRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => { const url = `blob:preview-${imageUrls.length}`; imageUrls.push(url); return url; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { revoked.push(url); } });
  let intervals = 0;
  const interval = globalThis.setInterval;
  install('setInterval', (...args: Parameters<typeof setInterval>) => { intervals++; return interval(...args); });
  let settings: SiteSettings = { ...defaultSiteSettings, updatedAt: '2026-10-05T00:00:00.000Z' };
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const notices: Notice[] = [];
  let failSave = false;
  let tick = 0;
  install('fetch', async (path: string, options?: RequestInit) => {
    const method = options?.method || 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ path, method, body });
    if (path === '/api/admin/update/settings') return new Response(JSON.stringify({ enabled: false, tokenConfigured: false, repositoryUrl: 'https://github.com/vow132/wisdom-tree', branch: 'codex/wisdom-tree' }), { headers: { 'content-type': 'application/json' } });
    if (path === '/api/site-settings' || path === '/api/admin/site-settings') {
      if (method === 'PATCH') {
        if (failSave) return new Response(JSON.stringify({ error: { code: 'INVALID_INPUT', message: '网站名称不能为空，请填写后重试。' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        settings = { ...settings, ...body, updatedAt: `2026-10-05T00:00:0${++tick}.000Z` };
      }
      return new Response(JSON.stringify(settings), { headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/admin/site-settings/assets/logo' && method === 'POST') {
      settings = { ...settings, logoUrl: '/api/site-settings/assets/test-logo.png', updatedAt: `2026-10-05T00:00:0${++tick}.000Z` };
      return new Response(JSON.stringify(settings), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected endpoint: ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false, gcTime: Infinity } } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  const LiveBrand = () => { const query = useSiteSettings(); return createElement('output', { id: 'live-brand' }, query.data ? `${query.data.siteName}|${query.data.gardenSubtitle}|${query.data.footerText}|${query.data.logoUrl ?? 'default'}` : 'loading'); };
  const waitForUI = async (ready: () => boolean, message: string) => {
    const limit = Date.now() + 10_000;
    while (!ready() && Date.now() < limit) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(ready(), message);
  };
  const basicForm = () => window.document.querySelector<HTMLFormElement>('form[aria-label="网站基本信息"]')!;
  const input = (name: string) => window.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  const changeText = async (name: string, value: string) => { await act(async () => {
    const element = input(name);
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  }); };
  const submit = async () => {
    const before = requests.length;
    await act(async () => { basicForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await waitForUI(() => requests.length > before && client.isMutating() === 0 && !window.document.querySelector('button[aria-busy="true"]')
      && (failSave ? Boolean(basicForm().querySelector('[role="alert"]')) : window.document.getElementById('live-brand')?.textContent?.startsWith(settings.siteName + '|') === true), 'Website text save did not settle to its expected visible state.');
  };
  const fileInput = () => window.document.querySelector<HTMLInputElement>('input[name="asset-logo"]')!;
  const chooseFile = (file: File) => act(async () => { Object.defineProperty(fileInput(), 'files', { configurable: true, value: [file] }); fileInput().dispatchEvent(new window.Event('change', { bubbles: true })); });
  const assetSection = () => window.document.querySelector<HTMLElement>('.site-asset-logo')!;
  const assetButton = (text: string) => [...assetSection().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(NoticeContext.Provider, { value: notice => notices.push(notice) }, createElement(SiteSettingsPanel), createElement(React.StrictMode, {}, createElement(LiveBrand)))));
    });
    await waitForUI(() => Boolean(window.document.querySelector('form[aria-label="网站基本信息"]')) && Boolean(window.document.querySelector('input[name="updateToken"]'))
      && window.document.getElementById('live-brand')?.textContent !== 'loading', 'Website configuration forms did not load.');
    await t.test('one-time public query and existing update settings appear in the website settings workspace', async () => {
      assert.equal(requests.filter(request => request.path === '/api/site-settings').length, 1, 'StrictMode shares a single public configuration request');
      assert.equal(requests.filter(request => request.path === '/api/admin/site-settings').length, 1);
      assert.ok(window.document.querySelector('.site-settings-workspace #website-update'));
      assert.equal(input('siteName').maxLength, 60);
      assert.equal(input('browserTitle').maxLength, 120);
      assert.equal(input('gardenSubtitle').maxLength, 200);
      assert.equal(input('footerText').maxLength, 300);
      const before = requests.length;
      await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); });
      assert.equal(requests.length, before, 'browser focus and reconnect trigger no settings polling');
    });
    await t.test('text save permits empty optional copy, renders names as plain text and immediately updates public cache', async () => {
      await changeText('siteName', '<树 & 花园>'); await changeText('browserTitle', '我的智慧树');
      await changeText('gardenSubtitle', ''); await changeText('footerText', '');
      await submit();
      assert.deepEqual(requests.at(-1), { path: '/api/admin/site-settings', method: 'PATCH', body: { siteName: '<树 & 花园>', browserTitle: '我的智慧树', gardenSubtitle: '', footerText: '' } });
      assert.equal(window.document.getElementById('live-brand')?.textContent, '<树 & 花园>|||default');
      assert.equal(window.document.querySelector('.site-text-preview strong')?.textContent, '<树 & 花园>');
      assert.equal(window.document.querySelector('.site-text-preview img'), null);
      assert.ok(window.document.querySelector('[role="status"]')?.textContent?.includes('已保存'));
      assert.ok(notices.some(notice => notice.kind === 'success'));
    });
    await t.test('a rejected text save keeps the draft and provides a visible recovery message', async () => {
      await changeText('siteName', '暂存的名称'); failSave = true;
      await submit();
      assert.equal(input('siteName').value, '暂存的名称');
      assert.match(basicForm().querySelector('[role="alert"]')?.textContent ?? '', /填写后重试/);
      assert.equal(client.getQueryData<SiteSettings>(siteSettingsQueryKey)?.siteName, '<树 & 花园>');
      failSave = false;
    });
    await t.test('file validation rejects unsupported, empty and oversized images before uploading', async () => {
      assert.match(validateSiteImage({ size: 4, type: 'image/svg+xml' }) ?? '', /PNG/);
      assert.match(validateSiteImage({ size: 0, type: 'image/png' }) ?? '', /为空/);
      assert.match(validateSiteImage({ size: maxImageBytes + 1, type: 'image/png' }) ?? '', /2 MB/);
      const before = requests.length;
      await chooseFile(new window.File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
      assert.match(assetSection().querySelector('[role="alert"]')?.textContent ?? '', /PNG/);
      assert.equal(assetButton('上传图片').disabled, true);
      assert.equal(requests.length, before);
    });
    await t.test('selecting only previews; explicit upload sends pure base64 and preserves unsaved text', async () => {
      const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
      const name = '很长的图片名称'.repeat(20) + '.png';
      const before = requests.length;
      await chooseFile(new window.File([bytes], name, { type: 'image/png' }));
      assert.equal(requests.length, before, 'selection never uploads automatically');
      assert.equal(assetSection().querySelector('img')?.getAttribute('src'), imageUrls.at(-1));
      assert.ok(assetSection().textContent?.includes(name));
      assert.equal(assetButton('上传图片').disabled, false);
      await act(async () => { assetButton('上传图片').click(); });
      await waitForUI(() => client.isMutating() === 0 && assetSection().querySelector('img')?.getAttribute('src') === settings.logoUrl
        && Boolean(assetSection().querySelector('[role="status"]')?.textContent?.includes('已上传')), 'Image upload did not settle to the published image preview.');
      assert.deepEqual(requests.at(-1), { path: '/api/admin/site-settings/assets/logo', method: 'POST', body: { data: bytes.toString('base64'), mimeType: 'image/png' } });
      assert.equal(input('siteName').value, '暂存的名称', 'image saves never reset an unsaved text form');
      assert.equal(client.getQueryData<SiteSettings>(siteSettingsQueryKey)?.logoUrl, '/api/site-settings/assets/test-logo.png');
      assert.equal(assetSection().querySelector('img')?.getAttribute('src'), '/api/site-settings/assets/test-logo.png');
      assert.ok(revoked.includes(imageUrls.at(-1)!));
      assert.ok(assetSection().querySelector('[role="status"]')?.textContent?.includes('已上传'));
      assert.equal(assetButton('上传图片').disabled, true);
    });
    await t.test('restoring a default affects only its image slot and uses null rather than an external URL', async () => {
      await act(async () => { assetButton('恢复文字品牌').click(); });
      await waitForUI(() => client.isMutating() === 0 && assetSection().querySelector('img') === null && assetButton('恢复文字品牌').disabled,
        'Restoring the text brand did not settle to its default preview.');
      assert.deepEqual(requests.at(-1), { path: '/api/admin/site-settings', method: 'PATCH', body: { logoUrl: null } });
      assert.equal(client.getQueryData<SiteSettings>(siteSettingsQueryKey)?.logoUrl, null);
      assert.equal(assetSection().querySelector('img'), null);
      assert.equal(assetButton('恢复文字品牌').disabled, true);
      assert.equal(input('siteName').value, '暂存的名称');
      assert.equal(window.document.querySelector('input[name="logoUrl"]'), null, 'arbitrary image URLs have no editable field');
    });
    await t.test('a delayed older mutation cannot overwrite newer settings cached by another save', () => {
      const newest = { ...settings, siteName: '较新的名称', updatedAt: '2026-10-05T00:02:00.000Z' };
      saveSiteSettingsCache(client, newest);
      saveSiteSettingsCache(client, { ...settings, updatedAt: '2026-10-05T00:01:00.000Z' });
      assert.equal(client.getQueryData<SiteSettings>(siteSettingsQueryKey)?.siteName, '较新的名称');
      assert.equal(client.getQueryData<SiteSettings>(adminSiteSettingsQueryKey)?.siteName, '较新的名称');
      client.setQueryData(adminSiteSettingsQueryKey, { ...settings, updatedAt: '2026-10-05T00:01:00.000Z' });
      saveSiteSettingsCache(client, { ...settings, updatedAt: '2026-10-05T00:01:30.000Z' });
      assert.equal(client.getQueryData<SiteSettings>(siteSettingsQueryKey)?.siteName, '较新的名称', 'a newer public cache also rejects older responses');
    });
    assert.equal(requests.filter(request => request.method === 'GET').length, 3, 'successful saves update caches without a second GET');
    assert.equal(requests.filter(request => request.path.includes('/api/admin/update')).length, 1, 'website saves leave the update token configuration untouched');
    assert.equal(intervals, 0);
  } finally {
    await act(async () => { root.unmount(); }); client.clear(); dom.window.close();
    if (oldCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', oldCreateObjectURL); else Reflect.deleteProperty(URL, 'createObjectURL');
    if (oldRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', oldRevokeObjectURL); else Reflect.deleteProperty(URL, 'revokeObjectURL');
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
