// Real Earth elevation + bathymetry engine.
// Source: Mapzen Terrarium tiles (SRTM/GMTED/ETOPO composite, includes ocean
// depth). Encoding: elev = R*256 + G + B/256 - 32768. Web-Mercator pyramid,
// CORS-open, reprojected here to an equirectangular pixel buffer.
//
// Pipeline: fetch tile pyramid (z2/z3 ≈ 16/64 tiles) -> Float32 grids ->
// single-pass paint (bilinear sample + hillshade + hypsometric ramp) ->
// one PIXI texture. Zooming fetches higher-zoom tiles for the viewport
// (up to z9) and repaints just that region with true high-res data.

export type ElevQuality = 'low' | 'medium' | 'ultra';

export const ELEV_SOURCES: Record<
  ElevQuality,
  { tileZoom: number; w: number; h: number; label: string; tiles: number }
> = {
  low: { tileZoom: 2, w: 2048, h: 1024, label: '2048 × 1024 · terrain z2', tiles: 16 },
  medium: { tileZoom: 3, w: 4096, h: 2048, label: '4096 × 2048 · terrain z3', tiles: 64 },
  ultra: { tileZoom: 3, w: 8192, h: 4096, label: '8192 × 4096 · terrain z3 + live refine', tiles: 64 },
};

export const TERRARIUM_CREDIT = 'Elevation: Mapzen Terrarium (SRTM/GMTED/ETOPO composite)';
export const MAX_MERC_LAT = 85.05112878;
export const TILE_PX = 256; // terrarium tile size
const T = TILE_PX;
const MAX_REFINE_ZOOM = 9;
const MAX_REFINE_TILES = 48;

const tileUrl = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// --- session tile cache (decoded Float32 grids, 256×256) ---
// Exported for the tiled virtual-texture engine (shares one source cache).
export const tileCache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();
export const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;
const key = tileKey;

let decodeCanvas: HTMLCanvasElement | null = null;

export async function decodeTileBlob(blob: Blob): Promise<Float32Array | null> {
  try {
    const bmp = await createImageBitmap(blob);
    if (!decodeCanvas) {
      decodeCanvas = document.createElement('canvas');
      decodeCanvas.width = T;
      decodeCanvas.height = T;
    }
    const ctx = decodeCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, T, T);
    const d = img.data;
    const out = new Float32Array(T * T);
    for (let i = 0; i < out.length; i++) {
      out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    }
    return out;
  } catch {
    return null;
  }
}

export function fetchTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const k = key(z, x, y);
  const hit = tileCache.get(k);
  if (hit) return Promise.resolve(hit);
  const ongoing = inflight.get(k);
  if (ongoing) return ongoing;
  const p = (async () => {
    try {
      const res = await fetch(tileUrl(z, x, y));
      if (!res.ok) return null;
      const grid = await decodeTileBlob(await res.blob());
      if (grid) {
        // simple size cap: drop oldest entries past ~640 tiles
        if (tileCache.size > 640) {
          const first = tileCache.keys().next();
          if (!first.done) tileCache.delete(first.value);
        }
        tileCache.set(k, grid);
      }
      return grid;
    } catch {
      return null;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Fetch many tiles with bounded concurrency. Returns number successfully decoded. */
async function fetchMany(
  list: { z: number; x: number; y: number }[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let done = 0;
  let ok = 0;
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const t = list[i++];
      const g = await fetchTile(t.z, t.x, t.y);
      if (g) ok++;
      done++;
      onProgress?.(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return ok;
}

// --- mercator math ---
export const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
export function latToTileY(lat: number, z: number): number {
  const c = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
  const r = (c * Math.PI) / 180;
  return (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// --- seamless global grid (cross-tile bilinear, antimeridian wrap) ---
export class GlobalGrid {
  z: number;
  n: number; // tiles per axis
  constructor(z: number) {
    this.z = z;
    this.n = 2 ** z;
  }
  /** raw elevation at global pixel coords (float). NaN if tile missing. */
  private get(ix: number, iy: number): number {
    const n = this.n;
    if (iy < 0 || iy >= n * T) return NaN;
    const qx = Math.floor(ix / T);
    const qy = Math.floor(iy / T);
    // wrap longitude so the antimeridian is seamless
    const tx = ((qx % n) + n) % n;
    const g = tileCache.get(key(this.z, tx, qy));
    if (!g) return NaN;
    const localX = Math.max(0, Math.min(T - 1, ix - qx * T));
    const localY = Math.max(0, Math.min(T - 1, iy - qy * T));
    return g[localY * T + localX];
  }
  sample(lat: number, lon: number): number {
    if (Math.abs(lat) > MAX_MERC_LAT) return NaN;
    const gx = lonToTileX(lon, this.z) * T;
    const gy = latToTileY(lat, this.z) * T;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = this.get(x0, y0);
    const b = this.get(x0 + 1, y0);
    const c = this.get(x0, y0 + 1);
    const d = this.get(x0 + 1, y0 + 1);
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
      // fall back to nearest available of the four
      if (!Number.isNaN(a)) return a;
      if (!Number.isNaN(b)) return b;
      if (!Number.isNaN(c)) return c;
      return d;
    }
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
}

/** Sample best-available data: highest cached refine zoom, else global grid. */
export function sampleBest(
  grid: GlobalGrid | null,
  lat: number,
  lon: number,
): { elev: number; z: number } | null {
  if (Math.abs(lat) > MAX_MERC_LAT) return null; // polar cap: no tile data
  // search cached tiles from high to low zoom
  for (let z = MAX_REFINE_ZOOM; z > (grid?.z ?? 1); z--) {
    const tx = Math.floor(lonToTileX(lon, z));
    const ty = Math.floor(latToTileY(lat, z));
    const g = tileCache.get(key(z, tx, Math.max(0, Math.min(2 ** z - 1, ty))));
    if (!g) continue;
    // bilinear inside tile (edge-clamped)
    const px = Math.max(0, Math.min(T - 1.001, (lonToTileX(lon, z) - tx) * T));
    const py = Math.max(0, Math.min(T - 1.001, (latToTileY(lat, z) - ty) * T));
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const a = g[y0 * T + x0];
    const b = g[y0 * T + x0 + 1];
    const c = g[(y0 + 1) * T + x0];
    const d = g[(y0 + 1) * T + x0 + 1];
    return { elev: a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy, z };
  }
  if (!grid) return null;
  const e = grid.sample(lat, lon);
  return Number.isNaN(e) ? null : { elev: e, z: grid.z };
}

// --- dark ambient LUT: dark = low, bright = high (monotonic grayscale land,
// deep-blue ocean). Relief reads through brightness, not hue.
type Stop = [number, number, number, number]; // elev, r, g, b
const RAMP: Stop[] = [
  // bathymetry: abyssal blue-black → clearly blue shelf
  [-11000, 2, 6, 20],
  [-8000, 3, 9, 30],
  [-6000, 4, 13, 42],
  [-4000, 6, 19, 58],
  [-2000, 9, 28, 78],
  [-1000, 13, 40, 100],
  [-200, 17, 54, 122],
  [0, 22, 68, 142],
  // topography: contrast lives where Japan's land is (0–2500 m);
  // dark ambient kept, peaks stay muted, never white
  [1, 34, 36, 41],
  [250, 52, 55, 61],
  [500, 68, 72, 78],
  [1000, 92, 96, 102],
  [1500, 112, 116, 122],
  [2000, 130, 134, 140],
  [3000, 148, 152, 158],
  [9000, 165, 169, 175],
];
const LUT_MIN = -11000;
const LUT_MAX = 9000;
const LUT = (() => {
  const n = LUT_MAX - LUT_MIN + 1;
  const out = new Uint8Array(n * 3);
  let s = 0;
  for (let e = LUT_MIN; e <= LUT_MAX; e++) {
    while (s < RAMP.length - 2 && e > RAMP[s + 1][0]) s++;
    const [e0, r0, g0, b0] = RAMP[s];
    const [e1, r1, g1, b1] = RAMP[s + 1];
    const t = Math.max(0, Math.min(1, (e - e0) / (e1 - e0 || 1)));
    out[(e - LUT_MIN) * 3] = r0 + (r1 - r0) * t;
    out[(e - LUT_MIN) * 3 + 1] = g0 + (g1 - g0) * t;
    out[(e - LUT_MIN) * 3 + 2] = b0 + (b1 - b0) * t;
  }
  return out;
})();

function lut(e: number): [number, number, number] {
  const i = Math.max(LUT_MIN, Math.min(LUT_MAX, Math.round(e))) - LUT_MIN;
  return [LUT[i * 3], LUT[i * 3 + 1], LUT[i * 3 + 2]];
}

function pack(r: number, g: number, b: number): number {
  return (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
}

// standard hillshade (azimuth 315°, altitude 45°)
function hillshade(eC: number, eE: number, eW: number, eN: number, eS: number, lat: number, dLon: number, dLat: number): number {
  const cellX = Math.max(1, dLon * 111320 * Math.cos((lat * Math.PI) / 180));
  const cellY = Math.max(1, dLat * 110540);
  const dzdx = (eE - eW) / (2 * cellX);
  const dzdy = (eN - eS) / (2 * cellY);
  const slope = Math.atan(Math.hypot(dzdx, dzdy));
  const aspect = Math.atan2(dzdy, -dzdx);
  const zen = (45 * Math.PI) / 180;
  const az = (315 * Math.PI) / 180;
  const s = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
  return Math.max(0, Math.min(1, s));
}

// deterministic micro-texture so flat abyssal plains don't band
function grain(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000 - 0.5; // -0.5..0.5
}

export function paintPixel(
  buf: Uint32Array,
  i: number,
  x: number,
  y: number,
  lat: number,
  eC: number,
  eE: number,
  eW: number,
  eN: number,
  eS: number,
  dLon: number,
  dLat: number,
  mask: Uint8Array | null = null,
  maskW = 0,
  simple = false,
  coast = true,
): void {
  // water truth comes from the land/ocean mask when available: sub-sea-level
  // depressions (Caspian lowlands, Qattara, polders) stay LAND, and only
  // mask-ocean is sea. Without a mask, fall back to the elev<0 rule.
  const seaAt = (ox: number, oy: number, eV: number): boolean => {
    if (!mask) return eV < 0;
    const nx = x + ox;
    if (nx < 0 || nx >= maskW) return eV < 0;
    const ni = i + oy * maskW;
    if (ni < 0 || ni >= mask.length) return eV < 0;
    return mask[ni + ox] === 0;
  };
  const sea = seaAt(0, 0, eC);
  if (Number.isNaN(eC)) {
    // polar cap / missing data: flat near-black, no white-out
    const g = grain(x, y) * 3;
    buf[i] = pack(4 + g, 7 + g, 15 + g);
    return;
  }
  // color by water truth, not raw elevation: depressions render as lowland,
  // sub-pixel beaches as water — hover still reports true meters
  const eCol = sea ? Math.min(eC, -0.5) : Math.max(eC, 0.5);
  if (simple) {
    // zoomed-out style: 5 flat height bands, no relief/grain — categories
    // stay legible from orbit while coasts keep full vector shape
    let r: number;
    let g: number;
    let b: number;
    if (sea) {
      if (eCol < -1000) { r = 8; g = 22; b = 58; } // abyss
      else { r = 22; g = 68; b = 142; } // shelf
    } else if (eCol < 800) { r = 52; g = 55; b = 61; } // lowland
    else if (eCol < 2500) { r = 112; g = 116; b = 122; } // highland
    else { r = 150; g = 154; b = 160; } // alpine
    if (!sea) {
      if (!seaAt(1, 0, eE) || !seaAt(-1, 0, eW) || !seaAt(0, 1, eS) || !seaAt(0, -1, eN)) {
        r *= 0.55;
        g *= 0.6;
        b *= 0.58;
      }
    } else if (!seaAt(1, 0, eE) || !seaAt(-1, 0, eW) || !seaAt(0, 1, eS) || !seaAt(0, -1, eN)) {
      r = Math.min(255, r * 1.18 + 6);
      g = Math.min(255, g * 1.12 + 6);
      b = Math.min(255, b * 1.06 + 5);
    }
    buf[i] = pack(r, g, b);
    return;
  }
  let [r, g, b] = lut(eCol);
  const shade = hillshade(eC, eE, eW, eN, eS, lat, dLon, dLat);
  // subtle relief for the topography layer: gentle, never washes out
  const k = !sea ? 0.65 + 0.35 * shade : 0.6 + 0.4 * shade;

  if (!sea) {
    // crisp shoreline on the land side — off at deep zoom, where each data
    // px is huge and the accent band reads as dotted fringe
    if (coast && (!seaAt(1, 0, eE) || !seaAt(-1, 0, eW) || !seaAt(0, 1, eS) || !seaAt(0, -1, eN))) {
      r *= 0.55;
      g *= 0.6;
      b *= 0.58;
    }
  } else {
    // surf lighten at the shoreline (same LOD rule as above)
    if (coast && (!seaAt(1, 0, eE) || !seaAt(-1, 0, eW) || !seaAt(0, 1, eS) || !seaAt(0, -1, eN))) {
      r = Math.min(255, r * 1.18 + 6);
      g = Math.min(255, g * 1.12 + 6);
      b = Math.min(255, b * 1.06 + 5);
    }
  }
  const n = grain(x, y) * 5;
  buf[i] = pack(r * k + n, g * k + n, b * k + n);
}

/** Build the full-world elevation canvas. Throws when tile network fails. */
export async function buildElevationCanvas(
  quality: ElevQuality,
  onProgress?: (p: number, label: string) => void,
): Promise<{ canvas: HTMLCanvasElement; w: number; h: number; grid: GlobalGrid }> {
  const { tileZoom, w, h } = ELEV_SOURCES[quality];
  const z = tileZoom;
  const n = 2 ** z;

  onProgress?.(0.02, 'Fetching terrain tiles…');
  const list: { z: number; x: number; y: number }[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) list.push({ z, x, y });
  const ok = await fetchMany(list, 8, (done, total) =>
    onProgress?.(0.02 + (done / total) * 0.38, `Fetching terrain tiles… ${done}/${total}`),
  );
  if (ok < list.length * 0.5) throw new Error(`terrain fetch failed (${ok}/${list.length})`);

  const grid = new GlobalGrid(z);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const dLon = 360 / w;
  const dLat = 180 / h;

  onProgress?.(0.42, 'Painting bathymetry + topography…');
  const BAND = 32;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    for (let y = y0; y < Math.min(h, y0 + BAND); y++) {
      const lat = 90 - ((y + 0.5) / h) * 180;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const lon = ((x + 0.5) / w) * 360 - 180;
        const eC = grid.sample(lat, lon);
        const eE = grid.sample(lat, lon + dLon);
        const eW = grid.sample(lat, lon - dLon);
        const eN = grid.sample(Math.min(90, lat + dLat), lon);
        const eS = grid.sample(Math.max(-90, lat - dLat), lon);
        paintPixel(buf, row + x, x, y, lat, eC, eE, eW, eN, eS, dLon, dLat);
      }
    }
    onProgress?.(0.42 + (y0 / h) * 0.58, 'Painting bathymetry + topography…');
    await new Promise((r) => setTimeout(r, 0));
  }
  ctx.putImageData(img, 0, 0);
  onProgress?.(1, 'Terrain ready');
  return { canvas, w, h, grid };
}

export interface RefineBox {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
  screenPxPerDeg: number;
  baseZoom: number;
}

/**
 * Repaint a lon/lat box with higher-zoom tiles. All-or-nothing: returns false
 * (leaving the canvas untouched) unless every intersecting tile is available.
 */
export async function refineRegion(
  box: RefineBox,
  isStale: () => boolean,
  onProgress?: (p: number) => void,
): Promise<{ refined: boolean; z: number; tiles: number }> {
  const latMin = Math.max(-MAX_MERC_LAT, box.latMin);
  const latMax = Math.min(MAX_MERC_LAT, box.latMax);
  if (latMax <= latMin || box.lonMax <= box.lonMin) return { refined: false, z: 0, tiles: 0 };

  // pick zoom so tile pixels meet/exceed screen pixels (1.5× for hillshade)
  let z = Math.ceil(Math.log2(Math.max(1, ((box.screenPxPerDeg * 360) / T) * 1.5)));
  z = Math.max(box.baseZoom + 1, Math.min(MAX_REFINE_ZOOM, z));

  // shrink zoom until the tile count fits the budget
  let tx0 = 0;
  let tx1 = 0;
  let ty0 = 0;
  let ty1 = 0;
  while (z > box.baseZoom) {
    tx0 = Math.floor(lonToTileX(box.lonMin, z));
    tx1 = Math.floor(lonToTileX(box.lonMax, z));
    ty0 = Math.floor(latToTileY(latMax, z));
    ty1 = Math.floor(latToTileY(latMin, z));
    const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    if (count <= MAX_REFINE_TILES) break;
    z--;
  }
  if (z <= box.baseZoom) return { refined: false, z: 0, tiles: 0 };

  const list: { z: number; x: number; y: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      list.push({ z, x: ((tx % 2 ** z) + 2 ** z) % 2 ** z, y: Math.max(0, Math.min(2 ** z - 1, ty)) });

  await fetchMany(list, 8, (done, total) => onProgress?.(0.5 * (done / total)));
  if (isStale()) return { refined: false, z, tiles: 0 };
  // all-or-nothing: every tile must be present to avoid patchwork
  for (const t of list) if (!tileCache.get(key(t.z, t.x, t.y))) return { refined: false, z, tiles: 0 };

  // display-pixel box
  const x0 = Math.max(0, Math.floor(((box.lonMin + 180) / 360) * box.w));
  const x1 = Math.min(box.w - 1, Math.ceil(((box.lonMax + 180) / 360) * box.w));
  const y0 = Math.max(0, Math.floor(((90 - latMax) / 180) * box.h));
  const y1 = Math.min(box.h - 1, Math.ceil(((90 - latMin) / 180) * box.h));
  if (x1 <= x0 || y1 <= y0) return { refined: false, z, tiles: 0 };

  const ctx = box.canvas.getContext('2d')!;
  const W = x1 - x0 + 1;
  const H = y1 - y0 + 1;
  const img = ctx.getImageData(x0, y0, W, H);
  const buf = new Uint32Array(img.data.buffer);
  const dLon = 360 / box.w;
  const dLat = 180 / box.h;

  const sampleZ = (lat: number, lon: number): number => {
    const n = 2 ** z;
    let tx = Math.floor(lonToTileX(lon, z));
    tx = ((tx % n) + n) % n;
    const ty = Math.max(0, Math.min(n - 1, Math.floor(latToTileY(lat, z))));
    const g = tileCache.get(key(z, tx, ty));
    if (!g) return NaN;
    const px = Math.max(0, Math.min(T - 1.001, (lonToTileX(lon, z) - Math.floor(lonToTileX(lon, z))) * T));
    const py = Math.max(0, Math.min(T - 1.001, (latToTileY(lat, z) - ty) * T));
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const a = g[iy * T + ix];
    const b = g[iy * T + ix + 1];
    const c = g[(iy + 1) * T + ix];
    const d = g[(iy + 1) * T + ix + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  const BAND = 64;
  for (let yy = 0; yy < H; yy += BAND) {
    if (isStale()) return { refined: false, z, tiles: 0 };
    for (let y = yy; y < Math.min(H, yy + BAND); y++) {
      const lat = 90 - ((y0 + y + 0.5) / box.h) * 180;
      for (let x = 0; x < W; x++) {
        const lon = ((x0 + x + 0.5) / box.w) * 360 - 180;
        const eC = sampleZ(lat, lon);
        if (Number.isNaN(eC)) continue; // keep base pixel
        paintPixel(
          buf, y * W + x, x0 + x, y0 + y, lat,
          eC,
          sampleZ(lat, lon + dLon),
          sampleZ(lat, lon - dLon),
          sampleZ(Math.min(MAX_MERC_LAT, lat + dLat), lon),
          sampleZ(Math.max(-MAX_MERC_LAT, lat - dLat), lon),
          dLon, dLat,
        );
      }
    }
    onProgress?.(0.5 + 0.5 * (yy / H));
    await new Promise((r) => setTimeout(r, 0));
  }
  if (isStale()) return { refined: false, z, tiles: 0 };
  ctx.putImageData(img, x0, y0);
  return { refined: true, z, tiles: list.length };
}

export function dataXYToLonLat(x: number, y: number, w: number, h: number): { lat: number; lon: number } {
  return { lat: 90 - (y / h) * 180, lon: (x / w) * 360 - 180 };
}

export function formatElev(elev: number): string {
  const m = Math.round(elev).toLocaleString('en-US');
  return elev >= 0 ? `▲ ${m} m` : `▼ ${m} m`;
}
