import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createCanvas, Image as CanvasImage } from '@napi-rs/canvas';
import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import GameScene from '../frontend/src/GameScene.js';

const assetRoot = resolve('frontend/public/assets');
const manifest = JSON.parse(readFileSync(resolve(assetRoot, 'manifest.json'), 'utf8'));
const animations = JSON.parse(readFileSync(resolve(assetRoot, 'animations.json'), 'utf8'));

test('the rendered wisdom tree accepts deliberate feeding and plays pour before growth', { timeout: 30_000 }, async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:5173' });
  const window = dom.window;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let now = 1000, jobId = 0, fetches = 0, hidden = false, viewportWidth = 800;
  const jobs = new Map<number, { at: number; run: () => void }>();
  const schedule = (run: () => void, delay: number) => { const id = ++jobId; jobs.set(id, { at: now + delay, run }); return id; };
  const raf = (callback: FrameRequestCallback) => schedule(() => callback(now), 16);
  const cancel = (id: number) => { jobs.delete(id); };
  window.setTimeout = ((callback: () => void, delay = 0) => schedule(callback, delay)) as typeof window.setTimeout;
  window.clearTimeout = cancel;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  let reducedMotion = false;
  const motionListeners = new Set<() => void>();
  const motion = { get matches() { return reducedMotion; }, addEventListener: (_type: string, fn: () => void) => motionListeners.add(fn), removeEventListener: (_type: string, fn: () => void) => motionListeners.delete(fn) };
  const backingCanvases = new WeakMap<HTMLCanvasElement, ReturnType<typeof createCanvas>>();
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const imageDraws: { at: number; key: string }[] = [];
  const nativeCanvas = (canvas: HTMLCanvasElement) => {
    let native = backingCanvases.get(canvas);
    if (!native || native.width !== canvas.width || native.height !== canvas.height) {
      native = createCanvas(canvas.width, canvas.height); backingCanvases.set(canvas, native); contexts.delete(canvas);
    }
    return native;
  };
  window.HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type !== '2d') return null;
    const native = nativeCanvas(this);
    let context = contexts.get(this);
    if (!context) {
      const actual = native.getContext('2d');
      context = new Proxy(actual, {
        get(target, name) {
          if (name === 'drawImage') return (source: any, ...args: any[]) => {
            if (source instanceof window.HTMLCanvasElement) source = nativeCanvas(source);
            if (source.assetKey) imageDraws.push({ at: now, key: source.assetKey });
            (target.drawImage as any)(source, ...args);
          };
          const value = Reflect.get(target, name, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, name, value) { return Reflect.set(target, name, value, target); },
      }) as unknown as CanvasRenderingContext2D;
      contexts.set(this, context);
    }
    return context;
  } as typeof window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: viewportWidth, bottom: viewportWidth * .75, width: viewportWidth, height: viewportWidth * .75, toJSON() {} });
  const captures = new WeakMap<Element, Set<number>>();
  window.HTMLElement.prototype.setPointerCapture = function (id: number) { const set = captures.get(this) || new Set(); set.add(id); captures.set(this, set); };
  window.HTMLElement.prototype.hasPointerCapture = function (id: number) { return captures.get(this)?.has(id) || false; };
  window.HTMLElement.prototype.releasePointerCapture = function (id: number) { captures.get(this)?.delete(id); };
  class FileImage extends CanvasImage {
    assetKey = '';
    set src(value: string) {
      const relative = value.replace(/^\/assets\//, '');
      this.assetKey = relative.split('/').at(-1)?.replace(/\.png$/, '') || '';
      super.src = readFileSync(resolve(assetRoot, relative));
    }
  }
  class PointerEvent extends window.MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, options: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, options); this.pointerId = options.pointerId || 1; this.pointerType = options.pointerType || 'mouse'; this.isPrimary = true;
    }
  }
  install('window', window); install('document', window.document); install('navigator', window.navigator);
  // The root tsx runner uses classic JSX; Vite uses the frontend's automatic JSX transform.
  install('React', React);
  install('HTMLElement', window.HTMLElement); install('HTMLCanvasElement', window.HTMLCanvasElement);
  install('Image', FileImage); install('PointerEvent', PointerEvent);
  install('requestAnimationFrame', raf); install('cancelAnimationFrame', cancel);
  const realPerformance = globalThis.performance;
  install('performance', { now: () => now, measure: realPerformance.measure.bind(realPerformance), mark: realPerformance.mark.bind(realPerformance), clearMeasures: realPerformance.clearMeasures.bind(realPerformance), clearMarks: realPerformance.clearMarks.bind(realPerformance) });
  install('matchMedia', () => motion); install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (path: string) => {
    fetches++;
    assert.ok(path === '/assets/manifest.json' || path === '/assets/animations.json', 'the scene only fetches static assets');
    return { ok: true, json: async () => path.endsWith('manifest.json') ? manifest : animations };
  });
  let root: ReturnType<typeof createRoot> | undefined;
  let interacts = 0, talks = 0;
  const locks: { at: number; busy: boolean }[] = [];
  let props: Parameters<typeof GameScene>[0];
  const flushTo = async (target: number) => {
    await act(async () => {
      let runs = 0;
      while (true) {
        let next: [number, { at: number; run: () => void }] | undefined;
        for (const entry of jobs) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        assert.ok(++runs < 10_000, 'the animation scheduler must not loop without elapsed time');
        jobs.delete(next[0]); now = next[1].at; next[1].run();
      }
      now = target;
    });
  };
  const advance = async (milliseconds: number) => flushTo(now + milliseconds);
  const mount = async (overrides: Partial<Parameters<typeof GameScene>[0]> = {}) => {
    if (root) await act(async () => { root?.unmount(); });
    jobs.clear(); hidden = false; viewportWidth = 800; reducedMotion = false; interacts = talks = 0; locks.length = 0; imageDraws.length = 0;
    props = {
      tree: { seedClaimed: true, planted: true, height: 1 }, fertilizer: 5, coins: 0, feedNonce: 0, reward: 0, tip: 'A', busy: false, readyLabel: '施肥',
      onInteract: () => { interacts++; }, onTalk: () => { talks++; },
      onAnimationBusyChange: busy => { locks.push({ at: now, busy }); },
      ...overrides,
    };
    root = createRoot(window.document.getElementById('root')!);
    await act(async () => { root!.render(createElement(GameScene, props)); });
    // Image decoding fires asynchronous native onload events.
    for (let i = 0; i < 100 && !window.document.querySelector('.scene-food'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(window.document.querySelector('.scene-food'), 'the real original PNG assets loaded');
    await advance(20);
  };
  const render = async (next: Partial<Parameters<typeof GameScene>[0]>) => {
    props = { ...props, ...next };
    await act(async () => { root!.render(createElement(GameScene, props)); });
  };
  const food = () => window.document.querySelector<HTMLButtonElement>('.scene-food')!;
  const canvas = () => window.document.querySelector<HTMLCanvasElement>('.game-viewport > canvas')!;
  const phase = () => window.document.querySelector('.game-viewport')?.getAttribute('data-feed-phase');
  const pointer = async (type: string, x: number, y: number, extra: { pointerId?: number; pointerType?: string } = {}) => {
    await act(async () => { food().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra })); });
    await advance(20);
  };
  const drag = async (x: number, y: number, extra: { pointerId?: number; pointerType?: string } = {}) => {
    await pointer('pointerdown', 62, 40, extra); assert.equal(food().hasPointerCapture(extra.pointerId || 1), true);
    await pointer('pointermove', x, y, extra); await pointer('pointerup', x, y, extra);
    assert.equal(food().hasPointerCapture(extra.pointerId || 1), false);
  };
  const clickTree = async (x: number, y: number) => { await act(async () => { canvas().dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); }); };
  try {
    await t.test('actual seedling alpha, rather than the grass/background, determines valid drops', async () => {
      await mount();
      await drag(740, 500); assert.equal(interacts, 0); assert.match(window.document.querySelector('[role=status]')!.textContent!, /肥料已放回/);
      await drag(140, 420); assert.equal(interacts, 0, 'the original full-width grass layer is excluded');
      await drag(399, 390); assert.equal(interacts, 1); assert.equal(talks, 0);
      await pointer('pointerdown', 62, 40); assert.equal(food().hasPointerCapture(1), false);
      await pointer('pointermove', 399, 390); await pointer('pointerup', 399, 390);
      assert.equal(interacts, 1, 'a second immediate drop cannot submit the first feed twice');
    });
    await t.test('tree clicks speak and food clicks do not arm tree-click feeding', async () => {
      await mount();
      await clickTree(399, 390); await clickTree(399, 390); assert.equal(talks, 2); assert.equal(interacts, 0);
      await clickTree(740, 500); assert.equal(talks, 2); assert.equal(interacts, 0);
      await pointer('pointerdown', 62, 40); await pointer('pointerup', 62, 40);
      await act(async () => { food().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })); });
      await clickTree(399, 390); assert.equal(talks, 3); assert.equal(interacts, 0);
    });
    await t.test('accepted feeding pours all 31 original frames before growth and locks repeat actions', async () => {
      await mount();
      await drag(399, 390); assert.equal(interacts, 1);
      await render({ tree: { seedClaimed: true, planted: true, height: 2 }, fertilizer: 4, coins: 10, feedNonce: 1, reward: 10 });
      await advance(20); const started = locks.find(lock => lock.busy)!.at;
      assert.equal(phase(), 'pouring'); assert.equal(food().disabled, true);
      assert.ok(imageDraws.some(draw => draw.key === 'IMAGE_REANIM_TREEFOOD'), 'the real fertilizer track renders');
      const grow2Keys = new Set(['IMAGE_REANIM_TREE1']);
      const prematureTree = () => imageDraws.filter(draw => draw.at >= started && grow2Keys.has(draw.key));
      assert.equal(prematureTree().length, 0);
      await flushTo(started + 1549); assert.equal(phase(), 'pouring'); assert.equal(prematureTree().length, 0, 'accepted height has not drawn the new tree before pouring finishes');
      await clickTree(399, 390); assert.equal(talks, 0);
      await act(async () => { food().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })); });
      assert.equal(interacts, 1, 'keyboard activation during the animation is also locked');
      await flushTo(started + 1600); assert.equal(phase(), 'growing'); assert.equal(food().disabled, true);
      await flushTo(started + 2300); assert.ok(prematureTree().length > 0, 'the accepted grow2 tree renders after the pour');
      await flushTo(started + 3000); assert.equal(phase(), 'idle'); assert.equal(food().disabled, false);
      assert.deepEqual(locks.map(lock => lock.busy), [true, false]);
      assert.ok(locks[1].at >= started + 1550 + 1375, 'the full 11-frame grow2 sequence includes its held final frame');
      await drag(400, 360); assert.equal(interacts, 2, 'feeding is available again after growth');
    });
    await t.test('a cancelled touch drag returns the bag and a later touch drop still feeds', async () => {
      await mount();
      await pointer('pointerdown', 62, 40, { pointerId: 7, pointerType: 'touch' });
      await pointer('pointermove', 399, 390, { pointerId: 7, pointerType: 'touch' });
      await pointer('pointerup', 399, 390, { pointerId: 99, pointerType: 'touch' });
      assert.equal(interacts, 0, 'a second finger cannot complete the captured drag');
      assert.equal(food().hasPointerCapture(7), true);
      await pointer('pointercancel', 399, 390, { pointerId: 7, pointerType: 'touch' });
      assert.equal(interacts, 0); assert.equal(food().hasPointerCapture(7), false);
      await pointer('pointerup', 399, 390, { pointerId: 7, pointerType: 'touch' }); assert.equal(interacts, 0);
      await drag(399, 390, { pointerId: 8, pointerType: 'touch' }); assert.equal(interacts, 1);
    });
    await t.test('mobile pointer coordinates scale to the original tree instead of the full canvas', async () => {
      await mount(); viewportWidth = 390;
      await pointer('pointerdown', 30, 20, { pointerId: 2, pointerType: 'touch' });
      await pointer('pointermove', 350, 220, { pointerId: 2, pointerType: 'touch' });
      await pointer('pointerup', 350, 220, { pointerId: 2, pointerType: 'touch' }); assert.equal(interacts, 0);
      await pointer('pointerdown', 30, 20, { pointerId: 3, pointerType: 'touch' });
      await pointer('pointermove', 399 * 390 / 800, 390 * 390 / 800, { pointerId: 3, pointerType: 'touch' });
      await pointer('pointerup', 399 * 390 / 800, 390 * 390 / 800, { pointerId: 3, pointerType: 'touch' }); assert.equal(interacts, 1);
    });
    await t.test('no inventory cannot be dragged and explicit keyboard feeding works with inventory', async () => {
      await mount({ fertilizer: 0 }); assert.equal(food().disabled, true);
      await pointer('pointerdown', 62, 40); assert.equal(food().hasPointerCapture(1), false);
      await pointer('pointermove', 399, 390); await pointer('pointerup', 399, 390);
      assert.equal(interacts, 0);
      await render({ fertilizer: 1 });
      await act(async () => { food().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })); });
      assert.equal(interacts, 1);
    });
    await t.test('reduced motion holds a pour pose but still waits before changing tree stage', async () => {
      await mount(); reducedMotion = true;
      await act(async () => { for (const listener of motionListeners) listener(); });
      await render({ tree: { seedClaimed: true, planted: true, height: 2 }, feedNonce: 1, fertilizer: 4, reward: 10 });
      await advance(20); const started = locks.find(lock => lock.busy)!.at;
      assert.equal(phase(), 'pouring');
      await flushTo(started + 1549); assert.equal(phase(), 'pouring');
      await flushTo(started + 1600); assert.equal(phase(), 'idle');
      assert.deepEqual(locks.map(lock => lock.busy), [true, false]);
    });
    await t.test('a hidden tab stops drawing and resumes the unfinished pour rather than skipping growth', async () => {
      await mount();
      await render({ tree: { seedClaimed: true, planted: true, height: 2 }, feedNonce: 1, fertilizer: 4, reward: 10 });
      await advance(420); assert.equal(phase(), 'pouring');
      hidden = true; await act(async () => { window.document.dispatchEvent(new window.Event('visibilitychange')); });
      const before = imageDraws.length;
      await advance(30_000); assert.equal(imageDraws.length, before); assert.equal(phase(), 'pouring'); assert.equal(food().disabled, true);
      hidden = false; await act(async () => { window.document.dispatchEvent(new window.Event('visibilitychange')); });
      await advance(1000); assert.equal(phase(), 'pouring');
      await advance(500); assert.equal(phase(), 'growing');
      await advance(2000); assert.equal(phase(), 'idle'); assert.equal(food().disabled, false);
    });
    await t.test('an idle scene keeps static assets cached and performs no polling requests', async () => {
      await mount(); const initialFetches = fetches;
      await advance(60_000); assert.equal(fetches, initialFetches); assert.equal(fetches, 2);
      assert.equal(phase(), 'idle'); assert.equal(interacts, 0); assert.equal(talks, 0);
    });
  } finally {
    await act(async () => { root?.unmount(); });
    dom.window.close();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
