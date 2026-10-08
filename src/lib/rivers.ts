// Natural Earth 50m river + lake centerlines (~827KB, 462 features).
// Fetched once from jsDelivr (CORS-open, long cache headers), parsed to flat
// arrays with per-feature bboxes for cheap viewport culling. Drawn as vector
// strokes on top of painted tiles — crisp at every zoom, no extra textures.

export interface RiverFeature {
  name: string;
  rank: number; // scalerank 1 (Amazon/Nile class) … 6 (minor)
  lake: boolean; // lake centerline rather than a river
  lines: Float32Array[]; // [lon,lat,lon,lat,…] per polyline
  bbox: [number, number, number, number]; // lonMin, latMin, lonMax, latMax
}

export interface RiverView {
  w: number;
  h: number;
  xOf: (lon: number) => number;
  yOf: (lat: number) => number;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

import bundled from '../assets/japan-hydro.json';
import riversGeo from '../assets/vectors/ne_50m_rivers.json';

let cache: RiverFeature[] | null = null;
let loading: Promise<RiverFeature[] | null> | null = null;

// Bundled OSM detail (Tone, Shinano, Yodo…): parsed once at module load, zero
// fetch, always drawn (rank 0 beats every maxRank filter).
interface BundledHydro {
  rivers: { n: string; l: number[][][]; rank?: number }[];
}
const detailRivers: RiverFeature[] = ((bundled as unknown as BundledHydro).rivers || []).map((R) => {
  const lines: Float32Array[] = [];
  let x0 = 180;
  let y0 = 90;
  let x1 = -180;
  let y1 = -90;
  for (const line of R.l) {
    const flat = new Float32Array(line.length * 2);
    for (let i = 0; i < line.length; i++) {
      const lon = line[i][0];
      const lat = line[i][1];
      flat[i * 2] = lon;
      flat[i * 2 + 1] = lat;
      if (lon < x0) x0 = lon;
      if (lon > x1) x1 = lon;
      if (lat < y0) y0 = lat;
      if (lat > y1) y1 = lat;
    }
    lines.push(flat);
  }
  return { name: R.n, rank: Number(R.rank ?? 0), lake: false, lines, bbox: [x0, y0, x1, y1] };
});

export function loadRivers(): Promise<RiverFeature[] | null> {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;
  loading = (async () => {
    try {
      const j = riversGeo as unknown as {
        features: {
          geometry: { type: string; coordinates: number[][][] } | null;
          properties?: Record<string, unknown>;
        }[];
      };
      const out: RiverFeature[] = [];
      for (const f of j.features) {
        if (!f.geometry || f.geometry.type !== 'MultiLineString') continue;
        const rank = Number(f.properties?.scalerank ?? 5);
        const lake = f.properties?.featurecla !== 'River';
        const name = String(f.properties?.name ?? '');
        const lines: Float32Array[] = [];
        let x0 = 180;
        let y0 = 90;
        let x1 = -180;
        let y1 = -90;
        for (const line of f.geometry.coordinates) {
          const flat = new Float32Array(line.length * 2);
          for (let i = 0; i < line.length; i++) {
            const lon = line[i][0];
            const lat = line[i][1];
            flat[i * 2] = lon;
            flat[i * 2 + 1] = lat;
            if (lon < x0) x0 = lon;
            if (lon > x1) x1 = lon;
            if (lat < y0) y0 = lat;
            if (lat > y1) y1 = lat;
          }
          lines.push(flat);
        }
        if (lines.length > 0) out.push({ name, rank, lake, lines, bbox: [x0, y0, x1, y1] });
      }
      cache = out;
      return out;
    } catch {
      return null;
    }
  })();
  return loading;
}

export function riversReady(): boolean {
  return cache !== null;
}

/** Bundled OSM detail rivers (always available, no fetch). */
export function bundledRivers(): RiverFeature[] {
  return detailRivers;
}

/** NE background rivers once fetched (null until then). */
export function neRivers(): RiverFeature[] | null {
  return cache;
}

/**
 * Douglas-Peucker on a flat [lon,lat,…] line. Screen-space thinking: callers
 * pass a degree tolerance ≈ a fraction of a screen pixel, so dense OSM
 * vertices (50 m apart) collapse to clean reaches instead of stroking as
 * jittery dot-dash chains when magnified 60×+.
 */
export function simplifyLine(line: Float32Array, tol: number): Float32Array | null {
  const n = line.length / 2;
  if (n <= 2) return line;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    const ax = line[s * 2];
    const ay = line[s * 2 + 1];
    const dx = line[e * 2] - ax;
    const dy = line[e * 2 + 1] - ay;
    const L2 = dx * dx + dy * dy;
    let dmax = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = line[i * 2];
      const py = line[i * 2 + 1];
      let d: number;
      if (L2 === 0) {
        d = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const qx = px - ax - t * dx;
        const qy = py - ay - t * dy;
        d = qx * qx + qy * qy;
      }
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) if (keep[i]) m++;
  if (m < 2) return null;
  const out = new Float32Array(m * 2);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[j++] = line[i * 2];
    out[j++] = line[i * 2 + 1];
  }
  return out;
}

/** True when an NE bbox sits inside bundled detail (same river, cruder
 *  source) — skip the NE copy so lines don't double up. */
export function neSuperseded(bb: [number, number, number, number]): boolean {
  const pad = 0.3;
  for (const f of detailRivers) {
    const b = f.bbox;
    if (
      bb[0] >= b[0] - pad &&
      bb[2] <= b[2] + pad &&
      bb[1] >= b[1] - pad &&
      bb[3] <= b[3] + pad
    )
      return true;
  }
  return false;
}

/** NE ranks that count as BIG rivers (natural-barrier class with bundled detail). */
export const BIG_RIVER_RANK = 2;

export interface BigRiver {
  lines: Float32Array[];
  bbox: [number, number, number, number];
}

/** Big rivers only (bundled OSM detail + NE rank ≤ BIG_RIVER_RANK, simplified
 *  at tol): the courses territories treat as hard barriers. Small streams
 *  are painted over. Lake centerlines excluded (lakes handled by the mask). */
export function bigRiverFeatures(tol: number): BigRiver[] {
  const out: BigRiver[] = [];
  const push = (f: RiverFeature) => {
    if (f.lake) return;
    const lines: Float32Array[] = [];
    for (const l of f.lines) {
      const s = simplifyLine(l, tol);
      if (s) lines.push(s);
    }
    if (lines.length === 0) return;
    out.push({ lines, bbox: f.bbox });
  };
  for (const f of detailRivers) push(f);
  if (cache) {
    for (const f of cache) {
      if (f.rank > BIG_RIVER_RANK) continue;
      if (neSuperseded(f.bbox)) continue;
      push(f);
    }
  }
  return out;
}

export function riverCount(): number {
  return cache?.length ?? 0;
}

