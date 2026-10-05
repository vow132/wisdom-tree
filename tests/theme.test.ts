import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ThemeSelector from '../frontend/src/Theme.js';

const storageKey = 'wisdom-tree-theme';

test('the real theme selector follows user choices and browser events without polling', async t => {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173' });
  const window = dom.window;
  // Mock the browser storage boundary; jsdom otherwise schedules its own cross-window
  // delivery timers, which are unrelated to timers scheduled by the component.
  const stored = new Map<string, string>();
  const storage: Storage = {
    get length() { return stored.size; },
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: key => { stored.delete(key); },
    clear: () => { stored.clear(); },
    key: index => [...stored.keys()][index] ?? null,
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let dark = false, fetches = 0, timers = 0;
  const mediaListeners = new Set<(event: Event) => void>();
  const queries: string[] = [];
  const media = {
    media: '(prefers-color-scheme: dark)',
    get matches() { return dark; },
    addEventListener(type: string, listener: (event: Event) => void) {
      assert.equal(type, 'change'); mediaListeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      assert.equal(type, 'change'); mediaListeners.delete(listener);
    },
  };
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  install('localStorage', window.localStorage); install('HTMLElement', window.HTMLElement);
  // Root tsx test execution uses classic JSX; the application uses Vite's automatic transform.
  install('React', React); install('IS_REACT_ACT_ENVIRONMENT', true);
  install('matchMedia', (query: string) => { queries.push(query); return media; });
  install('fetch', async () => { fetches++; throw new Error('The theme selector must not make network requests.'); });
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  install('setTimeout', (...args: Parameters<typeof setTimeout>) => {
    // jsdom focus() emits selectionchange with a native one-shot timer. Count
    // component timers while excluding only this immediate browser implementation caller.
    const caller = new Error().stack?.split('\n')[2] || '';
    if (!caller.includes('Selection-impl.js')) timers++;
    return timeout(...args);
  });
  install('setInterval', (...args: Parameters<typeof setInterval>) => { timers++; return interval(...args); });
  const windowTimeout = window.setTimeout.bind(window), windowInterval = window.setInterval.bind(window);
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => { timers++; return windowTimeout(...args); }) as typeof window.setTimeout;
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => { timers++; return windowInterval(...args); }) as typeof window.setInterval;

  let root: ReturnType<typeof createRoot> | undefined;
  const unmount = async () => { if (root) { await act(async () => { root?.unmount(); }); root = undefined; } };
  const mount = async () => {
    await unmount();
    root = createRoot(window.document.getElementById('root')!);
    await act(async () => { root!.render(createElement(ThemeSelector)); });
    assert.equal(mediaListeners.size, 1, 'the mounted selector has exactly one media listener');
  };
  const selector = () => window.document.querySelector<HTMLButtonElement>('.theme-icon-button')!;
  const labels: Record<string, string> = { light: '浅色', dark: '深色', system: '随系统' };
  const assertTheme = (choice: string, colorMode: string) => {
    assert.equal(selector().getAttribute('aria-label'), `切换主题，当前${labels[choice]}`);
    assert.ok(selector().classList.contains(colorMode === 'dark' ? 'moon' : 'sun'));
    assert.equal(window.document.documentElement.dataset.theme, choice);
    assert.equal(window.document.documentElement.dataset.colorMode, colorMode);
    assert.equal(window.document.querySelector('meta[name="theme-color"]')!.getAttribute('content'), colorMode === 'dark' ? '#142019' : '#27533c');
  };
  const choose = async (choice: string) => {
    await act(async () => { selector().click(); });
    const option = Array.from(window.document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button => button.textContent === labels[choice]);
    assert.ok(option);
    await act(async () => { option.click(); });
    assert.equal(selector().getAttribute('aria-expanded'), 'false');
    assert.equal(window.document.activeElement, selector());
  };
  const system = async (isDark: boolean) => {
    dark = isDark;
    const event = new window.Event('change');
    Object.defineProperties(event, { matches: { value: dark }, media: { value: media.media } });
    await act(async () => { for (const listener of mediaListeners) listener(event as unknown as Event); });
  };
  const otherTab = async (value: string | null, key = storageKey) => {
    const oldValue = window.localStorage.getItem(key);
    if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    await act(async () => {
      window.dispatchEvent(new window.StorageEvent('storage', { key, oldValue, newValue: value, url: 'http://127.0.0.1:5173/other-tab' }));
    });
  };

  try {
    await t.test('light, dark and system choices apply immediately and persist', async () => {
      await mount(); assertTheme('system', 'light');
      await act(async () => { selector().click(); });
      assert.deepEqual(Array.from(window.document.querySelectorAll('[role="menuitemradio"]'), option => option.textContent), ['浅色', '深色', '随系统']);
      await act(async () => { selector().click(); });
      await choose('dark'); assertTheme('dark', 'dark'); assert.equal(window.localStorage.getItem(storageKey), 'dark');
      await choose('light'); assertTheme('light', 'light'); assert.equal(window.localStorage.getItem(storageKey), 'light');
      await choose('system'); assertTheme('system', 'light'); assert.equal(window.localStorage.getItem(storageKey), 'system');
    });
    await t.test('system change events update both ways and explicit choices remain selected', async () => {
      await system(true); assertTheme('system', 'dark');
      await system(false); assertTheme('system', 'light');
      await choose('light'); await system(true); assertTheme('light', 'light');
      await choose('dark'); await system(false); assertTheme('dark', 'dark');
      await choose('system'); assertTheme('system', 'light');
      assert.equal(mediaListeners.size, 1, 'changing preferences replaces the listener instead of accumulating listeners');
    });
    await t.test('remount restores the saved choice and current system preference', async () => {
      await choose('dark'); await mount(); assertTheme('dark', 'dark');
      await choose('light'); await mount(); assertTheme('light', 'light');
      await choose('system'); await unmount(); dark = true;
      await mount(); assertTheme('system', 'dark');
      await unmount(); window.localStorage.setItem(storageKey, 'unrecognized');
      await mount(); assertTheme('system', 'dark');
    });
    await t.test('cross-tab storage events sync choices and ignore unrelated settings', async () => {
      await otherTab('light'); assertTheme('light', 'light');
      await otherTab('dark'); assertTheme('dark', 'dark');
      await otherTab('system'); assertTheme('system', 'dark');
      await otherTab('light', 'another-preference'); assertTheme('system', 'dark');
      await otherTab('unrecognized'); assertTheme('system', 'dark');
      await otherTab('light'); await otherTab(null); assertTheme('system', 'dark');
      await system(false); assertTheme('system', 'light');
    });
    await t.test('icon menu supports keyboard focus, Escape and outside dismissal', async () => {
      await choose('system');
      await act(async () => { selector().click(); });
      const options = [...window.document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      assert.equal(options[2], window.document.activeElement);
      await act(async () => { options[2].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      assert.equal(options[0], window.document.activeElement);
      await act(async () => { options[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
      assert.equal(options[2], window.document.activeElement);
      await act(async () => { options[2].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(selector(), window.document.activeElement);
      assert.equal(window.document.querySelector('[role="menu"]'), null);
      await act(async () => { selector().click(); });
      await act(async () => { window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
      assert.equal(window.document.querySelector('[role="menu"]'), null);
    });
    await t.test('event-driven updates schedule no timers or fetches, and unmount removes listeners', async () => {
      assert.equal(fetches, 0); assert.equal(timers, 0);
      assert.ok(queries.length > 0 && queries.every(query => query === media.media));
      await unmount(); assert.equal(mediaListeners.size, 0);
      await otherTab('dark'); await system(true);
      assert.equal(window.document.documentElement.dataset.theme, 'system', 'unmounted storage listener no longer changes the DOM');
      assert.equal(window.document.documentElement.dataset.colorMode, 'light', 'unmounted media listener no longer changes the DOM');
      assert.equal(fetches, 0); assert.equal(timers, 0);
    });
  } finally {
    await unmount();
    dom.window.close();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
