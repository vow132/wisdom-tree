import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Tree } from './api';

type Frame = { x?: number; y?: number; kx?: number; ky?: number; sx?: number; sy?: number; a?: number; f?: number; i?: string };
type Pose = { x: number; y: number; kx: number; ky: number; sx: number; sy: number; a: number; f: number; i: string };
type Animation = { fps: number; frameCount: number; tracks: { name: string; frames: Frame[] }[]; ranges?: Record<string, { start: number; end: number }> };
type Manifest = { canvasWidth: number; canvasHeight: number; images: Record<string, string> };
type Assets = { animations: Record<string, Animation>; images: Record<string, HTMLImageElement>; tracks: Record<string, { name: string; frames: Pose[] }[]> };
type Drag = { pointerId: number; startClientX: number; startClientY: number; x: number; y: number; moved: boolean; valid: boolean };
let pendingAssets: Promise<Assets> | undefined;

function loadAssets() {
  if (!pendingAssets) pendingAssets = Promise.all([
    fetch('/assets/manifest.json').then(r => { if (!r.ok) throw new Error('原版图片清单未能载入。'); return r.json() as Promise<Manifest>; }),
    fetch('/assets/animations.json').then(r => { if (!r.ok) throw new Error('原版动画未能载入。'); return r.json() as Promise<{ animations: Record<string, Animation> }>; }),
  ]).then(async ([manifest, data]) => {
    const images: Assets['images'] = {}, tracks: Assets['tracks'] = {};
    await Promise.all(Object.entries(manifest.images).map(([key, src]) => new Promise<void>((resolve, reject) => {
      const image = new Image(); image.onload = () => { images[key] = image; resolve(); }; image.onerror = () => reject(new Error('部分原版图片未能载入，请刷新重试。')); image.src = src.startsWith('/') ? src : `/assets/${src}`;
    })));
    for (const [name, animation] of Object.entries(data.animations)) tracks[name] = animation.tracks.map(track => {
      let last: Pose = { x: 0, y: 0, kx: 0, ky: 0, sx: 1, sy: 1, a: 1, f: 0, i: '' };
      return { name: track.name, frames: track.frames.map(frame => { last = { ...last, ...frame }; return last; }) };
    });
    return { animations: data.animations, images, tracks };
  }).catch(error => { pendingAssets = undefined; throw error; });
  return pendingAssets;
}

function drawAnimation(ctx: CanvasRenderingContext2D, assets: Assets, name: string, position: number, include?: (track: string) => boolean) {
  for (const track of assets.tracks[name] || []) {
    if (!track.frames.length || track.name.startsWith('anim_') || (include && !include(track.name))) continue;
    const frame = track.frames[Math.min(Math.floor(position), track.frames.length - 1)];
    const next = track.frames[Math.min(Math.floor(position) + 1, track.frames.length - 1)];
    const image = assets.images[frame.i];
    if (frame.f < 0 || !image) continue;
    const fraction = position % 1;
    const mix = (key: 'x' | 'y' | 'kx' | 'ky' | 'sx' | 'sy' | 'a') => frame[key] + (next[key] - frame[key]) * fraction;
    const kx = mix('kx') * Math.PI / 180, ky = mix('ky') * Math.PI / 180;
    ctx.save(); ctx.globalAlpha *= Math.max(0, Math.min(1, mix('a')));
    ctx.transform(Math.cos(kx) * mix('sx'), Math.sin(kx) * mix('sx'), -Math.sin(ky) * mix('sy'), Math.cos(ky) * mix('sy'), mix('x'), mix('y'));
    ctx.drawImage(image, 0, 0); ctx.restore();
  }
}

export default function GameScene({ tree, fertilizer, coins, feedNonce, reward, tip, onInteract, onTalk, onAnimationBusyChange, busy, readyLabel, backgroundUrl }: { tree: Tree | null; fertilizer: number; coins: number; feedNonce: number; reward: number; tip: string; onInteract: () => void; onTalk?: () => void; onAnimationBusyChange?: (busy: boolean) => void; busy: boolean; readyLabel: string; backgroundUrl?: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [animationBusy, setAnimationBusy] = useState(false);
  const [feedPhase, setFeedPhase] = useState<'idle' | 'pouring' | 'growing'>('idle');
  const previousPhase = useRef<'idle' | 'pouring' | 'growing'>('idle');
  const [dragMessage, setDragMessage] = useState('');
  const animating = useRef(false);
  const drag = useRef<Drag | null>(null);
  const treePosition = useRef(0);
  const dropMask = useRef<{ assets: Assets; position: number; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined>(undefined);
  const submitting = useRef(false);
  const animationCallback = useRef(onAnimationBusyChange);
  animationCallback.current = onAnimationBusyChange;
  const current = useRef({ tree, fertilizer, coins, feedNonce, reward });
  current.current = { tree, fertilizer, coins, feedNonce, reward };
  const requestDraw = useRef<(() => void) | undefined>(undefined);
  const customBackground = useRef<HTMLImageElement | null>(null);
  const paintBackground = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    customBackground.current = null;
    paintBackground.current?.(); requestDraw.current?.();
    if (!backgroundUrl) return () => { active = false; };
    const image = new Image();
    image.onload = () => {
      if (!active || !image.width || !image.height) return;
      customBackground.current = image;
      // Update only the cached background. A late image must not restart an
      // accepted feeding animation or reset the tree's current height.
      paintBackground.current?.(); requestDraw.current?.();
    };
    image.onerror = () => { if (active) { customBackground.current = null; paintBackground.current?.(); requestDraw.current?.(); } };
    image.src = backgroundUrl;
    return () => { active = false; image.onload = image.onerror = null; };
  }, [backgroundUrl]);
  const changeAnimationBusy = (value: boolean) => {
    if (animating.current === value) return;
    animating.current = value; setAnimationBusy(value); animationCallback.current?.(value);
  };
  const getTreeMask = () => {
    if (!assets || !current.current.tree?.planted) return null;
    if (!dropMask.current || dropMask.current.assets !== assets) {
      const mask = document.createElement('canvas'); mask.width = 800; mask.height = 600;
      const ctx = mask.getContext('2d', { willReadFrequently: true }); if (!ctx) return null;
      dropMask.current = { assets, position: -1, canvas: mask, ctx };
    }
    const mask = dropMask.current;
    if (mask.position !== treePosition.current) {
      mask.ctx.clearRect(0, 0, 800, 600); mask.ctx.save(); mask.ctx.translate(.5, .5);
      // Test the visible tree, excluding the full-width background and grass.
      drawAnimation(mask.ctx, assets, 'tree', treePosition.current, name => name !== 'bg' && name !== 'grass');
      mask.ctx.restore(); mask.position = treePosition.current;
    }
    return mask;
  };
  const hitsTree = (x: number, y: number) => {
    if (x < 0 || x >= 800 || y < 0 || y >= 600) return false;
    const mask = getTreeMask(); if (!mask) return false;
    // A small margin lets a finger target the tiny seedling without accepting background drops.
    const left = Math.max(0, Math.floor(x) - 10), top = Math.max(0, Math.floor(y) - 10);
    const pixels = mask.ctx.getImageData(left, top, Math.min(21, 800 - left), Math.min(21, 600 - top)).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 40) return true;
    return false;
  };
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect();
    return rect ? { x: (event.clientX - rect.left) / rect.width * 800, y: (event.clientY - rect.top) / rect.height * 600 } : { x: -1, y: -1 };
  };
  const canFeed = () => !!assets && !!tree?.planted && fertilizer > 0 && !busy && !animating.current && !submitting.current;
  const interact = () => {
    if (busy || animating.current || submitting.current || !assets) return;
    if (tree?.planted) submitting.current = true;
    onInteract();
  };
  const talk = () => { if (tree?.planted && !busy && !animating.current && assets) onTalk?.(); };
  const dragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !canFeed()) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    drag.current = { pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, x, y, moved: false, valid: false };
    setDragMessage('拖动肥料到树上，松开即可施肥。'); requestDraw.current?.();
  };
  const dragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const { x, y } = point(event);
    active.x = x; active.y = y;
    active.moved ||= Math.hypot(event.clientX - active.startClientX, event.clientY - active.startClientY) >= 5;
    active.valid = active.moved && hitsTree(x, y); requestDraw.current?.();
  };
  const dragEnd = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    const { x, y } = point(event), accepted = !cancelled && active.moved && hitsTree(x, y) && canFeed();
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragMessage(accepted ? '' : active.moved ? '肥料已放回。拖到智慧树上，或使用施肥按钮。' : '按住肥料袋拖到树上，或直接点击施肥按钮。');
    requestDraw.current?.(); if (accepted) interact();
  };
  useEffect(() => { if (!busy && !animationBusy) submitting.current = false; }, [busy, animationBusy]);
  useEffect(() => {
    let active = true; setError(undefined);
    loadAssets().then(value => { if (active) setAssets(value); }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [reload]);
  useEffect(() => {
    if (!assets || !canvas.current) return;
    const ctx = canvas.current.getContext('2d', { alpha: false });
    if (!ctx) { setError('浏览器无法打开 Canvas。请使用支持 Canvas 的浏览器。'); return; }
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const background = document.createElement('canvas'), foreground = document.createElement('canvas');
    background.width = foreground.width = 800; background.height = foreground.height = 600;
    const backgroundCtx = background.getContext('2d'), foregroundCtx = foreground.getContext('2d');
    const cacheBackground = () => {
      if (!backgroundCtx) return;
      backgroundCtx.clearRect(0, 0, 800, 600);
      backgroundCtx.save(); backgroundCtx.translate(.5, .5);
      drawAnimation(backgroundCtx, assets, 'tree', 0, name => name === 'bg'); backgroundCtx.restore();
      const image = customBackground.current;
      if (image) {
        const scale = Math.max(800 / image.width, 600 / image.height);
        const width = image.width * scale, height = image.height * scale;
        backgroundCtx.drawImage(image, (800 - width) / 2, (600 - height) / 2, width, height);
      }
    };
    paintBackground.current = cacheBackground; cacheBackground();
    let frameId = 0, timerId = 0, hiddenAt = document.hidden ? performance.now() : 0;
    let startTime = performance.now(), feedStarted = 0, growthStarted = 0, growthDelta = 0, beforeFeedingPosition = 0, beforeFeedingHeight = 0;
    let lastHeight = current.current.tree?.height || 0, lastPlanted = !!current.current.tree?.planted, lastFeed = current.current.feedNonce;
    let targetStage = Math.max(1, Math.min(50, Math.floor(lastHeight))), cachedPosition = -1;
    const foodAnimation = assets.animations.treefood;
    // The original has 31 frames at 20 fps. It grows only after this one-shot finishes.
    const feedingDuration = foodAnimation ? foodAnimation.frameCount / foodAnimation.fps : 1.55;
    const cancelScheduled = () => { cancelAnimationFrame(frameId); window.clearTimeout(timerId); frameId = timerId = 0; };
    const schedule = (delay = 0) => {
      cancelScheduled();
      if (document.hidden) return;
      if (delay) timerId = window.setTimeout(() => { timerId = 0; frameId = requestAnimationFrame(draw); }, delay);
      else frameId = requestAnimationFrame(draw);
    };
    const draw = (now: number) => {
      frameId = 0;
      if (document.hidden) return;
      const state = current.current;
      const reduced = motion.matches, planted = !!state.tree?.planted, height = state.tree?.height || 0;
      const heightChanged = height !== lastHeight, plantedNow = planted && !lastPlanted, newFeed = state.feedNonce !== lastFeed;
      if (newFeed && planted) {
        beforeFeedingPosition = treePosition.current; beforeFeedingHeight = lastHeight;
        targetStage = Math.max(1, Math.min(51, Math.floor(height)));
        growthDelta = Math.max(0, height - lastHeight); feedStarted = now;
        growthStarted = now + feedingDuration * 1000; changeAnimationBusy(true);
      } else if (plantedNow) {
        targetStage = Math.max(1, Math.min(51, Math.floor(height)));
        growthStarted = now; changeAnimationBusy(true);
      } else if (heightChanged) {
        if (feedStarted && now < growthStarted) {
          // If React delivers the nonce and accepted height in separate renders, keep one pour.
          targetStage = Math.max(1, Math.min(51, Math.floor(height))); growthDelta = Math.max(0, height - beforeFeedingHeight);
        } else { targetStage = Math.max(1, Math.min(50, Math.floor(height))); growthStarted = 0; }
      }
      lastHeight = height; lastPlanted = planted; lastFeed = state.feedNonce;
      ctx.fillStyle = '#87b9cf'; ctx.fillRect(0, 0, 800, 600);
      if (backgroundCtx) ctx.drawImage(background, 0, 0);
      const treeAnimation = assets.animations.tree;
      let growing = false;
      if (treeAnimation) {
        const range = treeAnimation.ranges?.[planted ? `anim_grow${targetStage}` : 'anim_start'] || { start: 0, end: 10 };
        const waitingForFood = !!feedStarted && now < growthStarted;
        const growthTime = growthStarted ? Math.max(0, (now - growthStarted) / 1000) : Infinity;
        const position = waitingForFood ? beforeFeedingPosition : reduced ? range.end : Math.min(range.end, range.start + growthTime * 8);
        treePosition.current = position;
        growing = !waitingForFood && !reduced && !!growthStarted && growthTime < (range.end - range.start + 1) / 8;
        if (!backgroundCtx) { ctx.save(); ctx.translate(.5, .5); drawAnimation(ctx, assets, 'tree', position, name => name === 'bg'); ctx.restore(); }
        const clouds = assets.animations.clouds;
        if (clouds) for (const track of clouds.tracks) {
          const range = clouds.ranges?.[track.name]; if (!range) continue;
          const position = reduced ? range.start : range.start + ((now - startTime) / 1000 * .2 + (range.end - range.start) * .37) % Math.max(1, range.end - range.start);
          drawAnimation(ctx, assets, 'clouds', position, name => name === track.name);
        }
        if (!growing && foregroundCtx) {
          if (cachedPosition !== position) {
            foregroundCtx.clearRect(0, 0, 800, 600); foregroundCtx.save(); foregroundCtx.translate(.5, .5);
            drawAnimation(foregroundCtx, assets, 'tree', position, name => name !== 'bg'); foregroundCtx.restore(); cachedPosition = position;
          }
          ctx.drawImage(foreground, 0, 0);
        } else { ctx.save(); ctx.translate(.5, .5); drawAnimation(ctx, assets, 'tree', position, name => name !== 'bg'); ctx.restore(); }
      }
      if (!state.tree?.planted && assets.images.EMPTY_POT) ctx.drawImage(assets.images.EMPTY_POT, 366.5, 408);
      const fedSeconds = feedStarted ? (now - feedStarted) / 1000 : Infinity;
      const feeding = !!feedStarted && fedSeconds < feedingDuration;
      const phase = feeding ? 'pouring' : growing ? 'growing' : 'idle';
      if (phase !== previousPhase.current) { previousPhase.current = phase; setFeedPhase(phase); }
      if (feeding && foodAnimation) {
        // Keep the original pour tracks and placement; reduced motion holds the pour's key pose.
        ctx.save(); ctx.translate(340, 300); drawAnimation(ctx, assets, 'treefood', reduced ? Math.min(19, foodAnimation.frameCount - 1) : fedSeconds * foodAnimation.fps); ctx.restore();
      }
      if (animating.current && !feeding && !growing && (!growthStarted || now >= growthStarted)) changeAnimationBusy(false);
      const activeDrag = drag.current;
      if (activeDrag?.moved && activeDrag.valid) {
        const mask = getTreeMask();
        if (mask) { ctx.save(); ctx.globalAlpha = .35; ctx.filter = 'brightness(1.9)'; ctx.drawImage(mask.canvas, 0, 0); ctx.restore(); }
      }
      if (assets.images.IMAGE_TREEFOOD) { ctx.save(); ctx.globalAlpha = activeDrag?.moved ? .4 : 1; ctx.drawImage(assets.images.IMAGE_TREEFOOD, 22, -5); ctx.restore(); }
      if (assets.images.IMAGE_COINBANK) ctx.drawImage(assets.images.IMAGE_COINBANK, 15, 557);
      ctx.save(); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 18px Arial,"Microsoft YaHei",sans-serif'; ctx.strokeStyle = '#203b13'; ctx.lineWidth = 2;
      ctx.strokeText(`×${state.fertilizer}`, 77, 66); ctx.fillText(`×${state.fertilizer}`, 77, 66);
      ctx.fillStyle = '#f2df72'; ctx.font = 'bold 18px Arial,"Microsoft YaHei",sans-serif'; ctx.fillText(String(state.coins), 93, 579);
      const visibleHeight = feeding ? beforeFeedingHeight : state.tree?.height || 0;
      if (state.tree?.planted && visibleHeight >= 50) { ctx.font = 'bold 22px Arial,"Microsoft YaHei",sans-serif'; ctx.fillStyle = '#111b0c'; ctx.fillText(`${visibleHeight} 英尺高`, 400, 35); }
      const rewardSeconds = growthStarted ? (now - growthStarted) / 1000 : Infinity;
      const showingReward = !!feedStarted && rewardSeconds >= 0 && rewardSeconds < 2.2 && (!!state.reward || growthDelta > 0);
      if (showingReward) {
        const fraction = rewardSeconds / 2.2; ctx.globalAlpha = Math.min(1, (1 - fraction) * 2); ctx.fillStyle = '#ffe56b'; ctx.strokeStyle = '#5f4117'; ctx.lineWidth = 4; ctx.font = 'bold 28px Arial,"Microsoft YaHei",sans-serif';
        const y = 278 - (reduced ? 0 : fraction * 42), text = [growthDelta > 0 ? `+${growthDelta} 英尺` : '', state.reward ? `+${state.reward} 金币` : ''].filter(Boolean).join(' · '); ctx.strokeText(text, 400, y); ctx.fillText(text, 400, y);
        const coin = assets.animations.coin;
        if (coin && state.reward) { ctx.save(); ctx.translate(342, y + 10); ctx.scale(.7, .7); drawAnimation(ctx, assets, 'coin', (reduced ? 0 : fedSeconds * coin.fps) % Math.max(1, coin.frameCount - 1)); ctx.restore(); }
      }
      ctx.restore();
      if (activeDrag?.moved) {
        const bag = assets.images.IMAGE_REANIM_TREEFOOD || assets.images.IMAGE_TREEFOOD;
        if (bag) ctx.drawImage(bag, activeDrag.x - 40, activeDrag.y - 40);
        ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold 17px Arial,"Microsoft YaHei",sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = '#163419'; ctx.fillStyle = '#fff';
        const text = activeDrag.valid ? '松开施肥' : '拖到智慧树上';
        ctx.strokeText(text, 400, 478); ctx.fillText(text, 400, 478); ctx.restore();
      }
      if (growing || (!reduced && feeding) || (showingReward && !reduced)) schedule(1000 / 24);
      else if (feeding) schedule(Math.max(1, (feedingDuration - fedSeconds) * 1000));
      else if (showingReward) schedule(Math.max(1, (2.2 - rewardSeconds) * 1000));
      else if (!reduced) schedule(500);
    };
    const visibility = () => {
      if (document.hidden) { hiddenAt = performance.now(); cancelScheduled(); }
      else {
        if (hiddenAt) {
          const elapsed = performance.now() - hiddenAt; startTime += elapsed;
          if (growthStarted) growthStarted += elapsed;
          if (feedStarted) feedStarted += elapsed;
          hiddenAt = 0;
        }
        schedule();
      }
    };
    const motionChanged = () => schedule();
    requestDraw.current = schedule;
    document.addEventListener('visibilitychange', visibility); motion.addEventListener('change', motionChanged);
    schedule();
    return () => { cancelScheduled(); requestDraw.current = undefined; paintBackground.current = undefined; document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', motionChanged); if (animating.current) changeAnimationBusy(false); };
  }, [assets]);
  useEffect(() => { requestDraw.current?.(); }, [tree?.planted, tree?.height, fertilizer, coins, feedNonce, reward]);
  const height = tree?.height || 0;
  const bubble = height < 7 ? [400, 152] : height < 12 ? [395, 60] : [390, 52];
  return <div className="game-viewport" data-feed-phase={feedPhase}><canvas ref={canvas} width={800} height={600} role="img" aria-label={tree?.planted ? `智慧树，高度 ${tree.height} 英尺，肥料 ${fertilizer} 袋。拖动左上肥料到树上施肥，直接点击树听一句智慧。` : '花园里有一个等待播种的空花盆。'} onClick={event => {
    if (busy || animating.current || !assets || drag.current) return;
    const { x, y } = point(event);
    if (tree?.planted) { if (hitsTree(x, y)) talk(); }
    else if (x >= 345 && x <= 460 && y >= 385 && y <= 490) interact();
  }} onContextMenu={event => {
    if (!drag.current) return;
    event.preventDefault(); drag.current = null; setDragMessage('肥料已放回。'); requestDraw.current?.();
  }} />
    {!assets && <div className="game-loading" role="status">{error ? <><strong>原版画面载入失败</strong><p>{error}</p><button onClick={() => setReload(value => value + 1)}>重新载入素材</button></> : '正在载入原版花园与动画…'}</div>}
    {assets && <div className="scene-bubble" style={{ left: `${bubble[0] / 8}%`, top: `${bubble[1] / 6}%`, backgroundImage: 'url(/assets/images/IMAGE_STORE_SPEECHBUBBLE2.png)' }} aria-live="polite"><p>{tip}</p></div>}
    {assets && <button className="scene-hotspot scene-food" aria-label="拖动肥料到智慧树" title="按住拖到树上；键盘 Enter 施肥" style={{ touchAction: 'none', cursor: busy || animationBusy ? 'default' : 'grab' }} disabled={busy || animationBusy || !tree?.planted || fertilizer < 1} onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={event => dragEnd(event)} onPointerCancel={event => dragEnd(event, true)} onLostPointerCapture={() => { if (drag.current) { drag.current = null; setDragMessage('肥料已放回。'); requestDraw.current?.(); } }} onClick={event => { if (event.detail === 0 && canFeed()) interact(); }} />}
    <span className="scene-accessible-action" role="status" aria-live="polite">{dragMessage}</span>
    <button className="scene-accessible-action" onClick={interact} disabled={busy || animationBusy || !assets || (!!tree?.planted && fertilizer < 1)}>{readyLabel}</button>
    {tree?.planted && <button className="scene-accessible-action" onClick={talk} disabled={busy || animationBusy || !assets}>听智慧树说一句话</button>}
  </div>;
}
