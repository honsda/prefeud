<script lang="ts">
  import { onMount } from 'svelte';
  import * as PIXI from 'pixi.js';
  import { loadRivers, bundledRivers, neRivers, neSuperseded, simplifyLine } from '../lib/rivers';
  import { loadLand, loadLakes } from '../lib/hydro';
  import {
    REGION,
    ENGINE_TILE,
    LON_SPAN,
    LAT_SPAN,
    PX_PER_DEG_E0,
    regionSize,
    regionTiles,
    levelForScreenPxPerDeg,
    sourceZoomForLevel,
    lonLatOf,
  } from '../lib/region';
  import {
    getTileCanvas,
    buildBaseUnderlay,
    buildBiomeBase,
    setBiomeMode,
    paintVectorFallback,
    clearPaintedCache,
    paintLakesOntoBase,
    sampleAny,
    sampleBiome,
    biomeInfo,
    BIOME_LIST,
    engineKey,
    formatElev,
  } from '../lib/tileEngine';

  let host: HTMLDivElement;
  let tooltip: HTMLDivElement;

  let status = $state('Booting…');
  let progress = $state(0);
  let ready = $state(false);
  let streaming = $state(false);
  let collapsed = $state(false);
  let fps = $state(0);
  let zoomLabel = $state('100%');
  let hoverInfo = $state('Hover the map');
  let pixelCount = $state('');
  let detailLabel = $state('');

  const { w: dataW, h: dataH } = regionSize(0); // world units = E0 px

  let app: PIXI.Application | null = null;
  let canvasElRef: HTMLCanvasElement | null = null;
  let world: PIXI.Container | null = null;
  let tilesLayer: PIXI.Container | null = null;
  let riverLayer: PIXI.Graphics | null = null;
  let highlight: PIXI.Graphics | null = null;
  let baseScale = 1;
  let interacted = false;
  let lastCX = 0;
  let lastCY = 0;
  let raf = 0;
  let disposed = false;
  let tScale = 1;
  let tPosX = 0;
  let tPosY = 0;
  let zooming = false;

  // --- tile streaming state (imperative, outside reactivity) ---
  // Ultra always on: full E3 pyramid, no quality tiers
  let maxLevel = 3;
  let curLevel = 0;
  let tileEpoch = 0;
  let queue: string[] = [];
  let prefetchQ: string[] = [];
  let inflight = new Set<string>();
  let needed = new Set<string>();
  let sprites = new Map<string, PIXI.Sprite>();
  let spritePool: PIXI.Sprite[] = [];
  let tilesTimer: ReturnType<typeof setTimeout> | null = null;
  let terrainOK = true;
  let warmed = false;
  let baseCanvas: HTMLCanvasElement | null = null; // currently displayed base
  let terrainBase: HTMLCanvasElement | null = null; // E0 elevation (kept across mode swaps)
  let baseTex: PIXI.Texture | null = null;
  let baseSprite: PIXI.Sprite | null = null;
  // painted canvases awaiting GPU upload (paced: ≤2 per frame, no upload hitches)
  let pendingMats: { key: string; es: number; xs: number; ys: number; canvas: HTMLCanvasElement }[] = [];

  // soft loading transitions: sprite fades in from blurred/transparent,
  // then settles to its crisp final filter (no per-tile shader cost)
  interface Fade {
    key: string;
    sp: PIXI.Sprite;
    tex: PIXI.Texture;
    t0: number;
    dur: number;
    final: 'linear' | 'nearest';
    done: (() => void) | null;
  }
  let fades: Fade[] = [];

  /** Advance soft loading transitions (fade + settle to crisp filter). */
  function pumpFades(now: number) {
    if (fades.length === 0) return;
    fades = fades.filter((f) => {
      if (f.sp.label !== f.key) return false; // recycled for another tile — drop
      const t = Math.min(1, (now - f.t0) / f.dur);
      // ease-out: fast appear, gentle settle
      f.sp.alpha = 1 - (1 - t) * (1 - t);
      if (t >= 1) {
        // style lives on the SOURCE, not the texture — and update() is what
        // rebinds the live GL sampler (without it tiles stay LINEAR forever)
        const src = f.tex.destroyed ? null : f.tex.source;
        if (src) {
          src.scaleMode = f.final;
          src.style.update();
        }
        f.done?.();
        return false;
      }
      return true;
    });
  }

  function gpuEstimateMB(): number {
    return 5 + sprites.size * 0.25; // E0 base + 256² tiles
  }

  function virtualSize(e: number): string {
    const { w, h } = regionSize(e);
    return `${w.toLocaleString('en-US')} × ${h.toLocaleString('en-US')}`;
  }

  // painted canvases already carrying lakes (base swaps canvases on sharpen)
  let laked = new WeakSet<HTMLCanvasElement>();

  /** Fill lakes onto the current base canvas in place (no repaint). */
  function applyLakesToBase() {
    if (!baseCanvas || laked.has(baseCanvas)) return;
    paintLakesOntoBase(baseCanvas);
    laked.add(baseCanvas);
    baseTex?.source.update();
  }

  /** Live river overlay: resolution-independent vectors over pixel tiles.
   *  Constant screen width at any zoom (rebuilt on settle, not per frame),
   *  so rivers never turn into chunky pixel bands when magnified. */
  function redrawRivers() {
    if (!riverLayer || !world || disposed) return;
    riverLayer.clear();
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    const m = 40; // margin so lines don't clip at the viewport edge
    const x0 = (0 - world.position.x) / world.scale.x - m;
    const x1 = (vw - world.position.x) / world.scale.x + m;
    const y0 = (0 - world.position.y) / world.scale.y - m;
    const y1 = (vh - world.position.y) / world.scale.y + m;
    const tl = lonLatOf(x0, y0);
    const br = lonLatOf(x1, y1);
    const loMin = Math.min(tl.lon, br.lon);
    const loMax = Math.max(tl.lon, br.lon);
    const laMin = Math.min(tl.lat, br.lat);
    const laMax = Math.max(tl.lat, br.lat);
    const X = (lon: number) => ((lon - REGION.lonMin) / LON_SPAN) * dataW;
    const Y = (lat: number) => ((REGION.latMax - lat) / LAT_SPAN) * dataH;
    // simplify to ~0.25 screen px: kills sub-pixel jitter only — meanders
    // stay true at every zoom (0.6px cut visible 1km bends at fit view)
    const tolDeg = 0.25 / ((world.scale.x * dataW) / LON_SPAN);
    const pass = (list: { bbox: [number, number, number, number]; lines: Float32Array[] }[], width: number) => {
      for (const f of list) {
        const bb = f.bbox;
        if (bb[2] < loMin || bb[0] > loMax || bb[3] < laMin || bb[1] > laMax) continue;
        for (const line of f.lines) {
          const s = simplifyLine(line, tolDeg);
          if (!s) continue;
          riverLayer!.moveTo(X(s[0]), Y(s[1]));
          for (let i = 2; i < s.length; i += 2) riverLayer!.lineTo(X(s[i]), Y(s[i + 1]));
        }
      }
      riverLayer!.stroke({ width: width / world!.scale.x, color: 0x8ec9ff, alpha: 0.95, join: 'round', cap: 'round' });
    };
    const ne = neRivers();
    if (ne) pass(
      // bundled OSM detail supersedes the crude NE copy (Ishikari etc.)
      ne.filter((f) => f.rank <= 2 && !neSuperseded(f.bbox)),
      2.25,
    );
    // OSM named systems: unranked, uniform hairlines (GPS-smooth already)
    pass(bundledRivers(), 1.5);
    if (ne) pass(
      ne.filter((f) => f.rank > 2 && !neSuperseded(f.bbox)),
      1.5,
    );
  }

  /** Full viewport re-stream (data arrived after tiles painted). Evicting GPU
   *  sprites is required — clearing the CPU cache alone never repaints them,
   *  since present sprites block re-queueing and would keep stale pixels. */
  function refreshAllTiles() {
    tileEpoch++;
    queue = [];
    prefetchQ = [];
    if (tilesLayer) {
      for (const [k, sp] of sprites) {
        tilesLayer.removeChild(sp);
        sp.texture.destroy(true);
        if (spritePool.length < 64) spritePool.push(sp);
        else sp.destroy();
        sprites.delete(k);
      }
    }
    updateTiles();
  }

  let dataRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Collapse rapid successive dataset arrivals into one re-stream. */
  function scheduleDataRefresh() {
    if (dataRefreshTimer) clearTimeout(dataRefreshTimer);
    dataRefreshTimer = setTimeout(() => {
      clearPaintedCache();
      refreshAllTiles();
    }, 800);
  }
  /** Reconcile visible tiles: evict off-screen, queue missing, update stats. */
  function updateTiles() {
    if (!ready || !terrainOK || !world || !tilesLayer || disposed) return;
    const spp = (world.scale.x * dataW) / LON_SPAN; // screen px per degree
    // level hysteresis: ±0.6 deadband stops E-flapping mid-zoom, which was
    // mass-destroying/repainting tiles on every wheel tick
    const cont = Math.log2(Math.max(0.5, spp / PX_PER_DEG_E0));
    let e = curLevel;
    if (cont >= curLevel + 0.6) e = Math.min(maxLevel, Math.floor(cont + 0.5));
    else if (cont <= curLevel - 0.6) e = Math.max(0, Math.floor(cont + 0.5));
    e = Math.max(0, Math.min(maxLevel, e));
    if (e !== curLevel) {
      curLevel = e;
      tileEpoch++;
      queue = [];
      prefetchQ = [];
    }
    needed = new Set<string>();
    if (e === 0) {
      // base underlay only — the "smooth illusion"
      for (const [k, sp] of sprites) {
        tilesLayer.removeChild(sp);
        sp.texture.destroy(true);
        if (spritePool.length < 64) spritePool.push(sp);
        else sp.destroy();
        sprites.delete(k);
      }
      // proactively warm E1 around screen center so first zoom is instant
      warmCenter();
      updateStats();
      redrawRivers();
      return;
    }

    const vw = host.clientWidth;
    const vh = host.clientHeight;
    const x0 = Math.max(0, (0 - world.position.x) / world.scale.x);
    const x1 = Math.min(dataW, (vw - world.position.x) / world.scale.x);
    const y0 = Math.max(0, (0 - world.position.y) / world.scale.y);
    const y1 = Math.min(dataH, (vh - world.position.y) / world.scale.y);
    const { nx, ny } = regionTiles(e);
    const s = ENGINE_TILE / 2 ** e; // tile size in world units
    let tx0 = Math.max(0, Math.floor(x0 / s) - 1);
    let tx1 = Math.min(nx - 1, Math.floor(x1 / s) + 1);
    let ty0 = Math.max(0, Math.floor(y0 / s) - 1);
    let ty1 = Math.min(ny - 1, Math.floor(y1 / s) + 1);

    const cx = (tx0 + tx1) / 2;
    const cy = (ty0 + ty1) / 2;
    const missing: { k: string; d: number }[] = [];
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = engineKey(e, tx, ty);
        needed.add(k);
        if (!sprites.has(k) && !inflight.has(k))
          missing.push({ k, d: Math.hypot(tx - cx, ty - cy) });
      }
    missing.sort((a, b) => a.d - b.d);
    queue = missing.map((m) => m.k);

    // evict sprites that scrolled out (GPU memory is O(viewport))
    for (const [k, sp] of sprites) {
      if (!needed.has(k)) {
        tilesLayer.removeChild(sp);
        sp.texture.destroy(true);
        if (spritePool.length < 64) spritePool.push(sp);
        else sp.destroy();
        sprites.delete(k);
      }
    }
    updateStats();
    redrawRivers();
  }

  function warmCenter() {
    // paint a few E1 tiles around the visible center in the background
    if (!world || warmed) return;
    warmed = true;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    const ccx = (vw / 2 - world.position.x) / world.scale.x;
    const ccy = (vh / 2 - world.position.y) / world.scale.y;
    const s = ENGINE_TILE / 2;
    const tcx = Math.floor(ccx / s);
    const tcy = Math.floor(ccy / s);
    const { nx, ny } = regionTiles(1);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const tx = tcx + dx;
        const ty = tcy + dy;
        if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) continue;
        const k = engineKey(1, tx, ty);
        if (!inflight.has(k)) prefetchQ.push(k);
      }
  }

  function updateStats() {
    // drop transitions for evicted tiles — never touch dead textures
    fades = fades.filter((f) => f.key === 'base-sharpen' || sprites.has(f.key));    detailLabel =
      curLevel === 0
        ? `E0 base · smooth LOD · ~${gpuEstimateMB().toFixed(0)}MB GPU`
        : `E${curLevel} ${virtualSize(curLevel)} virtual · L${curLevel} local data · ${sprites.size} tiles · ~${gpuEstimateMB().toFixed(0)}MB GPU`;
    streaming = queue.length > 0 || inflight.size > 0 || pendingMats.length > 0;
  }

  /** Pump the paint queue: paced so panning stays at 60fps while streaming. */
  function pumpTiles() {    if (!ready || !terrainOK || disposed || inflight.size >= 2) return;
    const fromMain = queue.length > 0;
    const next = fromMain ? queue[0] : prefetchQ[0];
    if (!next) {
      if (streaming) updateStats();
      return;
    }
    const es = Number(next.split('/')[0]);
    const isWarm = es === 1 && curLevel === 0;
    if (es !== curLevel && !isWarm) {
      // stale level entry — drain it
      if (fromMain) queue.shift();
      else prefetchQ.shift();
      return;
    }
    if (fromMain) queue.shift();
    else prefetchQ.shift();
    const [, xs, ys] = next.split('/').map(Number);
    inflight.add(next);
    const epoch = tileEpoch;
    getTileCanvas(es, xs, ys, () => epoch !== tileEpoch || disposed).then((canvas) => {
      inflight.delete(next);
      if (disposed || !canvas || epoch !== tileEpoch) {
        if (epoch === tileEpoch) updateStats();
        return;
      }
      if (!needed.has(next) || sprites.has(next)) {
        updateStats(); // warmed cache / already materialized / stale
        return;
      }
      pendingMats.push({ key: next, es, xs, ys, canvas });
      updateStats();
    }).catch((err) => {
      // a single bad tile must never stall the stream (inflight slot freed)
      inflight.delete(next);
      console.error(`tile ${next} failed:`, err);
      updateStats();
    });
  }

  /** Upload paced materializations: ≤2 GPU uploads per frame, zero hitches. */
  function drainMats() {
    if (!tilesLayer || !world || disposed) {
      pendingMats.length = 0;
      return;
    }
    let n = 0;
    while (pendingMats.length > 0 && n < 2) {
      const m = pendingMats.shift()!;
      if (sprites.has(m.key) || !needed.has(m.key)) continue;
      const tex = PIXI.Texture.from(m.canvas);
      tex.source.scaleMode = 'linear'; // soft while fading in → crisp after
      tex.source.autoGenerateMipmaps = false;
      const sp = spritePool.pop() ?? new PIXI.Sprite();
      sp.texture = tex;
      const s = ENGINE_TILE / 2 ** m.es;
      sp.position.set(m.xs * s, m.ys * s);
      sp.scale.set(s / ENGINE_TILE);
      sp.alpha = 0;
      sp.label = m.key;
      tilesLayer.addChild(sp);
      if (highlight && world) world.addChild(highlight); // keep picker on top
      sprites.set(m.key, sp);
      fades.push({ key: m.key, sp, tex, t0: performance.now(), dur: 250, final: 'nearest', done: null });
      n++;
    }
  }

  function scheduleTiles(delay = 180) {
    if (tilesTimer) clearTimeout(tilesTimer);
    tilesTimer = setTimeout(updateTiles, delay);
  }

  let mode = $state<'terrain' | 'biome'>('terrain');
  let biomeBase: HTMLCanvasElement | null = null;

  async function setMode(m: 'terrain' | 'biome') {
    if (m === mode || !ready) return;
    mode = m;
    setBiomeMode(m === 'biome');
    if (m === 'biome' && !biomeBase) {
      status = 'Painting biomes…';
      const b = await buildBiomeBase();
      if (disposed) return;
      if (b) biomeBase = b;
      else {
        status = 'Biome data missing';
        mode = 'terrain';
        setBiomeMode(false);
        return;
      }
    }
    if (mode === 'biome' && biomeBase) attachBase(biomeBase, 'biome');
    else if (mode === 'terrain' && terrainBase) attachBase(terrainBase, 'terrain');
    clearPaintedCache();
    refreshAllTiles();
    status = mode === 'biome' ? 'Biomes live — hover for names' : 'Japan live — zoom in, detail streams';
  }

  function attachBase(canvas: HTMLCanvasElement, kind: 'terrain' | 'biome') {
    if (!app || !world) return;
    // replace any previous base (mode swaps) instead of stacking
    if (baseSprite) {
      world.removeChild(baseSprite);
      baseTex?.destroy(true);
      baseSprite.destroy();
      baseSprite = null;
      baseTex = null;
    }
    // E0 smooth underlay: LINEAR-filtered "illusion", 1 draw call
    const texture = PIXI.Texture.from(canvas);
    texture.source.scaleMode = 'linear';
    const base = new PIXI.Sprite(texture);
    base.position.set(0, 0);
    base.scale.set(dataW / canvas.width, dataH / canvas.height);
    world.addChildAt(base, 0);
    baseCanvas = canvas;
    if (kind === 'terrain') terrainBase = canvas;
    else biomeBase = canvas;
    baseTex = texture;
    baseSprite = base;
    fitToScreen(false);
    // focus-pull reveal once the first pixels exist
    const el = app.canvas as HTMLCanvasElement;
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.filter = 'blur(0px)';
      // then drop the filter entirely: even a no-op blur() keeps some
      // browsers on a softened compositor path
      setTimeout(() => {
        el.style.transition = 'none';
        el.style.filter = 'none';
      }, 1300);
    });
  }

  function fitToScreen(resetZoom = true) {
    if (!app || !world) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    baseScale = Math.min(vw / dataW, vh / dataH);
    if (resetZoom || !interacted) {
      world.scale.set(baseScale);
      world.position.set((vw - dataW * baseScale) / 2, (vh - dataH * baseScale) / 2);
      tScale = baseScale;
      tPosX = world.position.x;
      tPosY = world.position.y;
      zooming = false;
      updateZoomLabel();
    }
  }

  function updateZoomLabel() {
    if (!world) return;
    const rel = world.scale.x / baseScale;
    zoomLabel = rel >= 10 ? `${rel.toFixed(1)}×` : `${Math.round(rel * 100)}%`;
  }

  function fitAnimated() {
    if (!app || !world) return;
    interacted = false;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    baseScale = Math.min(vw / dataW, vh / dataH);
    tScale = baseScale;
    const [px, py] = clampPos((vw - dataW * tScale) / 2, (vh - dataH * tScale) / 2, tScale);
    tPosX = px;
    tPosY = py;
    zooming = true;
  }

  function screenToData(sx: number, sy: number) {
    if (!world) return null;
    const rect = (app!.canvas as HTMLCanvasElement).getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    const wx = (cx - world.position.x) / world.scale.x;
    const wy = (cy - world.position.y) / world.scale.y;
    if (wx < 0 || wy < 0 || wx >= dataW || wy >= dataH) return null;
    return { dx: wx, dy: wy };
  }

  // smooth-zoom targets: gestures steer the target, the ticker eases to it
  // (component scope: shared by fitToScreen, zoomAt, pan handler and ticker)

  function zoomAt(clientX: number, clientY: number, factor: number) {
    if (!world || !app || !canvasElRef) return;
    const rect = canvasElRef.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    // anchor in the current TARGET so rapid wheel ticks don't drift
    const wx = (cx - tPosX) / tScale;
    const wy = (cy - tPosY) / tScale;
    const min = baseScale * 1; // fit = furthest out: the box always fills view
    const max = baseScale * 128;
    let s = tScale * factor;
    s = Math.max(min, Math.min(max, s));
    tScale = s;
    const [px, py] = clampPos(cx - wx * s, cy - wy * s, s);
    tPosX = px;
    tPosY = py;
    zooming = true;
  }

  /** Contain-clamp: the viewport may never leave the map box. */
  function clampPos(px: number, py: number, s: number): [number, number] {
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    const ww = dataW * s;
    const wh = dataH * s;
    px = ww >= vw ? Math.max(vw - ww, Math.min(0, px)) : (vw - ww) / 2;
    py = wh >= vh ? Math.max(vh - wh, Math.min(0, py)) : (vh - wh) / 2;
    return [px, py];
  }

  function clampWorld() {
    if (!world || !app) return;
    const [x, y] = clampPos(world.position.x, world.position.y, world.scale.x);
    world.position.set(x, y);
  }

  onMount(() => {
    disposed = false;
    let pointers = new Map<number, { x: number; y: number }>();
    let lastPinch = 0;
    let dragging = false;
    let dragMoved = 0;
    let lastX = 0;
    let lastY = 0;
    let frames = 0;
    let lastFpsT = performance.now();
    let lastMoveUpdate = 0;

    (async () => {
      // rivers + hydro load in parallel with everything else (never block first paint)
      loadRivers().then(() => {
        if (disposed) return;
        redrawRivers(); // overlay picks up NE background rivers
      });
      const hydroArrived = () => {
        if (disposed) return;
        applyLakesToBase();
        scheduleDataRefresh(); // repaint pre-mask tiles with true coasts
      };
      loadLand().then(hydroArrived, () => {});
      loadLakes().then(hydroArrived, () => {});

      app = new PIXI.Application();
      await app.init({
        background: '#030712',
        antialias: false,
        roundPixels: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (disposed) return;
      host.prepend(app.canvas as HTMLCanvasElement);
      const canvasEl = app.canvas as HTMLCanvasElement;
      canvasElRef = canvasEl;
      canvasEl.style.position = 'absolute';
      canvasEl.style.inset = '0';
      canvasEl.style.touchAction = 'none';
      canvasEl.style.cursor = 'grab';
      // cinematic focus-pull on boot: blurred + transparent until first pixels
      canvasEl.style.transition = 'opacity 0.9s ease, filter 1.1s ease';
      canvasEl.style.opacity = '0';
      canvasEl.style.filter = 'blur(10px)';

      const resize = () => {
        app?.renderer.resize(host.clientWidth, host.clientHeight);
        fitToScreen(false);
        scheduleTiles();
      };
      resize();
      new ResizeObserver(resize).observe(host);

      world = new PIXI.Container();
      app.stage.addChild(world);
      tilesLayer = new PIXI.Container();
      world.addChild(tilesLayer);
      riverLayer = new PIXI.Graphics();
      world.addChild(riverLayer); // above tiles, crisp at any zoom
      highlight = new PIXI.Graphics();
      world.addChild(highlight); // picker stays topmost (never inside riverLayer: clear() would drop it)

      // --- base: single fast build from the local DEM grid (no network) ---
      try {
        status = 'Painting terrain…';
        const r = await buildBaseUnderlay((p) => {
          progress = p;
        });
        if (disposed || !r || !world) return;
        const s2 = r.canvas;
        if (!laked.has(s2)) {
          paintLakesOntoBase(s2);
          laked.add(s2);
        }
        attachBase(s2, 'terrain'); // focus-pull reveal covers the transition
        pixelCount = `Japan E0 ${dataW}×${dataH} · virtual up to ${virtualSize(maxLevel)}`;
        progress = 1;
        ready = true;
        status = r.masked
          ? 'Japan live — zoom in, detail streams'
          : 'Japan live — coasts approximate (mask offline)';
        updateTiles();
      } catch (err) {
        console.warn('Terrain unavailable, vector fallback:', err);
        terrainOK = false;
        const fb = await paintVectorFallback();
        const canvas =
          fb ??
          (() => {
            const c = document.createElement('canvas');
            c.width = 640;
            c.height = 576;
            const g = c.getContext('2d')!;
            g.fillStyle = '#060b16';
            g.fillRect(0, 0, 640, 576);
            return c;
          })();
        if (disposed) return;
        attachBase(canvas, 'terrain');
        pixelCount = `Japan E0 ${dataW}×${dataH} · offline outline`;
        ready = true;
        status = 'Offline outline (no terrain)';
        updateTiles();
        redrawRivers(); // overlay still works: rivers need no terrain
      }

      // --- pan ---
      canvasEl.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        canvasEl.setPointerCapture(e.pointerId);
        dragging = true;
        dragMoved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        canvasEl.style.cursor = 'grabbing';
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
        }
      });
      canvasEl.addEventListener('pointermove', (e) => {
        lastCX = e.clientX;
        lastCY = e.clientY;
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // pinch zoom
        if (pointers.size === 2 && world && app) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (lastPinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / lastPinch);
          lastPinch = d;
          interacted = true;
          updateHover((a.x + b.x) / 2, (a.y + b.y) / 2);
          scheduleTiles(450);
          return;
        }

        if (dragging && pointers.size === 1 && world) {
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          dragMoved += Math.abs(dx) + Math.abs(dy);
          world.position.x += dx;
          world.position.y += dy;
          lastX = e.clientX;
          lastY = e.clientY;
          interacted = true;
          clampWorld();
          // drags steer the target too so the ease never fights the pointer
          tPosX = world.position.x;
          tPosY = world.position.y;
          tScale = world.scale.x;
          zooming = false;
          // stream while panning (throttled)
          const now = performance.now();
          if (now - lastMoveUpdate > 200) {
            lastMoveUpdate = now;
            updateTiles();
          }
        }

        if (!dragging || dragMoved < 4) updateHover(e.clientX, e.clientY);
      });
      const endPointer = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) lastPinch = 0;
        if (pointers.size === 0) {
          dragging = false;
          canvasEl.style.cursor = 'grab';
          updateTiles();
        }
      };
      canvasEl.addEventListener('pointerup', endPointer);
      canvasEl.addEventListener('pointercancel', endPointer);

      // --- wheel zoom to cursor ---
      canvasEl.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.0015);
          zoomAt(e.clientX, e.clientY, factor);
          interacted = true;
          updateHover(e.clientX, e.clientY); // wheel sends no pointermove: refresh outline
          scheduleTiles(450); // settle first: no destroy/repaint churn mid-gesture
        },
        { passive: false },
      );

      canvasEl.addEventListener('dblclick', (e) => {
        zoomAt(e.clientX, e.clientY, 2);
        interacted = true;
        updateHover(e.clientX, e.clientY);
        updateTiles();
      });

      function updateHover(clientX: number, clientY: number) {
        const hit = screenToData(clientX, clientY);
        if (!highlight) return;
        highlight.clear();
        if (!hit) {
          hoverInfo = 'Outside map';
          if (tooltip) tooltip.style.opacity = '0';
          return;
        }
        // outline the true data cell of the TARGET level (settled level lags
        // mid-gesture, which used to draw a giant stale square)
        const spp = (world!.scale.x * dataW) / LON_SPAN;
        const tLevel = levelForScreenPxPerDeg(spp, maxLevel);
        const cell = 1 / 2 ** tLevel;
        const gx = Math.floor(hit.dx / cell) * cell;
        const gy = Math.floor(hit.dy / cell) * cell;
        // explicit 4-bar outline via fill (rect+stroke rendered filled)
        const s = Math.min(cell * 0.25, 1.5 / world!.scale.x);
        highlight.rect(gx, gy, cell, s);
        highlight.rect(gx, gy + cell - s, cell, s);
        highlight.rect(gx, gy + s, s, cell - 2 * s);
        highlight.rect(gx + cell - s, gy + s, s, cell - 2 * s);
        highlight.fill({ color: 0xffffff });
        const { lat, lon } = lonLatOf(hit.dx, hit.dy);
        const ns = lat >= 0 ? 'N' : 'S';
        const ew = lon >= 0 ? 'E' : 'W';
        let elevTxt = '';
        if (mode === 'biome') {
          const b = sampleBiome(lat, lon);
          if (b) {
            const info = biomeInfo(b.id);
            elevTxt = ` · ${info.name}${info.comp.length > 0 ? ' (' + info.comp.slice(0, 3).join(' · ') + ')' : ''}`;
          }
        } else if (terrainOK) {
          const s = sampleAny(lat, lon);
          if (s) elevTxt = ` · ${formatElev(s.elev)} (L${s.z})`;
        }
        hoverInfo = `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}${elevTxt}`;
        if (tooltip) {
          tooltip.style.opacity = '1';
          const rect = host.getBoundingClientRect();
          tooltip.style.left = `${clientX - rect.left + 16}px`;
          tooltip.style.top = `${clientY - rect.top + 12}px`;
          tooltip.textContent = hoverInfo;
        }
      }

      // fps meter + tile pump + fades + uploads share the ticker
      app.ticker.add(() => {
        frames++;
        const now = performance.now();
        if (now - lastFpsT >= 500) {
          fps = Math.round((frames * 1000) / (now - lastFpsT));
          frames = 0;
          lastFpsT = now;
        }
        // ease actual transform toward the zoom target (frame-rate independent)
        if (world && app && zooming) {
          const dt = Math.min(0.05, app.ticker.deltaMS / 1000);
          const k = 1 - Math.exp(-dt * 11);
          const nx = world.scale.x + (tScale - world.scale.x) * k;
          const npx = world.position.x + (tPosX - world.position.x) * k;
          const npy = world.position.y + (tPosY - world.position.y) * k;
          world.scale.set(nx);
          world.position.set(npx, npy);
          updateZoomLabel();
          if (
            Math.abs(nx - tScale) < baseScale * 0.002 &&
            Math.hypot(npx - tPosX, npy - tPosY) < 0.75
          ) {
            world.scale.set(tScale);
            world.position.set(tPosX, tPosY);
            zooming = false;
            updateZoomLabel();
            updateTiles();
          }
        }
        pumpTiles();
        drainMats();
        pumpFades(now);
      });
    })();

    raf = requestAnimationFrame(function loop() {
      if (!disposed) raf = requestAnimationFrame(loop);
    });

    return () => {
      disposed = true;
      tileEpoch++;
      if (tilesTimer) clearTimeout(tilesTimer);
      if (dataRefreshTimer) clearTimeout(dataRefreshTimer);
      cancelAnimationFrame(raf);
      app?.destroy(true, { children: true, texture: true });
      app = null;
    };
  });
</script>

<div bind:this={host} class="fixed inset-0 overflow-hidden bg-gray-950 select-none">
  <!-- Pixi canvas is prepended here -->

  <!-- cursor tooltip -->
  <div
    bind:this={tooltip}
    class="pointer-events-none absolute z-20 rounded-md bg-black/80 px-2 py-1 font-mono text-[11px] text-white opacity-0 transition-opacity"
  ></div>

  <!-- HUD -->
  <div class="pointer-events-none absolute left-4 top-4 z-10 max-w-sm">
    {#if collapsed}
      <button
        onclick={() => (collapsed = false)}
        class="pointer-events-auto rounded-xl border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-gray-200 shadow-2xl backdrop-blur-md hover:bg-white/10"
        title="Open menu"
      >
        ☰ menu
      </button>
    {:else}
    <div class="pointer-events-auto rounded-2xl border border-white/10 bg-black/60 p-4 shadow-2xl backdrop-blur-md">
      <div class="flex items-center gap-2">
        <div class="h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_12px_2px_rgba(56,189,248,0.7)]"></div>
        <h1 class="text-sm font-bold tracking-widest text-white uppercase">Prefeud · Japan</h1>
        <button
          onclick={() => (collapsed = true)}
          class="ml-auto rounded-md px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:bg-white/10 hover:text-white"
          title="Collapse menu"
        >
          ✕
        </button>
      </div>
      <p class="mt-1 font-mono text-[11px] text-gray-300">{pixelCount || '…'}</p>
      <p class="mt-1 font-mono text-[11px] text-gray-400">
        {#if !ready}
          {status} {Math.round(progress * 100)}%
        {:else}
          {status}{streaming ? ' · streaming…' : ''} · {fps} fps · {zoomLabel}
        {/if}
      </p>
      {#if !ready}
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div class="h-full rounded-full bg-sky-400 transition-all" style:width={`${progress * 100}%`}></div>
        </div>
      {/if}
      {#if ready}<p class="mt-1 font-mono text-[11px] text-sky-300/90">{detailLabel}</p>{/if}
      <p class="mt-1 font-mono text-[11px] text-amber-200/90">{hoverInfo}</p>

      <!-- elevation legend: 5 flat bands zoomed out, full ramp zoomed in;
           biome chip list in biome mode -->
      {#if mode === 'biome'}
        <div class="mt-3 max-h-44 overflow-y-auto pr-1">
          {#each BIOME_LIST as b}
            <div class="flex items-center gap-2 py-px" title={b.id === 0 ? 'water' : `#${b.id}`}>
              <span
                class="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-white/20"
                style="background: rgb({b.color[0]}, {b.color[1]}, {b.color[2]});"
              ></span>
              <span class="font-mono text-[10px] leading-tight text-gray-300">{b.name}</span>
            </div>
          {/each}
        </div>
      {:else if curLevel === 0}
        <div class="mt-3">
          <div class="flex w-full gap-0.5">
            <div class="h-2 flex-1 rounded-l-full" style="background:#08163a;" title="abyss < −1000 m"></div>
            <div class="h-2 flex-1" style="background:#16448e;" title="shelf"></div>
            <div class="h-2 flex-1" style="background:#34373d;" title="lowland < 800 m"></div>
            <div class="h-2 flex-1" style="background:#707478;" title="highland < 2500 m"></div>
            <div class="h-2 flex-1 rounded-r-full" style="background:#969aa0;" title="alpine"></div>
          </div>
          <div class="mt-0.5 flex justify-between font-mono text-[10px] text-gray-400">
            <span>abyss</span><span>shelf</span><span>low</span><span>high</span><span>alpine</span>
          </div>
        </div>
      {:else}
        <div class="mt-3">
          <div
            class="h-2 w-full rounded-full"
            style="background: linear-gradient(to right, #020614, #03091e, #040d2a, #06133a, #091c4e, #0d2864, #11367a, #16448e 49.5%, #22252a 50.5%, #34373d, #44484e, #5c6066, #707478, #82868c, #969aa0);"
          ></div>
          <div class="mt-0.5 flex justify-between font-mono text-[10px] text-gray-400">
            <span>−11 km</span><span>0</span><span>+8.8 km</span>
          </div>
        </div>
      {/if}

      <div class="pointer-events-auto mt-3 flex flex-wrap gap-1.5">
        {#each [['terrain', 'Terrain'], ['biome', 'Biomes']] as [mk, mlabel]}
          <button
            onclick={() => setMode(mk as 'terrain' | 'biome')}
            class="rounded-lg px-2.5 py-1.5 font-mono text-[11px] transition
              {mode === mk ? 'bg-emerald-400 font-bold text-black' : 'bg-white/10 text-gray-200 hover:bg-white/20'}"
            title={mk === 'biome' ? 'Sengoku biome paint (60 classes)' : 'Elevation + bathymetry relief'}
          >
            {mlabel}
          </button>
        {/each}
        <button
          onclick={() => fitAnimated()}
          class="rounded-lg bg-white/10 px-2.5 py-1.5 font-mono text-[11px] text-gray-200 hover:bg-white/20"
        >
          Fit
        </button>
      </div>
      <p class="mt-2 text-[11px] leading-snug text-gray-400">
        Zoomed out: smooth base illusion · zoom in: only your viewport streams in full detail.
      </p>
      <p class="mt-1 font-mono text-[10px] leading-snug text-gray-500">Local elevation + hydro · no external requests</p>
    </div>
    {/if}
  </div>

  <div class="pointer-events-none absolute bottom-4 right-4 z-10">
    <div class="rounded-xl border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-gray-300 backdrop-blur-md">
      tiled LOD · unload off-screen · IDB cache
    </div>
  </div>
</div>
