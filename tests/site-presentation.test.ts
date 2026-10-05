import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SiteBrand, useSiteHead } from '../frontend/src/SitePresentation.js';
import { defaultSiteSettings, useSiteSettings, type SiteSettings } from '../frontend/src/site-settings.js';
import Garden from '../frontend/src/Garden.js';
import type { State } from '../frontend/src/api.js';

test('public website presentation applies saved text and assets while keeping safe visible fallbacks', async t => {
  const dom = new JSDOM('<!doctype html><html><head><title>Initial title</title></head><body><div id="root"></div></body></html>', { url: 'https://site-presentation.test.invalid/' });
  const window = dom.window;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('React', React); install('HTMLElement', window.HTMLElement); install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: string[] = [];
  let failSiteRead = false;
  let received: SiteSettings = { ...defaultSiteSettings, siteName: '线上花园', browserTitle: '线上花园标题', updatedAt: '2026-10-05T01:00:00.000Z' };
  install('fetch', async (path: string) => {
    requests.push(path);
    if (path === '/api/site-settings') return failSiteRead ? Response.json({ error: { code: 'unavailable', message: 'isolated unavailable settings' } }, { status: 503 }) : Response.json(received);
    if (path === '/assets/manifest.json' || path === '/assets/animations.json') return new Response(null, { status: 503 });
    throw new Error('Unexpected presentation request: ' + path);
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  const clients: QueryClient[] = [];
  const newClient = () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity }, mutations: { gcTime: Infinity } } });
    clients.push(client); return client;
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  const BrandAndHead = ({ site }: { site: SiteSettings }) => { useSiteHead(site); return createElement(SiteBrand, { site }); };
  const render = (site: SiteSettings) => act(async () => { root.render(createElement(MemoryRouter, {}, createElement(BrandAndHead, { site }))); });
  const logoUrl = '/api/site-assets/' + 'a'.repeat(32) + '.webp';
  const nextLogoUrl = '/api/site-assets/' + 'b'.repeat(32) + '.webp';
  const faviconUrl = '/api/site-assets/' + 'c'.repeat(32) + '.png';
  try {
    await t.test('document title and managed favicon update in place and restoring defaults removes the custom icon', async () => {
      await render({ ...defaultSiteSettings, browserTitle: '<我的花园 & API>', faviconUrl });
      assert.equal(window.document.title, '<我的花园 & API>');
      const originalIcon = window.document.querySelector<HTMLLinkElement>('link[data-site-favicon]')!;
      assert.equal(originalIcon.getAttribute('href'), faviconUrl); assert.equal(originalIcon.type, 'image/png');
      assert.equal(originalIcon.rel, 'icon'); assert.equal(window.document.querySelectorAll('link[data-site-favicon]').length, 1);
      const nextIconUrl = '/api/site-assets/' + 'd'.repeat(32) + '.png';
      await render({ ...defaultSiteSettings, browserTitle: '更新后的浏览器标题', faviconUrl: nextIconUrl });
      assert.equal(window.document.querySelector('link[data-site-favicon]'), originalIcon);
      assert.equal(originalIcon.getAttribute('href'), nextIconUrl);
      assert.equal(window.document.title, '更新后的浏览器标题');
      await render(defaultSiteSettings);
      assert.equal(window.document.title, defaultSiteSettings.browserTitle);
      assert.equal(window.document.querySelector('link[data-site-favicon]'), null);
    });
    await t.test('long and markup-looking site names remain text and are discoverable from the brand link title', async () => {
      const name = '<script>window.bad=true</script>' + '长名称'.repeat(10);
      await render({ ...defaultSiteSettings, siteName: name, logoUrl: null });
      const brand = window.document.querySelector<HTMLAnchorElement>('a.brand')!;
      assert.equal(brand.getAttribute('href'), '/'); assert.equal(brand.title, name);
      assert.equal(brand.querySelector('.site-name')?.textContent, name);
      assert.equal(brand.querySelector('script'), null);
      await render({ ...defaultSiteSettings, siteName: name, logoUrl });
      const image = brand.querySelector<HTMLImageElement>('img')!;
      assert.equal(image.getAttribute('src'), logoUrl); assert.equal(image.alt, name);
      assert.equal(brand.querySelector('.site-name'), null, 'the saved logo replaces the wordmark without duplicating the name');
    });
    await t.test('failed logo falls back to the saved site name and a newly uploaded URL is tried again', async () => {
      await render({ ...defaultSiteSettings, siteName: '图标花园', logoUrl });
      const image = window.document.querySelector<HTMLImageElement>('a.brand img')!;
      await act(async () => { image.dispatchEvent(new window.Event('error')); });
      assert.equal(window.document.querySelector('a.brand img'), null);
      assert.equal(window.document.querySelector('a.brand .site-name')?.textContent, '图标花园');
      await render({ ...defaultSiteSettings, siteName: '图标花园', logoUrl: nextLogoUrl });
      assert.equal(window.document.querySelector('a.brand img')?.getAttribute('src'), nextLogoUrl);
      await render({ ...defaultSiteSettings, siteName: '图标花园', logoUrl: null });
      assert.equal(window.document.querySelector('a.brand img'), null);
      assert.equal(window.document.querySelector('a.brand .site-name')?.textContent, '图标花园');
    });
    await t.test('public settings load once under StrictMode, update presentation and ignore focus/reconnect', async () => {
      const client = newClient();
      const Live = () => { const query = useSiteSettings(); return createElement(BrandAndHead, { site: query.data ?? defaultSiteSettings }); };
      const before = requests.length;
      await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, {}, createElement(React.StrictMode, {}, createElement(Live)))));
        await pause();
      });
      await act(async () => { await pause(); });
      assert.equal(requests.slice(before).filter(path => path === '/api/site-settings').length, 1);
      assert.equal(window.document.title, '线上花园标题');
      assert.equal(window.document.querySelector('.site-name')?.textContent, '线上花园');
      const done = requests.length;
      await act(async () => { window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online')); await pause(); });
      assert.equal(requests.length, done);
    });
    await t.test('failed public settings leave the built-in title and name visible with no retry loop', async () => {
      const client = newClient(); failSiteRead = true;
      const Live = () => { const query = useSiteSettings(); return createElement(BrandAndHead, { site: query.data ?? defaultSiteSettings }); };
      const before = requests.length;
      await act(async () => { root.render(createElement(QueryClientProvider, { client, key: 'unavailable' }, createElement(MemoryRouter, {}, createElement(Live)))); await pause(); });
      await act(async () => { await pause(); });
      assert.equal(window.document.title, defaultSiteSettings.browserTitle);
      assert.equal(window.document.querySelector('.site-name')?.textContent, defaultSiteSettings.siteName);
      assert.equal(requests.slice(before).filter(path => path === '/api/site-settings').length, 1);
      failSiteRead = false;
    });
    await t.test('empty saved garden subtitle hides its paragraph while site name remains in the guest heading and toolbar', async () => {
      const client = newClient();
      const state: State = { user: null, tree: null, daily: null, rules: { dailyFertilizer: 5, inventoryLimit: 10, coinsPerFeed: 10, growthPerFeed: 1, apiRateLimit: 60 }, providers: { github: false, linuxdo: false } };
      const site = { ...defaultSiteSettings, siteName: '新的花园', gardenSubtitle: '' };
      await act(async () => { root.render(createElement(QueryClientProvider, { client, key: 'garden' }, createElement(MemoryRouter, {}, createElement(Garden, { state, site, onLogin() {} })))); await pause(); });
      assert.equal(window.document.querySelector('.garden-heading p'), null);
      assert.equal(window.document.querySelector('.garden-heading h1')?.textContent, '新的花园花园');
      assert.equal(window.document.querySelector('.garden-toolbar > span')?.textContent, '新的花园');
      await act(async () => { root.render(createElement(QueryClientProvider, { client, key: 'garden' }, createElement(MemoryRouter, {}, createElement(Garden, { state, site: { ...site, gardenSubtitle: '第一行\n第二行' }, onLogin() {} })))); });
      assert.equal(window.document.querySelector('.garden-heading p')?.textContent, '第一行\n第二行');
    });
  } finally {
    await act(async () => { root.unmount(); });
    for (const client of clients) client.clear();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
