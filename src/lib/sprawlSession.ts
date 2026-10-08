// Settlement solve session (suggestion #2 + #5 + #6).
// DOM-free engine behind the Worker: owns computation + retains snapshots for
// game-logic queries. Also used directly on the main thread when Workers are
// unavailable (same code path, same results).

import {
  buildCosts,
  computeSprawl,
  resumeSprawl,
  nearestLand,
  CAPITAL_BONUS,
  type SimGrid,
} from './settlement';
import { REGION, LON_SPAN, LAT_SPAN, regionSize } from './region';

export interface SolveFields {
  elev: Float32Array;
  bio: Int16Array;
  land: Uint8Array | null;
  lake: Uint8Array | null;
  barrier: Uint8Array | null;
  ford: Float32Array | null;
}

export interface SolveCosts {
  cost: Float32Array;
  blocked: Uint8Array;
}

export interface SolveJob {
  /** freshness tag chosen by the caller (nodes + budget + data inputs) */
  tag: string;
  scope: 'coarse' | 'fine';
  box: { ox: number; oy: number; w: number; h: number; cell: number };
  /** seed positions in E0 px (snapped to land inside) */
  seedsE0: { x: number; y: number }[];
  budget: number;
  /** seed index designated capital: starts at -CAPITAL_BONUS (reaches further) */
  capital?: number;
  initial?: { i: number; dist: number; owner: number }[];
  payload: { fields: SolveFields } | { costs: SolveCosts };
  wantDist: boolean;
  /** echo cost tables back (first build → caller persists them to cache) */
  wantCosts?: boolean;
}

export interface SolveResult {
  ok: boolean;
  reason?: 'seedless' | 'stale' | 'bad-input';
  tag?: string;
  /** reply routing key (grow echoes the prev tag it resumed from) */
  key?: string;
  owner?: Int32Array;
  dist?: Float32Array;
  counts?: number[];
  centroids?: { x: number; y: number }[];
  contours?: Float32Array[];
  seedCount?: number;
  costs?: { cost: Float32Array; blocked: Uint8Array };
  ms?: number;
}

export type SprawlQuery =
  | { q: 'ownerAt'; lon: number; lat: number }
  | { q: 'hood'; node: number };

export interface QueryResult {
  ok: boolean;
  owner?: number;
  cells?: number;
  neighbors?: { node: number; shared: number }[];
}

export class SprawlSession {
  private coarse: { owner: Int32Array; dist: Float32Array; tag: string } | null = null;
  private fine: {
    sim: SimGrid;
    dist: Float32Array;
    owner: Int32Array;
    budget: number;
    tag: string;
    seedCount: number;
  } | null = null;

  async solve(job: SolveJob, isStale?: () => boolean): Promise<SolveResult> {
    const t0 = performance.now();
    const { ox, oy, w, h, cell } = job.box;
    const n = w * h;
    let sim: SimGrid | null = null;
    if ('fields' in job.payload) {
      const f = job.payload.fields;
      if (f.elev.length !== n || f.bio.length !== n) return { ok: false, reason: 'bad-input' };
      const ford = f.ford && f.ford.length === n ? f.ford : null;
      sim = buildCosts(ox, oy, w, h, cell, f.elev, f.bio, ford, {
        land: f.land,
        lake: f.lake,
        barrier: f.barrier,
      });
    } else {
      const c = job.payload.costs;
      if (c.cost.length !== n || c.blocked.length !== n) return { ok: false, reason: 'bad-input' };
      sim = { w, h, cost: c.cost, blocked: c.blocked, ox, oy, cell };
    }
    if (!sim || isStale?.()) return { ok: false, reason: 'stale' };
    const snapR = job.scope === 'coarse' ? 24 : Math.max(24, Math.min(64, Math.ceil(8 / cell)));
    const seeds = job.seedsE0.map((s) => {
      const gx = (s.x - ox) / cell;
      const gy = (s.y - oy) / cell;
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) return -1;
      return nearestLand(sim!, gx, gy, snapR);
    });
    if (seeds.every((s) => s < 0)) return { ok: false, reason: 'seedless' };
    // capital head start: the designated seed begins below zero distance
    let initial = job.initial;
    if (job.capital != null && job.capital >= 0 && job.capital < seeds.length && seeds[job.capital] >= 0) {
      initial = [...(initial ?? []), { i: seeds[job.capital], dist: -CAPITAL_BONUS, owner: job.capital }];
    }
    const res = await computeSprawl(sim, seeds, job.budget, isStale, initial);
    if (!res || isStale?.()) return { ok: false, reason: 'stale' };
    if (job.scope === 'coarse') {
      this.coarse = { owner: res.owner, dist: res.dist, tag: job.tag };
      this.fine = null; // global truth moved: drop dependent fine state
    } else {
      this.fine = {
        sim,
        dist: res.dist,
        owner: res.owner,
        budget: job.budget,
        tag: job.tag,
        seedCount: seeds.length,
      };
    }
    return {
      ok: true,
      tag: job.tag,
      owner: res.owner,
      dist: job.wantDist ? res.dist : undefined,
      counts: res.counts,
      centroids: res.centroids,
      contours: res.contours,
      seedCount: seeds.length,
      costs: job.wantCosts ? { cost: sim.cost, blocked: sim.blocked } : undefined,
      ms: Math.round(performance.now() - t0),
    };
  }

  /** Budget-only growth on the retained fine solution (suggestion #5).
   *  prevTag must match the retained solve; the retention is re-tagged to
   *  newTag on success so consecutive drags keep resuming. */
  async grow(
    prevTag: string,
    newTag: string,
    newBudget: number,
    isStale?: () => boolean,
  ): Promise<SolveResult> {
    const f = this.fine;
    if (!f || f.tag !== prevTag || !(newBudget > f.budget)) return { ok: false, reason: 'stale' };
    const t0 = performance.now();
    const res = await resumeSprawl(f.sim, f.dist, f.owner, f.seedCount, f.budget, newBudget, isStale);
    if (!res || isStale?.()) return { ok: false, reason: 'stale' };
    f.dist = res.dist;
    f.owner = res.owner;
    f.budget = newBudget;
    f.tag = newTag;
    return {
      ok: true,
      tag: newTag,
      key: prevTag,
      owner: res.owner,
      counts: res.counts,
      centroids: res.centroids,
      contours: res.contours,
      seedCount: f.seedCount,
      ms: Math.round(performance.now() - t0),
    };
  }

  /** Game-logic queries over the retained coarse snapshot (suggestion #6). */
  query(q: SprawlQuery): QueryResult {
    const c = this.coarse;
    if (!c) return { ok: false };
    const { w: e0w, h: e0h } = regionSize(0);
    if (q.q === 'ownerAt') {
      const ix = Math.floor(((q.lon - REGION.lonMin) / LON_SPAN) * e0w);
      const iy = Math.floor(((REGION.latMax - q.lat) / LAT_SPAN) * e0h);
      if (ix < 0 || iy < 0 || ix >= e0w || iy >= e0h) return { ok: true, owner: -1 };
      return { ok: true, owner: c.owner[iy * e0w + ix] };
    }
    // hood: cells, 4-neighbor owners, shared border lengths (in cells)
    const shared = new Map<number, number>();
    let cells = 0;
    for (let y = 0; y < e0h; y++) {
      for (let x = 0; x < e0w; x++) {
        const i = y * e0w + x;
        if (c.owner[i] !== q.node) continue;
        cells++;
        if (x > 0 && c.owner[i - 1] >= 0 && c.owner[i - 1] !== q.node)
          shared.set(c.owner[i - 1], (shared.get(c.owner[i - 1]) ?? 0) + 1);
        if (x < e0w - 1 && c.owner[i + 1] >= 0 && c.owner[i + 1] !== q.node)
          shared.set(c.owner[i + 1], (shared.get(c.owner[i + 1]) ?? 0) + 1);
        if (y > 0 && c.owner[i - e0w] >= 0 && c.owner[i - e0w] !== q.node)
          shared.set(c.owner[i - e0w], (shared.get(c.owner[i - e0w]) ?? 0) + 1);
        if (y < e0h - 1 && c.owner[i + e0w] >= 0 && c.owner[i + e0w] !== q.node)
          shared.set(c.owner[i + e0w], (shared.get(c.owner[i + e0w]) ?? 0) + 1);
      }
    }
    return {
      ok: true,
      cells,
      neighbors: [...shared.entries()]
        .map(([node, sh]) => ({ node, shared: sh }))
        .sort((a, b) => b.shared - a.shared),
    };
  }
}
