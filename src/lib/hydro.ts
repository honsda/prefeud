// Hydrography: true land/ocean mask + inland lake polygons.
//
// Why: elevation alone cannot tell water from land. The Caspian lowlands
// (−28m), Qattara (−133m), Dead Sea shores (−430m) and Dutch polders are LAND
// despite sitting below sea level, while Victoria (1134m), Chad andAral are
// WATER despite sitting high. So:
//   sea  = inside-ocean test from land vectors (world-atlas 50m, Caspian cut
//          out, polders kept) — never a raw elev<0 flood that drowns Holland
//   lakes = Natural Earth 50m polygons filled on top (Caspian comes from the
//          mask, Aral/Chad/Victoria/Baikal from here)
// Missing data (mask not yet loaded) falls back to the old elev<0 rule and
// repaints once the mask arrives.

import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import bundled from '../assets/japan-hydro.json';
import landTopo from '../assets/vectors/land-50m.json';
import lakesGeo from '../assets/vectors/ne_50m_lakes.json';

export interface HydroPoly {
  outer: Float32Array; // [lon,lat,…]
  holes: Float32Array[];
  bbox: [number, number, number, number];
}

export interface LakePoly {
  name: string;
  rank: number;
  polys: HydroPoly[];
  bbox: [number, number, number, number];
}

export interface HydroView {
  w: number;
  h: number;
  xOf: (lon: number) => number;
  yOf: (lat: number) => number;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

let landPolys: HydroPoly[] | null = null;
let landLoading: Promise<HydroPoly[] | null> | null = null;
let lakes: LakePoly[] | null = null;
let lakesLoading: Promise<LakePoly[] | null> | null = null;

function toPoly(coords: number[][][]): HydroPoly {
  const conv = (ring: number[][]) => {
    const pts = new Float32Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      pts[i * 2] = ring[i][0];
      pts[i * 2 + 1] = ring[i][1];
    }
    return pts;
  };
  const outer = conv(coords[0]);
  const holes = coords.slice(1).map(conv);
  let x0 = 180;
  let y0 = 90;
  let x1 = -180;
  let y1 = -90;
  for (let i = 0; i < outer.length; i += 2) {
    const lon = outer[i];
    const lat = outer[i + 1];
    if (lon < x0) x0 = lon;
    if (lon > x1) x1 = lon;
    if (lat < y0) y0 = lat;
    if (lat > y1) y1 = lat;
  }
  return { outer, holes, bbox: [x0, y0, x1, y1] };
}

export function loadLand(): Promise<HydroPoly[] | null> {
  if (landPolys) return Promise.resolve(landPolys);
  if (landLoading) return landLoading;
  landLoading = (async () => {
    try {
      const topo = landTopo as unknown as Topology;
      const fc = feature(topo as never, (topo.objects as Record<string, never>).land as never) as unknown as {
        features?: { geometry: GeoJSON.Geometry }[];
        geometry?: GeoJSON.Geometry;
      };
      const geoms: GeoJSON.Geometry[] = fc.features
        ? fc.features.map((f) => f.geometry)
        : fc.geometry
          ? [fc.geometry]
          : [];
      const out: HydroPoly[] = [];
      for (const g of geoms) {
        if (g.type === 'Polygon') out.push(toPoly(g.coordinates));
        else if (g.type === 'MultiPolygon') for (const p of g.coordinates) out.push(toPoly(p));
      }
      landPolys = out;
      return out;
    } catch {
      return null;
    }
  })();
  return landLoading;
}

export function loadLakes(): Promise<LakePoly[] | null> {
  if (lakes) return Promise.resolve(lakes);
  if (lakesLoading) return lakesLoading;
  lakesLoading = (async () => {
    try {
      const j = lakesGeo as unknown as { features: GeoJSONFeature[] };
      const out: LakePoly[] = [];
      for (const f of j.features) {
        if (!f.geometry || f.geometry.type !== 'Polygon') continue;
        const rank = Number(f.properties?.scalerank ?? 5);
        const name = String(f.properties?.name ?? '');
        const polys: HydroPoly[] = [toPoly(f.geometry.coordinates)];
        const bb = polys[0].bbox;
        out.push({ name, rank, polys, bbox: bb });
      }
      lakes = out;
      return out;
    } catch {
      return null;
    }
  })();
  return lakesLoading;
}

interface GeoJSONFeature {
  geometry: { type: string; coordinates: number[][][] } | null;
  properties?: Record<string, unknown>;
}

export function landReady(): boolean {
  return landPolys !== null;
}
export function lakesReady(): boolean {
  return lakes !== null;
}

/** True when an NE bbox's center sits inside bundled detail (same feature,
 *  cruder source) — skip the NE copy so shorelines don't double-draw. */
function coveredByDetail(bb: [number, number, number, number]): boolean {
  const cx = (bb[0] + bb[2]) / 2;
  const cy = (bb[1] + bb[3]) / 2;
  for (const lake of detailLakes) {
    const lb = lake.bbox;
    if (cx < lb[0] || cx > lb[2] || cy < lb[1] || cy > lb[3]) continue;
    for (const poly of lake.polys) {
      const o = poly.outer;
      let inside = false;
      const m = o.length / 2;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const xi = o[i * 2];
        const yi = o[i * 2 + 1];
        const xj = o[j * 2];
        const yj = o[j * 2 + 1];
        if (yi > cy !== yj > cy && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}

// Bundled OSM detail (Biwa 967-pt shoreline, major rivers' lakes…): parsed
// once at module load, zero fetch, always drawn (rank 0).
interface BundledHydro {
  lakes: { n: string; polys: { o: number[][]; h: number[][][] }[] }[];
}
const detailLakes: LakePoly[] = ((bundled as unknown as BundledHydro).lakes || []).map((L) => {
  const polys: HydroPoly[] = L.polys.map((p) => {
    const outer = Float32Array.from(p.o.flat());
    const holes = p.h.map((h) => Float32Array.from(h.flat()));
    let x0 = 180;
    let y0 = 90;
    let x1 = -180;
    let y1 = -90;
    for (let i = 0; i < outer.length; i += 2) {
      const lon = outer[i];
      const lat = outer[i + 1];
      if (lon < x0) x0 = lon;
      if (lon > x1) x1 = lon;
      if (lat < y0) y0 = lat;
      if (lat > y1) y1 = lat;
    }
    return { outer, holes, bbox: [x0, y0, x1, y1] as [number, number, number, number] };
  });
  let x0 = 180;
  let y0 = 90;
  let x1 = -180;
  let y1 = -90;
  for (const p of polys) {
    if (p.bbox[0] < x0) x0 = p.bbox[0];
    if (p.bbox[2] > x1) x1 = p.bbox[2];
    if (p.bbox[1] < y0) y0 = p.bbox[1];
    if (p.bbox[3] > y1) y1 = p.bbox[3];
  }
  return { name: L.n, rank: 0, polys, bbox: [x0, y0, x1, y1] };
});

/** Fill land polygons with a color. Returns false when mask isn't loaded. */
export function fillLand(ctx: CanvasRenderingContext2D, v: HydroView, color: string): boolean {
  if (!landPolys) return false;
  ctx.fillStyle = color;
  const padX = (v.lonMax - v.lonMin) * 0.02;
  const padY = (v.latMax - v.latMin) * 0.02;
  const trace = (pts: Float32Array, p: Path2D) => {
    p.moveTo(v.xOf(pts[0]), v.yOf(pts[1]));
    for (let i = 2; i < pts.length; i += 2) p.lineTo(v.xOf(pts[i]), v.yOf(pts[i + 1]));
    p.closePath();
  };
  for (const poly of landPolys) {
    const bb = poly.bbox;
    if (bb[2] < v.lonMin - padX || bb[0] > v.lonMax + padX || bb[3] < v.latMin - padY || bb[1] > v.latMax + padY)
      continue;
    // outer + holes in ONE path: evenodd actually punches holes
    const p = new Path2D();
    trace(poly.outer, p);
    for (const h of poly.holes) trace(h, p);
    ctx.fill(p, 'evenodd');
  }
  return true;
}

/** Rasterize land mask to bytes (1 = land). Null when the mask isn't loaded. */
export function rasterizeLandMask(v: HydroView): Uint8Array | null {
  if (!landPolys) return null;
  const c = document.createElement('canvas');
  c.width = v.w;
  c.height = v.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, v.w, v.h);
  fillLand(ctx, v, '#fff');
  const img = ctx.getImageData(0, 0, v.w, v.h);
  const d = img.data;
  const mask = new Uint8Array(v.w * v.h);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
  removeSeaSpecks(mask, v.w, v.h);
  return mask;
}

/**
 * Drop sub-resolution sea components (tidal inlets / raster crumbs smaller
 * than ~6 tile-px): magnified 10-60× they'd read as isolated blue dots.
 * Real waters reappear automatically one level deeper, where they span
 * multiple pixels. Border-touching components are kept (they may continue
 * off-canvas). Land islets are always kept — tiny islands are landmarks.
 */
function removeSeaSpecks(mask: Uint8Array, w: number, h: number): void {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0 || seen[i]) continue;
    // flood-fill this sea component (4-connected)
    let n = 0;
    let touchesBorder = false;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const cells: number[] = [];
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      n++;
      const x = c % w;
      const y = (c / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      if (x > 0 && mask[c - 1] === 0 && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (x < w - 1 && mask[c + 1] === 0 && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (y > 0 && mask[c - w] === 0 && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
      if (y < h - 1 && mask[c + w] === 0 && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
    }
    if (!touchesBorder && n < 6) {
      for (const cell of cells) mask[cell] = 1;
    }
  }
}

const LAKE_FILL = '#11367a';
const LAKE_EDGE = '#0b1e3d';

/** Fill lake polygons onto a 2D context. Returns lakes drawn. */
export function drawLakes(
  ctx: CanvasRenderingContext2D,
  v: HydroView,
  maxRank: number,
): number {
  if (!lakes && detailLakes.length === 0) return 0;
  const padX = (v.lonMax - v.lonMin) * 0.02 + 0.25;
  const padY = (v.latMax - v.latMin) * 0.02 + 0.25;
  ctx.save();
  ctx.fillStyle = LAKE_FILL;
  ctx.strokeStyle = LAKE_EDGE;
  ctx.lineWidth = 1;
  let drawn = 0;
  const paintOne = (polys: HydroPoly[]) => {
    const p = new Path2D();
    for (const poly of polys) {
      p.moveTo(v.xOf(poly.outer[0]), v.yOf(poly.outer[1]));
      const o = poly.outer;
      for (let i = 2; i < o.length; i += 2) p.lineTo(v.xOf(o[i]), v.yOf(o[i + 1]));
      p.closePath();
      for (const h of poly.holes) {
        p.moveTo(v.xOf(h[0]), v.yOf(h[1]));
        for (let i = 2; i < h.length; i += 2) p.lineTo(v.xOf(h[i]), v.yOf(h[i + 1]));
        p.closePath();
      }
    }
    ctx.fill(p, 'evenodd');
    ctx.stroke(p);
  };
  const culled = (bb: [number, number, number, number]) =>
    bb[2] < v.lonMin - padX || bb[0] > v.lonMax + padX || bb[3] < v.latMin - padY || bb[1] > v.latMax + padY;
  // LOD: skip lakes smaller than ~2 tile-px — they'd magnify into dots;
  // they reappear automatically when zoomed to a level that resolves them
  const degX = (v.lonMax - v.lonMin) / v.w;
  const degY = (v.latMax - v.latMin) / v.h;
  const tooSmall = (bb: [number, number, number, number]) =>
    (bb[2] - bb[0]) / degX < 2 && (bb[3] - bb[1]) / degY < 2;
  // bundled OSM detail first (always), then NE by rank
  for (const lake of detailLakes) {
    if (culled(lake.bbox)) continue;
    const polys = lake.polys.filter((p) => !tooSmall(p.bbox));
    if (polys.length === 0) continue;
    paintOne(polys);
    drawn++;
  }
  if (lakes) {
    for (const lake of lakes) {
      if (lake.rank > maxRank) continue;
      // bundled OSM detail supersedes the crude NE copy (Biwa etc.)
      if (coveredByDetail(lake.bbox)) continue;
      if (culled(lake.bbox)) continue;
      const polys = lake.polys.filter((p) => !tooSmall(p.bbox));
      if (polys.length === 0) continue;
      paintOne(polys);
      drawn++;
    }
  }
  ctx.restore();
  return drawn;
}

/** Rasterize lake water to bytes (1 = lake). Same polygons + LOD culling as
 *  drawLakes, so the sim blocks exactly the water the tiles paint. Null when
 *  nothing is loaded yet (callers fall back to elev/biome rules). */
export function rasterizeLakeMask(v: HydroView): Uint8Array | null {
  if (!lakes && detailLakes.length === 0) return null;
  const c = document.createElement('canvas');
  c.width = v.w;
  c.height = v.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.fillStyle = '#fff';
  const padX = (v.lonMax - v.lonMin) * 0.02 + 0.25;
  const padY = (v.latMax - v.latMin) * 0.02 + 0.25;
  const culled = (bb: [number, number, number, number]) =>
    bb[2] < v.lonMin - padX || bb[0] > v.lonMax + padX || bb[3] < v.latMin - padY || bb[1] > v.latMax + padY;
  const degX = (v.lonMax - v.lonMin) / v.w;
  const degY = (v.latMax - v.latMin) / v.h;
  const tooSmall = (bb: [number, number, number, number]) =>
    (bb[2] - bb[0]) / degX < 2 && (bb[3] - bb[1]) / degY < 2;
  const paintOne = (polys: HydroPoly[]) => {
    const p = new Path2D();
    for (const poly of polys) {
      p.moveTo(v.xOf(poly.outer[0]), v.yOf(poly.outer[1]));
      const o = poly.outer;
      for (let i = 2; i < o.length; i += 2) p.lineTo(v.xOf(o[i]), v.yOf(o[i + 1]));
      p.closePath();
      for (const h of poly.holes) {
        p.moveTo(v.xOf(h[0]), v.yOf(h[1]));
        for (let i = 2; i < h.length; i += 2) p.lineTo(v.xOf(h[i]), v.yOf(h[i + 1]));
        p.closePath();
      }
    }
    ctx.fill(p, 'evenodd');
  };
  for (const lake of detailLakes) {
    if (culled(lake.bbox)) continue;
    const polys = lake.polys.filter((p) => !tooSmall(p.bbox));
    if (polys.length === 0) continue;
    paintOne(polys);
  }
  if (lakes) {
    for (const lake of lakes) {
      if (lake.rank > 99) continue;
      if (coveredByDetail(lake.bbox)) continue;
      if (culled(lake.bbox)) continue;
      const polys = lake.polys.filter((p) => !tooSmall(p.bbox));
      if (polys.length === 0) continue;
      paintOne(polys);
    }
  }
  const img = ctx.getImageData(0, 0, v.w, v.h);
  const d = img.data;
  const mask = new Uint8Array(v.w * v.h);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
  return mask;
}

/** Rasterize big-river courses to barrier bytes (1 = blocked). Stroked wide
 *  (3px at fine res, 2px coarse) with round caps/joins so the band is
 *  unbroken — a continuous 4-connected barrier territories cannot cross
 *  except around its ends. Same vectors the overlay draws. */
export function rasterizeRiverBarrier(
  v: HydroView,
  feats: { lines: Float32Array[]; bbox: [number, number, number, number] }[],
  widthPx: number,
): Uint8Array | null {
  if (feats.length === 0) return null;
  const c = document.createElement('canvas');
  c.width = v.w;
  c.height = v.h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, widthPx);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const padX = (v.lonMax - v.lonMin) * 0.02;
  const padY = (v.latMax - v.latMin) * 0.02;
  for (const f of feats) {
    const bb = f.bbox;
    if (bb[2] < v.lonMin - padX || bb[0] > v.lonMax + padX || bb[3] < v.latMin - padY || bb[1] > v.latMax + padY)
      continue;
    ctx.beginPath();
    for (const line of f.lines) {
      if (line.length < 4) continue;
      ctx.moveTo(v.xOf(line[0]), v.yOf(line[1]));
      for (let i = 2; i < line.length; i += 2) ctx.lineTo(v.xOf(line[i]), v.yOf(line[i + 1]));
    }
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, v.w, v.h);
  const d = img.data;
  const mask = new Uint8Array(v.w * v.h);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
  return mask;
}
