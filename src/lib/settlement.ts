// Settlement sprawl: cost-driven territorial growth (multi-source Dijkstra =
// a weighted Voronoi diagram — each cell joins its cheapest settlement).
// Two-tier at runtime (see WorldMap): a coarse full-map solve picks global
// winners, a fine viewport solve paints 1:1. Heavy solves run in a Worker
// (sprawl.worker.ts); this module stays DOM-free so the worker can import it.
// Pipeline stages are split for caching: sampleFields (node-independent
// sampling, main thread) → buildCosts (worker) → computeSprawl (worker).

import { biomeInfo } from './tileEngine';
import { REGION, LON_SPAN, LAT_SPAN, regionSize } from './region';

export const SIM_W = 1280;
export const SIM_H = 1024;

/** Cost-table version: bump when the formula below changes (caches key on it). */
export const COST_VERSION = 5;

/** Capital head start in cost×km (≈ +50 km reach): the capital seed begins
 *  below zero, so it alone expands further on the same budget. */
export const CAPITAL_BONUS = 75;

/** Gentle ford cost along drawn rivers (minor streams bend growth slightly;
 *  big rivers additionally barrier via the mask). */
export const RIVER_FORD_COST = 1.5;

export interface SimGrid {
  w: number;
  h: number;
  cost: Float32Array;
  blocked: Uint8Array;
  ox: number; // box origin in E0 px
  oy: number;
  cell: number; // E0 px per sim cell
}

export interface CostFields {
  elev: Float32Array; // NaN where the sampler had no data
  bio: Int16Array; // biome id, -1 where unknown
}

export type RiverGeom = { lines: Float32Array[]; bbox: [number, number, number, number] }[] | null;

/** Per-biome expansion cost from legend name + components. */
export function costOfBiome(id: number): number {
  if (id === 0) return Infinity; // water
  const info = biomeInfo(id);
  const t = `${info.name} ${info.comp.join(' ')}`.toLowerCase();
  // open water never settles (rivers are costly but fordable — see below)
  if (/\b(ocean|sea|lake|pond|moat)\b/.test(t)) return Infinity;
  let c = 2;
  if (/\briver\b/.test(t)) c += 4;
  if (/snow|frozen|ice|glacier|tundra|alpine/.test(t)) c += 3;
  if (/mountain|volcan|cliff|canyon/.test(t)) c += 2.5;
  if (/jungle|dense|bamboo/.test(t)) c += 1.5;
  if (/desert|badlands|wasteland|rocky|barren/.test(t)) c += 1.5;
  if (/swamp|marsh|wetland|mangrove|bog/.test(t)) c += 1.5;
  if (/forest|woods|grove/.test(t)) c += 0.75;
  if (/beach|sand|dune|shore/.test(t)) c += 0.5;
  if (/plains|field|meadow|grass|farm|paddy|village|town|city|urban|garden/.test(t)) c -= 1;
  return Math.max(0.75, Math.min(9, c));
}

/** Pass 1 (node-independent): sample raw elevation + biome fields. Main thread. */
export async function sampleFields(
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  elevAt: (lon: number, lat: number) => number | null,
  biomeAt: (lon: number, lat: number) => number | null,
  isStale?: () => boolean,
): Promise<CostFields | null> {
  const { w: e0w, h: e0h } = regionSize(0);
  const lonOf = (x: number) => REGION.lonMin + ((x0 + (x + 0.5) * cell) / e0w) * LON_SPAN;
  const latOf = (y: number) => REGION.latMax - ((y0 + (y + 0.5) * cell) / e0h) * LAT_SPAN;
  const n = w * h;
  const elev = new Float32Array(n);
  const bio = new Int16Array(n);
  const BAND = 128;
  for (let yy = 0; yy < h; yy += BAND) {
    if (isStale?.()) return null;
    for (let y = yy; y < Math.min(h, yy + BAND); y++) {
      const la = latOf(y);
      for (let x = 0; x < w; x++) {
        const lo = lonOf(x);
        const i = y * w + x;
        const e = elevAt(lo, la);
        elev[i] = e === null ? NaN : e;
        const b = biomeAt(lo, la);
        bio[i] = b === null ? -1 : b;
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return { elev, bio };
}

/** Pass 2: river proximity raster at grid res (null rivers → null, no cost). */
export function buildRiverMask(
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  rivers: RiverGeom,
): Float32Array | null {
  if (!rivers) return null;
  const { w: e0w, h: e0h } = regionSize(0);
  const lonOf = (x: number) => REGION.lonMin + ((x0 + (x + 0.5) * cell) / e0w) * LON_SPAN;
  const latOf = (y: number) => REGION.latMax - ((y0 + (y + 0.5) * cell) / e0h) * LAT_SPAN;
  const riverMask = new Float32Array(w * h);
  const boxLonMin = lonOf(-2);
  const boxLonMax = lonOf(w + 1);
  const boxLatMax = latOf(-2);
  const boxLatMin = latOf(h + 1);
  for (const f of rivers) {
    const bb = f.bbox;
    if (bb[2] < boxLonMin || bb[0] > boxLonMax || bb[3] < boxLatMin || bb[1] > boxLatMax) continue;
    for (const line of f.lines) {
      let px = -1;
      let py = -1;
      for (let i = 0; i < line.length; i += 2) {
        const x = ((line[i] - REGION.lonMin) / LON_SPAN) * e0w;
        const y = ((REGION.latMax - line[i + 1]) / LAT_SPAN) * e0h;
        const gx = (x - x0) / cell;
        const gy = (y - y0) / cell;
        if (px >= 0) {
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(gx - px), Math.abs(gy - py)) * 2));
          for (let s = 0; s <= steps; s++) {
            const qx = Math.round(px + ((gx - px) * s) / steps);
            const qy = Math.round(py + ((gy - py) * s) / steps);
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const nx = qx + ox;
                const ny = qy + oy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                riverMask[ny * w + nx] = 1;
              }
            }
          }
        }
        px = gx;
        py = gy;
      }
    }
  }
  return riverMask;
}
/** Water masks bundled for buildCosts (all same grid, worker-safe). */
export interface WaterMasks {
  land: Uint8Array | null; // 1 = land (rasterizeLandMask)
  lake: Uint8Array | null; // 1 = lake water (rasterizeLakeMask)
  /** big-river barrier raster (1 = blocked), same grid */
  barrier: Uint8Array | null;
}

export function buildCosts(
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  elev: Float32Array,
  bio: Int16Array,
  riverMask: Float32Array | null,
  masks: WaterMasks,
): SimGrid | null {
  const { w: e0w, h: e0h } = regionSize(0);
  const latOf = (y: number) => REGION.latMax - ((y0 + (y + 0.5) * cell) / e0h) * LAT_SPAN;
  const n = w * h;
  if (elev.length !== n || bio.length !== n) return null;
  const landM = masks.land && masks.land.length === n ? masks.land : null;
  const lakeM = masks.lake && masks.lake.length === n ? masks.lake : null;
  const barM = masks.barrier && masks.barrier.length === n ? masks.barrier : null;
  const cost = new Float32Array(n);
  const blocked = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const lat = latOf(y);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const kx = ((LON_SPAN / e0w) * cell * 111.32 * cosLat) / 1; // km per grid cell, x
    const ky = ((LAT_SPAN / e0h) * cell * 110.57) / 1; // km per grid cell, y
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (barM && barM[i] === 1) {
        cost[i] = Infinity; // big-river courses: hard barriers
        blocked[i] = 1;
        continue;
      }
      if (lakeM && lakeM[i] === 1) {
        cost[i] = Infinity;
        blocked[i] = 1;
        continue;
      }
      if (landM && landM[i] === 0) {
        cost[i] = Infinity; // the sea stays unpainted
        blocked[i] = 1;
        continue;
      }
      const e = elev[i];
      if (landM) {
        // vector land wins: below-sea-level land (polders etc.) still
        // settles; missing elevation degrades to flat ground, not water
        const eEff = Number.isFinite(e) ? Math.max(e, 0.5) : 10;
        let b = 2;
        const id = bio[i];
        if (id >= 0) b = costOfBiome(id);
        if (!Number.isFinite(b)) {
          cost[i] = Infinity;
          blocked[i] = 1;
          continue;
        }
        let slope = 0;
        const eL = elev[y * w + Math.max(0, x - 1)];
        const eR = elev[y * w + Math.min(w - 1, x + 1)];
        const eU = elev[Math.max(0, y - 1) * w + x];
        const eD = elev[Math.min(h - 1, y + 1) * w + x];
        if (
          Number.isFinite(eL) && Number.isFinite(eR) &&
          Number.isFinite(eU) && Number.isFinite(eD)
        ) {
          const ex = (eR - eL) / 2;
          const ey = (eD - eU) / 2;
          slope = Math.max(Math.abs(ex) / (kx * 1000), Math.abs(ey) / (ky * 1000));
        }
        let cc = b * (1 + Math.min(slope * 6, 3));
        if (eEff > 1500) cc += 2;
        if (eEff > 2500) cc += 4;
        if (riverMask && riverMask[i] > 0) cc += RIVER_FORD_COST;
        cost[i] = cc;
        continue;
      }
      // fallback (no vector masks): elevation + biome rules
      if (lakeM && lakeM[i] === 1) {
        cost[i] = Infinity;
        blocked[i] = 1;
        continue;
      }
      if (!Number.isFinite(e) || e <= 0) {
        cost[i] = Infinity;
        blocked[i] = 1;
        continue;
      }
      const ex = (elev[y * w + Math.min(w - 1, x + 1)] - elev[y * w + Math.max(0, x - 1)]) / 2;
      const ey =
        (elev[Math.min(h - 1, y + 1) * w + x] - elev[Math.max(0, y - 1) * w + x]) / 2;
      const slope = Math.max(Math.abs(ex) / (kx * 1000), Math.abs(ey) / (ky * 1000));
      let b = 2;
      const id = bio[i];
      if (id >= 0) b = costOfBiome(id);
      if (!Number.isFinite(b)) {
        cost[i] = Infinity;
        blocked[i] = 1;
        continue;
      }
      let c = b * (1 + Math.min(slope * 6, 3));
      if (e > 1500) c += 2;
      if (e > 2500) c += 4;
      if (riverMask && riverMask[i] > 0) c += RIVER_FORD_COST;
      cost[i] = c;
    }
  }
  return { w, h, cost, blocked, ox: x0, oy: y0, cell };
}

/** View-box sim: cost grid for an arbitrary E0-px box at display resolution.
 *  Composed from the cacheable stages above (sample → rivers → costs).
 *  Optional masks pin water truth to the vectors the tiles paint. Without
 *  masks the sim falls back to elev/biome rules. */
export async function buildViewSim(
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  elevAt: (lon: number, lat: number) => number | null,
  biomeAt: (lon: number, lat: number) => number | null,
  rivers: RiverGeom,
  isStale?: () => boolean,
  masks?: { land?: Uint8Array | null; lake?: Uint8Array | null; barrier?: Uint8Array | null },
): Promise<SimGrid | null> {
  const f = await sampleFields(x0, y0, w, h, cell, elevAt, biomeAt, isStale);
  if (!f || isStale?.()) return null;
  const riverMask = buildRiverMask(x0, y0, w, h, cell, rivers);
  if (isStale?.()) return null;
  return buildCosts(x0, y0, w, h, cell, f.elev, f.bio, riverMask, {
    land: masks?.land ?? null,
    lake: masks?.lake ?? null,
    barrier: masks?.barrier ?? null,
  });
}

/** Snap a lon/lat to nearby passable ground; null when surrounded by water. */
export function snapSeed(
  lon: number,
  lat: number,
  isWater: (lon: number, lat: number) => boolean,
): { lon: number; lat: number } | null {
  if (!isWater(lon, lat)) return { lon, lat };
  // expanding rings in degrees (~1 km steps at these latitudes)
  for (let r = 1; r <= 24; r++) {
    const d = r * 0.01;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const lo = lon + Math.cos(a) * d;
      const la = lat + Math.sin(a) * d;
      if (!isWater(lo, la)) return { lon: lo, lat: la };
    }
  }
  return null;
}

/** Nearest passable cell to (gx,gy) within radius, else -1. */
export function nearestLand(
  sim: SimGrid,
  gx: number,
  gy: number,
  maxR = 24,
): number {
  const { w, h, blocked } = sim;
  const cx = Math.max(0, Math.min(w - 1, Math.round(gx)));
  const cy = Math.max(0, Math.min(h - 1, Math.round(gy)));
  if (!blocked[cy * w + cx]) return cy * w + cx;
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (!blocked[y * w + x]) return y * w + x;
      }
    }
  }
  return -1;
}

export interface SprawlResult {
  owner: Int32Array; // seed index or -1 (despeckled — matches contours + paint)
  dist: Float32Array; // raw cost×km distances (pre-smoothing truth)
  counts: number[];
  centroids: { x: number; y: number }[]; // sim-px centers of mass
  contours: Float32Array[]; // boundary polylines in WORLD (E0-px) coords
}

type Pt = [number, number];
interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Boundary segments over a multi-label owner grid, in 2× integer coords.
 *  One segment per label change (seams and shores alike); box outer edges
 *  never emit (fill sprite edges hide the cutoff in the viewport margin). */
function boundarySegments(w: number, h: number, at: (x: number, y: number) => number): Seg[] {
  const segs: Seg[] = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x + 1, y + 1);
      const d = at(x, y + 1);
      const cross: Pt[] = [];
      if (a !== b) cross.push([x * 2 + 1, y * 2]);
      if (b !== c) cross.push([x * 2 + 2, y * 2 + 1]);
      if (d !== c) cross.push([x * 2 + 1, y * 2 + 2]);
      if (a !== d) cross.push([x * 2, y * 2 + 1]);
      if (cross.length === 2) {
        segs.push({ ax: cross[0][0], ay: cross[0][1], bx: cross[1][0], by: cross[1][1] });
      } else if (cross.length === 4) {
        // saddle: pair cyclically adjacent (deterministic)
        segs.push({ ax: cross[0][0], ay: cross[0][1], bx: cross[1][0], by: cross[1][1] });
        segs.push({ ax: cross[2][0], ay: cross[2][1], bx: cross[3][0], by: cross[3][1] });
      }
    }
  }
  return segs;
}

/** Chain segments into polylines via point→segment hashing. */
function assemblePaths(segs: Seg[], stride: number): Pt[][] {
  const key = (x: number, y: number) => y * stride + x;
  const byPoint = new Map<number, number[]>();
  segs.forEach((s, i) => {
    const ka = key(s.ax, s.ay);
    const kb = key(s.bx, s.by);
    let la = byPoint.get(ka);
    if (!la) byPoint.set(ka, (la = []));
    la.push(i);
    let lb = byPoint.get(kb);
    if (!lb) byPoint.set(kb, (lb = []));
    lb.push(i);
  });
  const used = new Uint8Array(segs.length);
  const paths: Pt[][] = [];
  const otherEnd = (si: number, px: number, py: number): Pt => {
    const s = segs[si];
    return s.ax === px && s.ay === py ? [s.bx, s.by] : [s.ax, s.ay];
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const fwd: Pt[] = [[segs[i].ax, segs[i].ay]];
    let tip: Pt = [segs[i].bx, segs[i].by];
    fwd.push(tip);
    for (;;) {
      const cands = byPoint.get(key(tip[0], tip[1])) ?? [];
      let nxt = -1;
      for (const ci of cands) {
        if (!used[ci]) {
          nxt = ci;
          break;
        }
      }
      if (nxt < 0) break;
      used[nxt] = 1;
      tip = otherEnd(nxt, tip[0], tip[1]);
      fwd.push(tip);
    }
    let tail: Pt = [segs[i].ax, segs[i].ay];
    const back: Pt[] = [];
    for (;;) {
      const cands = byPoint.get(key(tail[0], tail[1])) ?? [];
      let nxt = -1;
      for (const ci of cands) {
        if (!used[ci]) {
          nxt = ci;
          break;
        }
      }
      if (nxt < 0) break;
      used[nxt] = 1;
      tail = otherEnd(nxt, tail[0], tail[1]);
      back.push(tail);
    }
    back.reverse();
    const full = back.concat(fwd);
    if (full.length >= 2) paths.push(full);
  }
  return paths;
}

/** Chaikin smooth (cyclic when closed, open with preserved ends otherwise) +
 *  collinear prune → closed world-coord polygon. Null when degenerate. */
function smoothRing(
  p: Pt[],
  closed: boolean,
  toX: (px: number) => number,
  toY: (py: number) => number,
): Float32Array | null {
  let pts: Pt[];
  if (closed) {
    const base =
      (p[0][0] - p[p.length - 1][0]) ** 2 + (p[0][1] - p[p.length - 1][1]) ** 2 < 1
        ? p.slice(0, -1)
        : p.slice();
    if (base.length < 3) return null;
    const ch: Pt[] = [];
    for (let k = 0; k < base.length; k++) {
      const A = base[k];
      const B = base[(k + 1) % base.length];
      ch.push([A[0] * 0.75 + B[0] * 0.25, A[1] * 0.75 + B[1] * 0.25]);
      ch.push([A[0] * 0.25 + B[0] * 0.75, A[1] * 0.25 + B[1] * 0.75]);
    }
    pts = ch;
  } else if (p.length > 2) {
    // two Chaikin rounds: the first takes the corners off, the second melts
    // the grid staircase (shores included) into flowing curves. Deviation from
    // the true edge stays sub-pixel; the stroke width covers it.
    let cur: Pt[] = p;
    for (let iter = 0; iter < 2; iter++) {
      const ch: Pt[] = [cur[0]];
      for (let k = 0; k < cur.length - 1; k++) {
        const A = cur[k];
        const B = cur[k + 1];
        ch.push([A[0] * 0.75 + B[0] * 0.25, A[1] * 0.75 + B[1] * 0.25]);
        ch.push([A[0] * 0.25 + B[0] * 0.75, A[1] * 0.25 + B[1] * 0.75]);
      }
      ch.push(cur[cur.length - 1]);
      cur = ch;
    }
    pts = cur;
  } else {
    pts = p.slice();
  }
  const kept: Pt[] = [pts[0]];
  let px = pts[0][0];
  let py = pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const dx = pts[k][0] - px;
    const dy = pts[k][1] - py;
    if (dx * dx + dy * dy < 0.25 && k < pts.length - 1) continue; // <0.5px radial
    const nx = pts[Math.min(pts.length - 1, k + 1)];
    const vx = nx[0] - kept[kept.length - 1][0];
    const vy = nx[1] - kept[kept.length - 1][1];
    const L2 = vx * vx + vy * vy;
    let drop = false;
    if (L2 > 1e-9) {
      const t = ((pts[k][0] - kept[kept.length - 1][0]) * vx + (pts[k][1] - kept[kept.length - 1][1]) * vy) / L2;
      const qx = kept[kept.length - 1][0] + t * vx - pts[k][0];
      const qy = kept[kept.length - 1][1] + t * vy - pts[k][1];
      if (t >= 0 && t <= 1 && qx * qx + qy * qy < 0.2) drop = true; // <0.45px
    }
    if (!drop || k === pts.length - 1) {
      kept.push(pts[k]);
      px = pts[k][0];
      py = pts[k][1];
    }
  }
  if (kept.length < (closed ? 3 : 2)) return null;
  const m = closed ? kept.length + 1 : kept.length;
  const flat = new Float32Array(m * 2);
  for (let k = 0; k < kept.length; k++) {
    flat[k * 2] = toX(kept[k][0]);
    flat[k * 2 + 1] = toY(kept[k][1]);
  }
  if (closed) {
    flat[(m - 1) * 2] = flat[0];
    flat[(m - 1) * 2 + 1] = flat[1];
  }
  return flat;
}

/** Marching-squares boundary tracing → assembled polylines → 1 Chaikin pass
 *  + collinear prune. Output paths in WORLD (E0-px) coords, ready to stroke
 *  at constant screen width — crisp at any zoom from any sim resolution. */
export function traceContours(sim: SimGrid, owner: Int32Array): Float32Array[] {
  const { w, h, ox, oy, cell } = sim;
  const segs = boundarySegments(w, h, (x, y) => owner[y * w + x]);
  if (segs.length === 0) return [];
  const out: Float32Array[] = [];
  const WX = (px: number) => ox + (px / 2) * cell;
  const WY = (py: number) => oy + (py / 2) * cell;
  for (const p of assemblePaths(segs, w * 2 + 4)) {
    if (p.length < 2) continue;
    const flat = smoothRing(p, false, WX, WY);
    if (flat && flat.length >= 4) out.push(flat);
  }
  return out;
}

/** Shared finalize: smooth → counts/centroids → contours. */
function finalizeSprawl(
  sim: SimGrid,
  dist: Float32Array,
  owner: Int32Array,
  seedCount: number,
): Omit<SprawlResult, 'dist'> & { dist: Float32Array } {
  const sm = smoothOwner(owner, sim.w, sim.h);
  const counts = new Array(seedCount).fill(0);
  const sx = new Array(seedCount).fill(0);
  const sy = new Array(seedCount).fill(0);
  const n = sim.w * sim.h;
  for (let i = 0; i < n; i++) {
    const o = sm[i];
    if (o >= 0 && o < seedCount) {
      counts[o]++;
      sx[o] += i % sim.w;
      sy[o] += (i / sim.w) | 0;
    }
  }
  const centroids = Array.from({ length: seedCount }, (_, k) =>
    counts[k] > 0 ? { x: sx[k] / counts[k], y: sy[k] / counts[k] } : { x: -1, y: -1 },
  );
  const contours = traceContours(sim, sm);
  return { owner: sm, dist, counts, centroids, contours };
}

/** Dijkstra core over pre-seeded dist/owner arrays + boot heap entries.
 *  Shared by full solves and budget resumes. Yields periodically. */
async function runDijkstra(
  sim: SimGrid,
  dist: Float32Array,
  owner: Int32Array,
  boots: { d: number; c: number }[],
  budget: number,
  isStale?: () => boolean,
): Promise<boolean> {
  const { w, h, cost } = sim;
  const n = w * h;
  const hd: number[] = [];
  const hc: number[] = [];
  const push = (d: number, c: number) => {
    hd.push(d);
    hc.push(c);
    let i = hd.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] <= hd[i]) break;
      [hd[p], hd[i]] = [hd[i], hd[p]];
      [hc[p], hc[i]] = [hc[i], hc[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = hc[0];
    const ld = hd.pop()!;
    const lc = hc.pop()!;
    if (hd.length > 0) {
      hd[0] = ld;
      hc[0] = lc;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < hd.length && hd[l] < hd[m]) m = l;
        if (r < hd.length && hd[r] < hd[m]) m = r;
        if (m === i) break;
        [hd[m], hd[i]] = [hd[i], hd[m]];
        [hc[m], hc[i]] = [hc[i], hc[m]];
        i = m;
      }
    }
    return top;
  };
  for (const b of boots) push(b.d, b.c);
  // per-row x step in km (latitude-corrected for the box position)
  const { w: e0w, h: e0h } = regionSize(0);
  const rowKx = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const lat = REGION.latMax - ((sim.oy + (y + 0.5) * sim.cell) / e0h) * LAT_SPAN;
    rowKx[y] = ((LON_SPAN / e0w) * sim.cell * 111.32 * Math.cos((lat * Math.PI) / 180));
  }
  const ky = ((LAT_SPAN / e0h) * sim.cell * 110.57);
  let settled = 0;
  while (hd.length > 0) {
    const c = pop();
    const dc = dist[c];
    const cx = c % w;
    const cy = (c / w) | 0;
    const tryGo = (nb: number, stepKm: number) => {
      if (nb < 0 || nb >= n) return;
      const cc = cost[nb];
      if (!Number.isFinite(cc)) return;
      const nd = dc + 0.5 * (cost[c] + cc) * stepKm;
      if (nd <= budget && nd < dist[nb]) {
        dist[nb] = nd;
        owner[nb] = owner[c];
        push(nd, nb);
      }
    };
    if (cx > 0) tryGo(c - 1, rowKx[cy]);
    if (cx < w - 1) tryGo(c + 1, rowKx[cy]);
    if (cy > 0) tryGo(c - w, ky);
    if (cy < h - 1) tryGo(c + w, ky);
    if (++settled % 20000 === 0) {
      if (isStale?.()) return false;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return !(isStale?.());
}

/** Conservative despeckle over a copy: flip cells drowned 5-vs-3 by a single
 *  neighboring owner. Kills single-cell spikes and staircase jaggies along
 *  shores; lone-islet claims and thin corridors survive. */
export function smoothOwner(owner: Int32Array, w: number, h: number): Int32Array {
  const src = owner;
  const sm = new Int32Array(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const o = src[i];
      if (o < 0) continue;
      let same = 0;
      if (src[i - 1] === o) same++;
      if (src[i + 1] === o) same++;
      if (src[i - w] === o) same++;
      if (src[i + w] === o) same++;
      if (src[i - w - 1] === o) same++;
      if (src[i - w + 1] === o) same++;
      if (src[i + w - 1] === o) same++;
      if (src[i + w + 1] === o) same++;
      if (same > 3) continue;
      const nb = [
        src[i - 1], src[i + 1], src[i - w], src[i + w],
        src[i - w - 1], src[i - w + 1], src[i + w - 1], src[i + w + 1],
      ];
      let bv = -1;
      let bn = 0;
      for (let a = 0; a < 8; a++) {
        const v = nb[a];
        if (v < 0 || v === o) continue;
        let nn = 0;
        for (let c = 0; c < 8; c++) if (nb[c] === v) nn++;
        if (nn > bn) {
          bn = nn;
          bv = v;
        }
      }
      if (bv >= 0 && bn >= 5) sm[i] = bv;
    }
  }
  return sm;
}

/** Multi-source Dijkstra with a cost-distance budget (= sprawl level).
 *  Optional `initial` pins extra starting cells at given distances — used to
 *  inject a coarse global solution around a fine viewport box so territories
 *  outside the box still compete correctly. Distances share the same
 *  cost×km units; owner indices must be < seeds.length. */
export async function computeSprawl(
  sim: SimGrid,
  seeds: number[],
  budget: number,
  isStale?: () => boolean,
  initial?: { i: number; dist: number; owner: number }[],
): Promise<SprawlResult | null> {
  const { w, h, cost } = sim;
  const n = w * h;
  const dist = new Float32Array(n).fill(Infinity);
  const owner = new Int32Array(n).fill(-1);
  const boots: { d: number; c: number }[] = [];
  seeds.forEach((s, k) => {
    if (s >= 0 && s < n && Number.isFinite(cost[s])) {
      dist[s] = 0;
      owner[s] = k;
      boots.push({ d: 0, c: s });
    }
  });
  if (initial) {
    for (const src of initial) {
      if (src.i < 0 || src.i >= n || src.owner < 0 || src.owner >= seeds.length) continue;
      if (!Number.isFinite(src.dist) || src.dist > budget || !Number.isFinite(cost[src.i])) continue;
      if (src.dist < dist[src.i]) {
        dist[src.i] = src.dist;
        owner[src.i] = src.owner;
        boots.push({ d: src.dist, c: src.i });
      }
    }
  }
  const ok = await runDijkstra(sim, dist, owner, boots, budget, isStale);
  if (!ok) return null;
  return finalizeSprawl(sim, dist, owner, seeds.length);
}

/** Budget resume: continue a previous solution to a larger budget without
 *  re-settling the interior — the frontier is rebuilt from cells touching
 *  anything beyond old reach, then Dijkstra continues. Same costs + seeds
 *  required; returns null (caller falls back to a full solve) when the
 *  budget didn't grow. */
export async function resumeSprawl(
  sim: SimGrid,
  prevDist: Float32Array,
  prevOwner: Int32Array,
  seedCount: number,
  oldBudget: number,
  newBudget: number,
  isStale?: () => boolean,
): Promise<SprawlResult | null> {
  if (!(newBudget > oldBudget)) return null;
  const { w, h } = sim;
  const n = w * h;
  if (prevDist.length !== n || prevOwner.length !== n) return null;
  const dist = new Float32Array(prevDist);
  const owner = new Int32Array(prevOwner);
  const boots: { d: number; c: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = dist[i];
      if (!(d <= oldBudget)) continue;
      if (
        (x > 0 && dist[i - 1] > oldBudget) ||
        (x < w - 1 && dist[i + 1] > oldBudget) ||
        (y > 0 && dist[i - w] > oldBudget) ||
        (y < h - 1 && dist[i + w] > oldBudget)
      ) {
        boots.push({ d, c: i });
      }
    }
  }
  if (boots.length === 0) {
    // nothing can grow (all frontiers blocked/budget-capped): re-finalize as-is
    return finalizeSprawl(sim, dist, owner, seedCount);
  }
  const ok = await runDijkstra(sim, dist, owner, boots, newBudget, isStale);
  if (!ok) return null;
  return finalizeSprawl(sim, dist, owner, seedCount);
}

/** Paint settled cells into an RGBA canvas (sim res). Expects a smoothed
 *  owner grid (see finalizeSprawl). Vector contours (res.contours) carry the
 *  borders — set seams=false for a flat fill and stroke contours separately
 *  (crisp at any zoom); seams=true keeps the classic 1px raster seams. */
export function paintSprawl(
  res: SprawlResult,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  seams = true,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const A = Math.round(alpha * 255) << 24;
  const lite = A | (Math.min(255, b + 70) << 16) | (Math.min(255, g + 70) << 8) | Math.min(255, r + 70);
  const sm = res.owner;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = sm[i];
      if (o < 0) continue;
      // territory border: neighbor owned by a different seed
      const border = seams && (
        (x > 0 && sm[i - 1] !== o && sm[i - 1] >= 0) ||
        (x < w - 1 && sm[i + 1] !== o && sm[i + 1] >= 0) ||
        (y > 0 && sm[i - w] !== o && sm[i - w] >= 0) ||
        (y < h - 1 && sm[i + w] !== o && sm[i + w] >= 0));
      buf[i] = border ? lite : A | (b << 16) | (g << 8) | r;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
