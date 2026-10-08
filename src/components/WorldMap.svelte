<script lang="ts">
  import { onMount } from 'svelte';
  import * as PIXI from 'pixi.js';
  import { loadRivers, bundledRivers, neRivers, neSuperseded, simplifyLine, bigRiverFeatures, riversReady } from '../lib/rivers';
  import {
    sampleFields,
    paintSprawl,
    type SimGrid,
    type SprawlResult,
  } from '../lib/settlement';
  import {
    SprawlSession,
    type SolveJob,
    type SolveResult,
    type SprawlQuery,
    type QueryResult,
  } from '../lib/sprawlSession';
  import SprawlWorkerCtor from '../lib/sprawl.worker.ts?worker';
  import {
    costKey,
    costMemGet,
    costMemSet,
    coarseCostKey,
    idbCostGet,
    idbCostPut,
  } from '../lib/sprawlCache';
  import { ensureBiomeGrid, getBaseGrid, getBaseBiome, makeBoxSamplers } from '../lib/tileEngine';
  import { loadLand, loadLakes, landReady, lakesReady, rasterizeLandMask, rasterizeLakeMask, rasterizeRiverBarrier } from '../lib/hydro';
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
  let sprawlLayer: PIXI.Container | null = null;
  let sprawlSprite: PIXI.Sprite | null = null;
  let borderGfx: PIXI.Graphics | null = null;
  let fogSprite: PIXI.Sprite | null = null;
  let centroidGfx: PIXI.Graphics | null = null;
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
  let baseCanvas: HTMLCanvasElement | null = null;
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

  // --- settlement sprawl (Voronoi territories on cost terrain) ---
  interface SNode {
    id: number;
    dx: number; // E0 px
    dy: number;
    lon: number;
    lat: number;
  }
  let nodes = $state<SNode[]>([]);
  let placing = $state(false);
  let sprawlLevel = $state(25);
  let sprawlColor = $state('#38bdf8');
  let sprawlAlpha = $state(35);
  let rCollapsed = $state(false);
  let sprawlStat = $state('');
  let showCentroids = $state(true);
  let showFog = $state(false);
  let capitalId = $state<number | null>(null);
  let selectedId = $state<number | null>(null);
  let selectedInfo = $state<{
    cells: number;
    km2: number;
    supply: number;
    neighbors: { id: number; sharedKm2: number; share: number }[];
  } | null>(null);
  // unexplored = beyond scout reach of any node (fog-of-war data layer)
  const FOG_RANGE = 200;
  // supply radius for the selected territory readout (cost×km)
  const SUPPLY_RANGE = 120;
  let nodeSeq = 1;
  let lastSim: SimGrid | null = null; // fine viewport box descriptor (what you see)
  let lastSprawl: SprawlResult | null = null; // fine result for the box
  let coarse: SprawlResult | null = null; // coarse full-map ownership (competition truth)
  let coarseTag: string | null = null;
  let landMaskE0: Uint8Array | null = null;
  let lakeMaskE0: Uint8Array | null = null;
  let barrierMaskE0: Uint8Array | null = null; // big-river courses (blocked)
  let maskSig: string | null = null;
  let sprawlGen = 0;
  let sprawlTimer: ReturnType<typeof setTimeout> | null = null;
  // painted fine-solve identity (intent gating + budget grows)
  let lastFineTag: string | null = null;
  let lastFineBoxKey: string | null = null;
  let lastFineBudget = 0;
  let lastFineGeo: string | null = null;
  let lastBorderScale = 0;
  let seedlessTag: string | null = null;

  // Two-tier sprawl (game-ready engine):
  // - COARSE (full map, cell=1, FIXED max budget): global winners + boundary
  //   context. Rebuilt only on node/data change — never on pan/zoom/budget
  //   (Dijkstra distances are budget-independent; stats filter dist<=budget).
  // - FINE (viewport + margin, native cell): paints 1:1, box-snapped.
  // Heavy solves run in a Worker (main-thread fallback); cost grids cache
  // (memory LRU + IDB) so slider/node edits skip sampling; budget growth
  // resumes the retained frontier; vector contours stroke at screen width.
  const COARSE_BUDGET = 500; // slider max (100 × 5)
  const FINE_MARGIN = 12; // E0 px of context around the viewport
  /** Screen-sized solve budget: native 1:1 cells over the viewport on typical
   *  displays; coarsen only when the box truly exceeds it. */
  function maxFineCells(): number {
    if (!host) return 2200000;
    const px = host.clientWidth * host.clientHeight;
    return Math.max(1500000, Math.min(3000000, Math.round(px * 2)));
  }

  // --- solve transport: Worker w/ main-thread fallback (same session code) ---
  interface SprawlTransport {
    solve(job: SolveJob): Promise<SolveResult>;
    grow(prevTag: string, newTag: string, budget: number): Promise<SolveResult>;
    query(q: SprawlQuery): Promise<QueryResult>;
    shutdown(): void;
  }

  let transport: SprawlTransport | null = null;
  let workerDead = false; // once tripped, all solves run on the main thread
  let localFallback: SprawlTransport | null = null;

  function createWorkerTransport(): SprawlTransport | null {
    try {
      const worker = new SprawlWorkerCtor();
      let qseq = 1;
      // replies echo the solve tag; queries echo their id — overlapping
      // solves resolve independently, callers discard stale ones by tag
      const pending = new Map<string, (r: SolveResult | QueryResult) => void>();
      const failAll = () => {
        for (const [, res] of pending) {
          try {
            res({ ok: false, reason: 'stale' } as SolveResult);
          } catch {
            /* ignore */
          }
        }
        pending.clear();
      };
      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { kind: string; tag?: string; key?: string; id?: number } & (SolveResult | QueryResult);
        if (m.kind === 'solved' || m.kind === 'grown') {
          const k = m.key ?? m.tag;
          const res = k ? pending.get(`s:${k}`) : undefined;
          if (k) pending.delete(`s:${k}`);
          res?.(m as SolveResult);
        } else if (m.kind === 'qres') {
          const res = pending.get(`q:${m.id}`);
          pending.delete(`q:${m.id}`);
          res?.(m as QueryResult);
        }
      };
      // a dead worker must never hang solves: fail everything in flight and
      // permanently fall back to the main-thread session for future solves
      worker.onerror = () => {
        workerDead = true;
        failAll();
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
        if (transport) {
          transport = null;
        }
        sprawlStat = 'sim worker failed — main-thread fallback';
        scheduleSprawl();
      };
      return {
        solve: (job) =>
          new Promise<SolveResult>((resolve) => {
            pending.set(`s:${job.tag}`, resolve as (r: SolveResult | QueryResult) => void);
            try {
              worker.postMessage({ kind: 'solve', job });
            } catch {
              pending.delete(`s:${job.tag}`);
              resolve({ ok: false, reason: 'bad-input' });
            }
          }),
        grow: (prevTag, newTag, budget) =>
          new Promise<SolveResult>((resolve) => {
            pending.set(`s:${prevTag}`, resolve as (r: SolveResult | QueryResult) => void);
            try {
              worker.postMessage({ kind: 'grow', prev: prevTag, tag: newTag, budget });
            } catch {
              pending.delete(`s:${prevTag}`);
              resolve({ ok: false, reason: 'stale' });
            }
          }),
        query: (q) =>
          new Promise<QueryResult>((resolve) => {
            const id = qseq++;
            pending.set(`q:${id}`, resolve as (r: SolveResult | QueryResult) => void);
            try {
              worker.postMessage({ kind: 'query', id, q });
            } catch {
              pending.delete(`q:${id}`);
              resolve({ ok: false });
            }
          }),
        shutdown: () => {
          pending.clear();
          try {
            worker.terminate();
          } catch {
            /* ignore */
          }
        },
      };
    } catch {
      return null;
    }
  }

  function createLocalTransport(): SprawlTransport {
    const session = new SprawlSession();
    return {
      solve: async (job) => {
        try {
          return await session.solve(job);
        } catch {
          return { ok: false, reason: 'stale' as const };
        }
      },
      grow: async (prevTag, newTag, budget) => {
        try {
          return await session.grow(prevTag, newTag, budget);
        } catch {
          return { ok: false, reason: 'stale' as const };
        }
      },
      query: (q) => Promise.resolve(session.query(q)),
      shutdown: () => {},
    };
  }

  function engine(): SprawlTransport {
    if (workerDead) {
      if (!localFallback) localFallback = createLocalTransport();
      return localFallback;
    }
    if (!transport) transport = createWorkerTransport() ?? createLocalTransport();
    return transport;
  }

  /** Geometry identity: nodes + capital + data inputs. Budget-independent —
   *  Dijkstra distances don't depend on budget, only reachability does, so
   *  the coarse max-budget solve serves every slider position. Rivers are
   *  barriers again (big ones) — their arrival reshapes the sim. */
  function geoTag(): string {
    const n = nodes.map((s) => `${s.dx.toFixed(2)},${s.dy.toFixed(2)}`).join(';');
    const f = `${getBaseGrid() ? 1 : 0}${getBaseBiome() ? 1 : 0}${landReady() ? 1 : 0}${lakesReady() ? 1 : 0}${riversReady() ? 1 : 0}`;
    return `${n}|cap:${capitalId ?? 0}|${f}`;
  }

  function dataTag(): string {
    return `${getBaseGrid() ? 1 : 0}${getBaseBiome() ? 1 : 0}${landReady() ? 1 : 0}${lakesReady() ? 1 : 0}${riversReady() ? 1 : 0}`;
  }

  /** Mean E0-cell area in km² (stats + selected-territory readouts). */
  function e0CellKm2(): number {
    const latMid = (REGION.latMax + REGION.latMin) / 2;
    return (
      ((LON_SPAN / dataW) * 111.32 * Math.cos((latMid * Math.PI) / 180)) *
      ((LAT_SPAN / dataH) * 110.57)
    );
  }

  /** Seed index of the capital node (-1 when none). */
  function capitalIndex(): number {
    if (capitalId == null) return -1;
    return nodes.findIndex((n) => n.id === capitalId);
  }

  /** Static full-E0 land/lake masks (the same vectors the tiles paint).
   *  Sea and lakes stay unpainted; big-river courses barrier both tiers. */
  function ensureE0Masks(): void {
    const sig = `${landReady() ? 1 : 0}|${lakesReady() ? 1 : 0}|${riversReady() ? 1 : 0}`;
    if (maskSig === sig) return;
    maskSig = sig;
    landMaskE0 = null;
    lakeMaskE0 = null;
    barrierMaskE0 = null;
    const view = {
      w: dataW,
      h: dataH,
      xOf: (lon: number) => ((lon - REGION.lonMin) / LON_SPAN) * dataW,
      yOf: (lat: number) => ((REGION.latMax - lat) / LAT_SPAN) * dataH,
      lonMin: REGION.lonMin,
      lonMax: REGION.lonMax,
      latMin: REGION.latMin,
      latMax: REGION.latMax,
    };
    if (landReady()) {
      try {
        landMaskE0 = rasterizeLandMask(view);
      } catch {
        landMaskE0 = null;
      }
    }
    try {
      lakeMaskE0 = rasterizeLakeMask(view);
    } catch {
      lakeMaskE0 = null;
    }
    if (landMaskE0) {
      try {
        // fit-view tolerance: same courses the overlay draws zoomed out
        const fs = host && host.clientWidth > 0 && host.clientHeight > 0
          ? Math.min(host.clientWidth / dataW, host.clientHeight / dataH)
          : baseScale;
        const tol = 0.25 / ((Math.max(0.01, fs) * dataW) / LON_SPAN);
        const feats = bigRiverFeatures(Math.max(1e-6, tol));
        if (feats.length > 0) barrierMaskE0 = rasterizeRiverBarrier(view, feats, 2);
      } catch {
        barrierMaskE0 = null;
      }
    }
  }

  /** Rebuild the coarse global solution (max budget) when geo inputs changed. */
  async function ensureCoarse(tag: string, stale: () => boolean): Promise<boolean> {
    if (coarse && coarseTag === tag) return true;
    if (seedlessTag === tag) return false;
    const dtag = dataTag();
    // costs: memory LRU → IDB → fresh fields (persisted for next session)
    const ck = costKey(0, 0, dataW, dataH, 1, dtag);
    let costs = costMemGet(ck);
    if (!costs) {
      const stored = await idbCostGet(coarseCostKey(dtag));
      if (
        stored && stored.w === dataW && stored.h === dataH &&
        stored.cell === 1 && stored.ox === 0 && stored.oy === 0
      ) {
        costs = stored;
        costMemSet(ck, costs);
      }
      if (stale()) return false;
    }
    let fields: { elev: Float32Array; bio: Int16Array; land: Uint8Array | null; lake: Uint8Array | null; barrier: Uint8Array | null } | null = null;
    if (!costs) {
      ensureE0Masks();
      const { elevAt, biomeAt } = makeBoxSamplers(0, 0, dataW, dataH);
      const f = await sampleFields(0, 0, dataW, dataH, 1, elevAt, biomeAt, stale);
      if (!f || stale()) return false;
      fields = { elev: f.elev, bio: f.bio, land: landMaskE0, lake: lakeMaskE0, barrier: barrierMaskE0 };
    }
    // big-river barriers ship inside the fields payload; small streams ignored
    const res = await engine().solve({
      tag,
      scope: 'coarse',
      box: { ox: 0, oy: 0, w: dataW, h: dataH, cell: 1 },
      seedsE0: nodes.map((n) => ({ x: n.dx, y: n.dy })),
      budget: COARSE_BUDGET,
      capital: capitalIndex(),
      payload: costs
        ? { costs: { cost: costs.cost, blocked: costs.blocked } }
        : { fields: fields! },
      wantDist: true,
      wantCosts: !costs,
    });
    if (!res.ok || stale()) {
      if (res.reason === 'seedless') seedlessTag = tag;
      return false;
    }
    if (res.costs && !costs) {
      const built = {
        w: dataW, h: dataH, cost: res.costs.cost, blocked: res.costs.blocked,
        ox: 0, oy: 0, cell: 1,
      };
      costMemSet(ck, built);
      idbCostPut(coarseCostKey(dtag), built);
    }
    coarse = {
      owner: res.owner!,
      dist: res.dist!,
      counts: res.counts!,
      centroids: res.centroids!,
      contours: res.contours ?? [],
    };
    coarseTag = tag;
    return true;
  }

  function boxView(bx0: number, by0: number, w: number, h: number, cell: number) {
    const tl = lonLatOf(bx0, by0);
    const br = lonLatOf(bx0 + w * cell, by0 + h * cell);
    return {
      w,
      h,
      xOf: (lon: number) => (((lon - REGION.lonMin) / LON_SPAN) * dataW - bx0) / cell,
      yOf: (lat: number) => (((REGION.latMax - lat) / LAT_SPAN) * dataH - by0) / cell,
      lonMin: Math.min(tl.lon, br.lon),
      lonMax: Math.max(tl.lon, br.lon),
      latMin: Math.min(tl.lat, br.lat),
      latMax: Math.max(tl.lat, br.lat),
    };
  }

  function hexRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function scheduleSprawl() {
    if (sprawlTimer) clearTimeout(sprawlTimer);
    sprawlTimer = setTimeout(() => void recomputeSprawl(), 350);
  }

  /** Viewport-sized solve box (pre-cell floats) + snapped plan + identity. */
  function planFineBox(): { bx0: number; by0: number; w: number; h: number; cell: number } | null {
    let bx0 = 0;
    let by0 = 0;
    let bx1 = dataW;
    let by1 = dataH;
    if (world && host) {
      const vw = host.clientWidth;
      const vh = host.clientHeight;
      const vx0 = (0 - world.position.x) / world.scale.x;
      const vy0 = (0 - world.position.y) / world.scale.y;
      const vx1 = (vw - world.position.x) / world.scale.x;
      const vy1 = (vh - world.position.y) / world.scale.y;
      bx0 = Math.min(vx0, vx1) - FINE_MARGIN;
      by0 = Math.min(vy0, vy1) - FINE_MARGIN;
      bx1 = Math.max(vx0, vx1) + FINE_MARGIN;
      by1 = Math.max(vy0, vy1) + FINE_MARGIN;
    }
    bx0 = Math.max(0, Math.min(dataW - 1, bx0));
    by0 = Math.max(0, Math.min(dataH - 1, by0));
    bx1 = Math.max(1, Math.min(dataW, bx1));
    by1 = Math.max(1, Math.min(dataH, by1));
    if (bx1 <= bx0 || by1 <= by0) return null;
    let cell = Math.max(0.125, 1 / 2 ** curLevel); // 1 sim px = 1 map px
    let w = Math.max(1, Math.ceil((bx1 - bx0) / cell));
    let h = Math.max(1, Math.ceil((by1 - by0) / cell));
    const cap = maxFineCells();
    while (w * h > cap) {
      cell *= 2;
      w = Math.max(1, Math.ceil((bx1 - bx0) / cell));
      h = Math.max(1, Math.ceil((by1 - by0) / cell));
    }
    // snap the origin to the cell grid: sprite pixels land exactly on map pixels
    bx0 = Math.floor(bx0 / cell) * cell;
    by0 = Math.floor(by0 / cell) * cell;
    w = Math.max(1, Math.ceil((bx1 - bx0) / cell));
    h = Math.max(1, Math.ceil((by1 - by0) / cell));
    return { bx0, by0, w, h, cell };
  }

  function fineTagFor(plan: { bx0: number; by0: number; w: number; h: number; cell: number }): {
    boxKey: string;
    ftag: string;
  } {
    const r = (v: number) => Math.round(v * 1024) / 1024;
    const boxKey = `${curLevel}|${plan.cell}|${r(plan.bx0)},${r(plan.by0)},${plan.w},${plan.h}`;
    return { boxKey, ftag: `${geoTag()}|${sprawlLevel * 5}|${boxKey}` };
  }

  /** Intent gating (#7): view settles re-solve only when the box actually
   *  moved; otherwise just re-stroke borders for the new scale. */
  function maybeResrawlView() {
    if (!ready || nodes.length === 0 || disposed || !world) return;
    restrokeBordersIfNeeded();
    const plan = planFineBox();
    if (!plan) return;
    const { ftag } = fineTagFor(plan);
    if (ftag === lastFineTag) return;
    scheduleSprawl();
  }

  function restrokeBordersIfNeeded() {
    if (!lastSprawl || !world || lastBorderScale <= 0) return;
    if (Math.abs(world.scale.x / lastBorderScale - 1) > 0.02) paintSprawlBorders();
  }

  type FineFields = {
    elev: Float32Array;
    bio: Int16Array;
    land: Uint8Array | null;
    lake: Uint8Array | null;
    barrier: Uint8Array | null;
  };

  /** Sample + rasterize one box's fields on the main thread (caches live
   *  outside; the worker only ever sees typed arrays). Null when vectors
   *  aren't ready for masks (falls back to elev/biome rules) or on abort. */
  async function buildFineFields(
    ox: number,
    oy: number,
    w: number,
    h: number,
    cell: number,
    stale: () => boolean,
  ): Promise<FineFields | null> {
    let landM: Uint8Array | null = null;
    let lakeM: Uint8Array | null = null;
    let barM: Uint8Array | null = null;
    if (landReady()) {
      const view = boxView(ox, oy, w, h, cell);
      try {
        landM = rasterizeLandMask(view);
      } catch {
        landM = null;
      }
      try {
        lakeM = rasterizeLakeMask(view);
      } catch {
        lakeM = null;
      }
      try {
        const tol = 0.25 / (((world ? world.scale.x : baseScale) * dataW) / LON_SPAN);
        const feats = bigRiverFeatures(Math.max(1e-6, tol));
        if (feats.length > 0) barM = rasterizeRiverBarrier(view, feats, cell >= 0.5 ? 2 : 3);
      } catch {
        barM = null;
      }
      if (stale()) return null;
    }
    const { elevAt, biomeAt } = makeBoxSamplers(ox, oy, ox + w * cell, oy + h * cell);
    const f = await sampleFields(ox, oy, w, h, cell, elevAt, biomeAt, stale);
    if (!f) return null;
    return { elev: f.elev, bio: f.bio, land: landM, lake: lakeM, barrier: barM };
  }

  /** Coarse boundary ring for one box: lets off-box seeds compete without
   *  unioning them into the box (same cost×km units). */
  function buildInjection(
    ox: number,
    oy: number,
    w: number,
    h: number,
    cell: number,
    geo: string,
  ): { i: number; dist: number; owner: number }[] | undefined {
    if (!coarse || coarseTag !== geo) return undefined;
    const initial: { i: number; dist: number; owner: number }[] = [];
    const RING = 2;
    const use = coarse;
    const probe = (fx: number, fy: number) => {
      const cx = Math.max(0, Math.min(dataW - 1, Math.floor(ox + (fx + 0.5) * cell)));
      const cy = Math.max(0, Math.min(dataH - 1, Math.floor(oy + (fy + 0.5) * cell)));
      const ci = cy * dataW + cx;
      const o = use.owner[ci];
      if (o >= 0 && o < nodes.length) initial.push({ i: fy * w + fx, dist: use.dist[ci], owner: o });
    };
    for (let x = 0; x < w; x++) {
      for (let r = 0; r < RING; r++) {
        probe(x, r);
        probe(x, h - 1 - r);
      }
    }
    for (let y = RING; y < h - RING; y++) {
      for (let r = 0; r < RING; r++) {
        probe(r, y);
        probe(w - 1 - r, y);
      }
    }
    return initial;
  }

  async function recomputeSprawl() {
    if (!ready || disposed) return;
    if (nodes.length === 0) {
      clearSprawlVisuals();
      sprawlStat = '';
      lastFineTag = null;
      lastFineBoxKey = null;
      lastFineGeo = null;
      return;
    }
    // keep the old overlay visible while computing — swap on ready, no flicker
    sprawlStat = 'computing coarse…';
    const gen = ++sprawlGen;
    const stale = () => gen !== sprawlGen || disposed;
    const geo = geoTag();
    const budget = sprawlLevel * 5;

    // 1) global competition (fast exit when fresh — never view-driven)
    if (!coarse || coarseTag !== geo) {
      const ok = await ensureCoarse(geo, stale);
      if (stale()) return;
      if (!ok) {
        // no land data / seeds off land: drop the stale overlay, say so
        if (!coarse || coarseTag !== geo) clearSprawlVisuals();
        sprawlStat = seedlessTag === geo ? 'nodes off land…' : sprawlStat;
        return;
      }
    }
    sprawlStat = 'computing…';

    // 2) viewport box at native display resolution, snapped to the cell grid
    const plan = planFineBox();
    if (!plan || stale()) return;
    const { boxKey, ftag } = fineTagFor(plan);
    if (ftag === lastFineTag && lastSprawl && lastSim) {
      paintSprawlBorders();
      paintFog();
      updateSprawlStat();
      return;
    }

    // 3) budget-grow fast path (#5): same box + geo, larger budget — resume
    // the retained frontier instead of re-settling the interior
    if (
      lastFineTag && lastFineGeo === geo && lastFineBoxKey === boxKey &&
      lastSprawl && lastSim && budget > lastFineBudget && coarse && coarseTag === geo
    ) {
      const g = await engine().grow(lastFineTag, ftag, budget);
      if (stale()) return;
      if (g.ok) {
        applyFine(g, lastSim, budget, ftag, boxKey, geo);
        return;
      }
      // 'resync'/superseded worker state → fall through to a full solve
    }

    const { bx0, by0, w, h, cell } = plan;

    // fast path: the fine box IS the full map at cell 1 — paint coarse directly
    if (cell === 1 && bx0 === 0 && by0 === 0 && w === dataW && h === dataH && coarse && coarseTag === geo) {
      // descriptor only: paint reads dims + origin + scale, never costs
      lastSim = { w: dataW, h: dataH, cost: new Float32Array(0), blocked: new Uint8Array(0), ox: 0, oy: 0, cell: 1 };
      lastSprawl = coarse;
      applyFineTags(ftag, boxKey, budget, geo);
      paintSprawlOverlay();
      updateSprawlStat();
      return;
    }

    // costs: memory LRU or fresh fields (sampling + vector masks, main thread).
    // Sea, lakes and big rivers stay unpainted, exactly as drawn.
    // (Before vectors load we fall back to the elev/biome rule, then re-sim.)
    const dtag = dataTag();
    const ck = costKey(bx0, by0, w, h, cell, dtag);
    let costs = costMemGet(ck);
    let fields: FineFields | null = null;
    if (!costs) {
      const f = await buildFineFields(bx0, by0, w, h, cell, stale);
      if (!f || stale()) return;
      fields = f;
    }
    // inside seeds compete from 0; outside seeds arrive through the coarse
    // boundary ring (same cost×km units), so the box stays viewport-sized
    const initial = buildInjection(bx0, by0, w, h, cell, geo);

    // preview-then-refine: a cell×2 preview paints in ~1s so deep zoom never
    // sits on stretched coarse blocks, then the native solve swaps in.
    // The preview sets no tags (budget grows only ever resume full solves).
    if (cell < 1 && w * h > 800000) {
      const pc = cell * 2;
      const pox = Math.floor(bx0 / pc) * pc;
      const poy = Math.floor(by0 / pc) * pc;
      const pw = Math.max(1, Math.ceil((bx0 + w * cell - pox) / pc));
      const ph = Math.max(1, Math.ceil((by0 + h * cell - poy) / pc));
      const pf = await buildFineFields(pox, poy, pw, ph, pc, stale);
      if (stale()) return;
      if (pf) {
        const pr = await engine().solve({
          tag: `${ftag}:preview`,
          scope: 'fine',
          box: { ox: pox, oy: poy, w: pw, h: ph, cell: pc },
          seedsE0: nodes.map((n) => ({ x: n.dx, y: n.dy })),
          budget,
          capital: capitalIndex(),
          initial: buildInjection(pox, poy, pw, ph, pc, geo),
          payload: { fields: pf },
          wantDist: false,
        });
        if (stale()) return;
        if (pr.ok) {
          lastSim = { w: pw, h: ph, cost: new Float32Array(0), blocked: new Uint8Array(0), ox: pox, oy: poy, cell: pc };
          lastSprawl = {
            owner: pr.owner!,
            dist: new Float32Array(0),
            counts: pr.counts!,
            centroids: pr.centroids!,
            contours: pr.contours ?? [],
          };
          paintSprawlOverlay();
          sprawlStat = 'refining…';
        }
      }
      if (stale()) return;
    }

    const res = await engine().solve({
      tag: ftag,
      scope: 'fine',
      box: { ox: bx0, oy: by0, w, h, cell },
      seedsE0: nodes.map((n) => ({ x: n.dx, y: n.dy })),
      budget,
      capital: capitalIndex(),
      initial,
      payload: costs
        ? { costs: { cost: costs.cost, blocked: costs.blocked } }
        : { fields: fields! },
      wantDist: false,
      wantCosts: !costs,
    });
    if (!res.ok || stale()) return;
    if (res.costs && !costs) {
      costMemSet(ck, { w, h, cost: res.costs.cost, blocked: res.costs.blocked, ox: bx0, oy: by0, cell });
    }
    lastSim = { w, h, cost: new Float32Array(0), blocked: new Uint8Array(0), ox: bx0, oy: by0, cell };
    applyFine(res, lastSim, budget, ftag, boxKey, geo);
  }

  function applyFineTags(ftag: string, boxKey: string, budget: number, geo: string) {
    lastFineTag = ftag;
    lastFineBoxKey = boxKey;
    lastFineBudget = budget;
    lastFineGeo = geo;
  }

  function applyFine(res: SolveResult, sim: SimGrid, budget: number, ftag: string, boxKey: string, geo: string) {
    lastSprawl = {
      owner: res.owner!,
      dist: res.dist ?? lastSprawl?.dist ?? new Float32Array(0),
      counts: res.counts!,
      centroids: res.centroids!,
      contours: res.contours ?? [],
    };
    applyFineTags(ftag, boxKey, budget, geo);
    paintSprawlOverlay();
    updateSprawlStat(res.ms);
  }

  /** Budget-aware global stats from the coarse max-budget solve: Dijkstra
   *  distances don't depend on budget, so filtering dist <= budget gives the
   *  exact claimed set for any slider position. O(map) scan, no re-solve. */
  function budgetBreakdown(): { counts: number[]; centroids: { x: number; y: number }[] } {
    const counts = new Array(nodes.length).fill(0);
    const sx = new Array(nodes.length).fill(0);
    const sy = new Array(nodes.length).fill(0);
    if (coarse && coarseTag === geoTag()) {
      const budget = sprawlLevel * 5;
      const o = coarse.owner;
      const dd = coarse.dist;
      for (let i = 0; i < o.length; i++) {
        const k = o[i];
        if (k >= 0 && k < nodes.length && dd[i] <= budget) {
          counts[k]++;
          sx[k] += i % dataW;
          sy[k] += (i / dataW) | 0;
        }
      }
    }
    const centroids = nodes.map((_, k) =>
      counts[k] > 0 ? { x: sx[k] / counts[k], y: sy[k] / counts[k] } : { x: -1, y: -1 },
    );
    return { counts, centroids };
  }

  function updateSprawlStat(ms?: number) {
    if (nodes.length === 0) {
      sprawlStat = '';
      return;
    }
    const { counts } = budgetBreakdown();
    const cells = counts.reduce((a, b) => a + b, 0);
    const latMid = (REGION.latMax + REGION.latMin) / 2;
    const kx0 = ((LON_SPAN / dataW) * 111.32 * Math.cos((latMid * Math.PI) / 180));
    const ky0 = ((LAT_SPAN / dataH) * 110.57);
    const km2 = Math.round(cells * kx0 * ky0);
    const timed = ms != null && ms > 0 ? ` · ${(ms / 1000).toFixed(1)}s` : '';
    sprawlStat = `${cells.toLocaleString('en-US')} px ≈ ${km2.toLocaleString('en-US')} km² across ${nodes.length} node${nodes.length > 1 ? 's' : ''}${timed}`;
    if (selectedId != null) void refreshSelected();
  }

  /** Game-logic queries (#6): authoritative snapshots in the engine. Hover
   *  uses the sync coarse copy below (no round-trip at 60Hz). */
  function queryTerritory(nodeIdx: number): Promise<QueryResult> {
    return engine().query({ q: 'hood', node: nodeIdx });
  }

  function queryOwnerAt(lon: number, lat: number): Promise<QueryResult> {
    return engine().query({ q: 'ownerAt', lon, lat });
  }

  /** Sync owner readout from the local coarse snapshot (E0 precision),
   *  filtered to the live budget frontier (no phantom claims past it). */
  function coarseOwnerAt(lon: number, lat: number): number {
    if (!coarse) return -1;
    const ix = Math.floor(((lon - REGION.lonMin) / LON_SPAN) * dataW);
    const iy = Math.floor(((REGION.latMax - lat) / LAT_SPAN) * dataH);
    if (ix < 0 || iy < 0 || ix >= dataW || iy >= dataH) return -1;
    const i = iy * dataW + ix;
    if (coarse.dist[i] > sprawlLevel * 5) return -1;
    return coarse.owner[i];
  }

  function clearSprawlVisuals() {
    lastSprawl = null;
    lastSim = null;
    lastFineTag = null;
    lastFineBoxKey = null;
    lastFineGeo = null;
    selectedInfo = null;
    if (sprawlSprite) {
      sprawlSprite.visible = false;
      if (sprawlSprite.texture !== PIXI.Texture.EMPTY) sprawlSprite.texture.destroy(true);
      sprawlSprite.texture = PIXI.Texture.EMPTY;
    }
    if (fogSprite) {
      fogSprite.visible = false;
      if (fogSprite.texture !== PIXI.Texture.EMPTY) fogSprite.texture.destroy(true);
      fogSprite.texture = PIXI.Texture.EMPTY;
    }
    borderGfx?.clear();
    centroidGfx?.clear();
  }

  /** Stroke smooth vector borders at constant screen width. Re-run on zoom
   *  settle — geometry is zoom-independent, only the width changes. */
  function paintSprawlBorders() {
    if (!borderGfx || !world || disposed) return;
    borderGfx.clear();
    lastBorderScale = world.scale.x;
    const paths = lastSprawl?.contours;
    if (!paths || paths.length === 0) return;
    for (const p of paths) {
      if (p.length < 4) continue;
      borderGfx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) borderGfx.lineTo(p[i], p[i + 1]);
    }
    borderGfx.stroke({ width: 1.3 / world.scale.x, color: 0xffffff, alpha: 0.5 });
  }

  /** Fog-of-war data layer: darken everything beyond scout reach of any node.
   *  Built from the coarse distances (no re-solve), full-map sprite. */
  function paintFog() {
    if (!fogSprite || !world || disposed) return;
    if (!showFog || !coarse || coarseTag !== geoTag()) {
      fogSprite.visible = false;
      return;
    }
    const o = coarse.owner;
    const dd = coarse.dist;
    const canvas = document.createElement('canvas');
    canvas.width = dataW;
    canvas.height = dataH;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(dataW, dataH);
    const buf = new Uint32Array(img.data.buffer);
    const FOG = (165 << 24) | (10 << 16) | (6 << 8) | 2; // deep-night veil
    for (let i = 0; i < o.length; i++) {
      if (o[i] < 0 || dd[i] > FOG_RANGE) buf[i] = FOG;
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(canvas);
    tex.source.scaleMode = 'linear';
    tex.source.autoGenerateMipmaps = false;
    if (fogSprite.texture !== PIXI.Texture.EMPTY) fogSprite.texture.destroy(true);
    fogSprite.texture = tex;
    fogSprite.position.set(0, 0);
    fogSprite.scale.set(1, 1);
    fogSprite.visible = true;
  }

  function paintSprawlOverlay() {
    if (!lastSprawl || !lastSim || !world || !sprawlLayer || disposed) return;
    const sim = lastSim;
    const [r, g, b] = hexRgb(sprawlColor);
    // flat raster fill — vector contours carry the borders (crisp at any zoom)
    const canvas = paintSprawl(lastSprawl, sim.w, sim.h, r, g, b, sprawlAlpha / 100, false);
    const tex = PIXI.Texture.from(canvas);
    tex.source.scaleMode = 'nearest';
    tex.source.autoGenerateMipmaps = false;
    if (!sprawlSprite) {
      sprawlSprite = new PIXI.Sprite(tex);
      sprawlLayer.addChildAt(sprawlSprite, 0);
    } else {
      if (sprawlSprite.texture !== PIXI.Texture.EMPTY) sprawlSprite.texture.destroy(true);
      sprawlSprite.texture = tex;
    }
    // box-anchored: 1 canvas px = sim.cell world units at (ox, oy)
    sprawlSprite.position.set(sim.ox, sim.oy);
    sprawlSprite.scale.set(sim.cell, sim.cell);
    sprawlSprite.visible = true;
    paintSprawlBorders();
    paintFog();
    // seeds (small 6px rings, gold for the capital) + centroids (toggleable)
    centroidGfx?.clear();
    const cg = centroidGfx!;
    const { centroids } = budgetBreakdown();
    const capIdx = capitalIndex();
    nodes.forEach((n, k) => {
      const isCap = k === capIdx;
      cg.circle(n.dx, n.dy, 3);
      cg.stroke({ width: 2 / world!.scale.x, color: isCap ? 0xffd700 : 0xffffff });
      cg.circle(n.dx, n.dy, 1.5);
      cg.fill({ color: isCap ? 0xffd700 : 0xffffff });
      if (!showCentroids) return;
      const c = centroids[k];
      if (!c || c.x < 0) return;
      cg.circle(c.x, c.y, 4);
      cg.fill({ color: 0xfbbf24 });
    });
  }

  function addNodeAt(dx: number, dy: number) {
    const { lon, lat } = lonLatOf(dx, dy);
    const id = nodeSeq++;
    nodes = [...nodes, { id, dx, dy, lon, lat }];
    if (capitalId == null) capitalId = id; // first node founds the capital
    scheduleSprawl();
  }

  function removeNode(id: number) {
    nodes = nodes.filter((n) => n.id !== id);
    if (capitalId === id) capitalId = nodes.length > 0 ? nodes[0].id : null;
    if (selectedId === id) {
      selectedId = null;
      selectedInfo = null;
    }
    scheduleSprawl();
  }

  function setCapital(id: number) {
    if (capitalId === id) return;
    capitalId = id;
    scheduleSprawl(); // capital head start reshapes ownership
  }

  function selectNode(id: number | null) {
    selectedId = id;
    selectedInfo = null;
    if (id != null) void refreshSelected();
  }

  /** Selected-territory inspect (#6 in action): worker hood (neighbors +
   *  shared borders) + local supply scan over the coarse snapshot. */
  async function refreshSelected() {
    const id = selectedId;
    if (id == null || disposed) return;
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx < 0 || !coarse || coarseTag !== geoTag()) {
      selectedInfo = null;
      return;
    }
    const snap = { coarse, idx, budget: sprawlLevel * 5 };
    let hood: QueryResult;
    try {
      hood = await engine().query({ q: 'hood', node: idx });
    } catch {
      return;
    }
    if (selectedId !== id || disposed || !coarse || coarseTag !== geoTag()) return;
    if (!hood.ok) {
      selectedInfo = null;
      return;
    }
    const perKm2 = e0CellKm2();
    const cells = hood.cells ?? 0;
    // supply: claimed cells within SUPPLY_RANGE of the node (min-dist approx)
    const o = snap.coarse.owner;
    const dd = snap.coarse.dist;
    let supplied = 0;
    for (let i = 0; i < o.length; i++) {
      if (o[i] === idx && dd[i] <= SUPPLY_RANGE) supplied++;
    }
    const sharedTotal = (hood.neighbors ?? []).reduce((a, b) => a + b.shared, 0) || 1;
    selectedInfo = {
      cells,
      km2: Math.round(cells * perKm2),
      supply: cells > 0 ? Math.round((supplied / cells) * 100) : 0,
      neighbors: (hood.neighbors ?? []).map((nb) => ({
        id: nodes[nb.node]?.id ?? -1,
        sharedKm2: Math.round(nb.shared * perKm2),
        share: Math.round((nb.shared / sharedTotal) * 100),
      })),
    };
  }

  function togglePlacing() {
    placing = !placing;
    if (canvasElRef) canvasElRef.style.cursor = placing ? 'crosshair' : 'grab';
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && placing) togglePlacing();
  }
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
      maybeResrawlView(); // settled view: re-solve only if the box moved
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
    maybeResrawlView(); // settled view: re-solve only if the box moved
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
    if (mode === 'biome' && biomeBase) attachBase(biomeBase);
    else if (baseCanvas && mode === 'terrain') attachBase(baseCanvas);
    clearPaintedCache();
    refreshAllTiles();
    status = mode === 'biome' ? 'Biomes live — hover for names' : 'Japan live — zoom in, detail streams';
  }

  function attachBase(canvas: HTMLCanvasElement) {
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
        scheduleSprawl(); // big-river barriers may have arrived
      });
      // biome IDs power settlement costs — decode early (tiny local file)
      ensureBiomeGrid().then(() => {
        if (disposed) return;
        scheduleSprawl();
      });
      const hydroArrived = () => {
        if (disposed) return;
        applyLakesToBase();
        scheduleDataRefresh(); // repaint pre-mask tiles with true coasts
        scheduleSprawl(); // vectors arrived → territories snap onto true land
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
      window.addEventListener('keydown', onKeyDown);
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
      sprawlLayer = new PIXI.Container();
      world.addChild(sprawlLayer); // settlement territories above rivers
      borderGfx = new PIXI.Graphics();
      sprawlLayer.addChild(borderGfx); // smooth vector borders above the fill
      fogSprite = new PIXI.Sprite();
      fogSprite.visible = false;
      world.addChild(fogSprite); // fog-of-war veil over map + territories
      centroidGfx = new PIXI.Graphics();
      world.addChild(centroidGfx); // markers stay visible above the fog
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
        attachBase(s2); // focus-pull reveal covers the transition
        pixelCount = `Japan E0 ${dataW}×${dataH} · virtual up to ${virtualSize(maxLevel)}`;
        progress = 1;
        ready = true;
        status = r.masked
          ? 'Japan live — zoom in, detail streams'
          : 'Japan live — coasts approximate (mask offline)';
        updateTiles();
        scheduleSprawl(); // pick up any nodes placed during load
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
        attachBase(canvas);
        pixelCount = `Japan E0 ${dataW}×${dataH} · offline outline`;
        ready = true;
        status = 'Offline outline (no terrain)';
        updateTiles();
        redrawRivers(); // overlay still works: rivers need no terrain
      }

      // --- pan (+ settlement placement intercepts first) ---
      canvasEl.addEventListener('pointerdown', (e) => {
        if (placing && pointers.size === 0) {
          const hit = screenToData(e.clientX, e.clientY);
          if (hit) addNodeAt(hit.dx, hit.dy);
          placing = false;
          canvasEl.style.cursor = 'grab';
          return;
        }
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
        // sync territory readout from the local coarse snapshot (#6, no round-trip)
        let terrTxt = '';
        if (nodes.length > 0) {
          const to = coarseOwnerAt(lon, lat);
          if (to >= 0 && to < nodes.length) terrTxt = ` · #${
            nodes[to].id
          } territory`;
        }
        hoverInfo = `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}${elevTxt}${terrTxt}`;
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
      sprawlGen++;
      if (tilesTimer) clearTimeout(tilesTimer);
      if (dataRefreshTimer) clearTimeout(dataRefreshTimer);
      if (sprawlTimer) clearTimeout(sprawlTimer);
      transport?.shutdown();
      transport = null;
      window.removeEventListener('keydown', onKeyDown);
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

  <!-- settlement panel -->
  <div class="pointer-events-none absolute right-4 top-4 z-10 w-64">
    {#if rCollapsed}
      <button
        onclick={() => (rCollapsed = false)}
        class="pointer-events-auto ml-auto block rounded-xl border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-gray-200 shadow-2xl backdrop-blur-md hover:bg-white/10"
        title="Open settlement panel"
      >
        🏯 settle
      </button>
    {:else}
    <div class="pointer-events-auto rounded-2xl border border-white/10 bg-black/60 p-4 shadow-2xl backdrop-blur-md">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-bold tracking-widest text-white uppercase">Settlement</h2>
        <button
          onclick={() => (rCollapsed = true)}
          class="ml-auto rounded-md px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:bg-white/10 hover:text-white"
          title="Collapse panel"
        >
          ✕
        </button>
      </div>

      <button
        onclick={togglePlacing}
        class="mt-3 w-full rounded-lg px-2.5 py-2 font-mono text-[11px] transition
          {placing ? 'bg-amber-300 font-bold text-black' : 'bg-white/10 text-gray-200 hover:bg-white/20'}"
      >
        {placing ? 'Click map to place… (Esc cancels)' : '⊕ Place settlement node'}
      </button>

      <label class="mt-3 block font-mono text-[11px] text-gray-300">
        Sprawl level: <span class="font-bold text-white">{sprawlLevel}</span>
        <input
          type="range" min="0" max="100" step="1" bind:value={sprawlLevel} oninput={scheduleSprawl}
          class="mt-1 w-full accent-emerald-400"
        />
      </label>

      <div class="mt-2 flex items-center gap-2">
        <label class="font-mono text-[11px] text-gray-300">Area</label>
        <input type="color" bind:value={sprawlColor} oninput={paintSprawlOverlay} class="h-7 w-10 cursor-pointer rounded bg-transparent" />
        <input type="range" min="5" max="90" step="1" bind:value={sprawlAlpha} oninput={paintSprawlOverlay} class="w-full accent-emerald-400" title="Opacity" />
        <span class="font-mono text-[11px] text-gray-300">{sprawlAlpha}%</span>
      </div>

      <label class="mt-2 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-gray-300">
        <input type="checkbox" bind:checked={showCentroids} oninput={paintSprawlOverlay} class="accent-amber-300" />
        Centroids
      </label>

      <label class="mt-1 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-gray-300" title="Darken everything beyond scout reach">
        <input type="checkbox" bind:checked={showFog} oninput={paintFog} class="accent-indigo-400" />
        Fog of war
      </label>

      {#if nodes.length > 0}
        <div class="mt-2 max-h-28 overflow-y-auto pr-1">
          {#each nodes as n}
            <div class="flex items-center gap-1.5 py-px font-mono text-[11px] text-gray-300">
              <button
                onclick={() => setCapital(n.id)}
                class="{capitalId === n.id ? 'text-amber-300' : 'text-gray-600 hover:text-amber-200'}"
                title={capitalId === n.id ? 'Capital (+reach)' : 'Make capital (+reach)'}
              >★</button>
              <button
                onclick={() => selectNode(selectedId === n.id ? null : n.id)}
                class="font-bold {selectedId === n.id ? 'text-sky-300' : 'text-white'} hover:text-sky-200"
                title="Inspect territory"
              >#{n.id}</button>
              <span>{Math.abs(n.lat).toFixed(2)}°{n.lat >= 0 ? 'N' : 'S'} {Math.abs(n.lon).toFixed(2)}°{n.lon >= 0 ? 'E' : 'W'}</span>
              <button onclick={() => removeNode(n.id)} class="ml-auto text-gray-500 hover:text-red-300" title="Remove node">✕</button>
            </div>
          {/each}
        </div>
        {#if selectedInfo}
          <div class="mt-1 rounded-lg bg-white/5 px-2 py-1.5 font-mono text-[11px] text-gray-300">
            <div class="flex items-center gap-1.5">
              <span class="font-bold text-white">Territory #{selectedId}</span>
              <span class="text-emerald-200/90">{selectedInfo.cells.toLocaleString('en-US')} px · {selectedInfo.km2.toLocaleString('en-US')} km²</span>
              <button onclick={() => selectNode(null)} class="ml-auto text-gray-500 hover:text-white" title="Close">✕</button>
            </div>
            <div class="mt-0.5 text-sky-200/90">Supply {selectedInfo.supply}% in range</div>
            {#if selectedInfo.neighbors.length > 0}
              <div class="mt-0.5 text-gray-400">Borders:</div>
              {#each selectedInfo.neighbors as nb}
                <div class="flex justify-between text-gray-300">
                  <span>#{nb.id}</span>
                  <span>{nb.sharedKm2.toLocaleString('en-US')} km² · {nb.share}%</span>
                </div>
              {/each}
            {:else}
              <div class="mt-0.5 text-gray-500">No land borders.</div>
            {/if}
          </div>
        {/if}
        <button
          onclick={() => { nodes = []; capitalId = null; selectedId = null; selectedInfo = null; scheduleSprawl(); }}
          class="mt-1 rounded-lg bg-white/10 px-2.5 py-1 font-mono text-[11px] text-gray-300 hover:bg-white/20"
        >
          Clear all
        </button>
      {:else}
        <p class="mt-2 font-mono text-[11px] text-gray-500">No nodes yet — place one to seed a territory.</p>
      {/if}

      {#if sprawlStat}<p class="mt-1 font-mono text-[11px] text-emerald-200/90">{sprawlStat}</p>{/if}
      <p class="mt-1 text-[10px] leading-snug text-gray-500">
        Voronoi growth on cost terrain: sea, lakes and big rivers block,
        snow/peaks/deserts costly, fields and settled land cheap. ★ capital
        reaches further. Click #id to inspect.
      </p>
    </div>
    {/if}
  </div>

  <div class="pointer-events-none absolute bottom-4 right-4 z-10">
    <div class="rounded-xl border border-white/10 bg-black/60 px-3 py-2 font-mono text-[11px] text-gray-300 backdrop-blur-md">
      tiled LOD · unload off-screen · IDB cache
    </div>
  </div>
</div>
