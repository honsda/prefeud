// Tiled virtual-texture engine over the Japan region (see region.ts).
// Elevation comes from LOCAL tiles derived from the user's 60m DEM
// (public/terrain, Terrarium-style RGB encoding) — zero network after install.
// Same architecture otherwise: LOD pyramid, viewport-only tiles, smooth LINEAR
// base underlay + crisp NEAREST detail.

import {
  tileCache,
  TILE_PX,
  paintPixel,
  formatElev,
} from './elevation';
import {
  landReady,
  lakesReady,
  loadLand,
  loadLakes,
  rasterizeLandMask,
  drawLakes,
  fillLand,
  type HydroView,
} from './hydro';
import {
  REGION,
  LON_SPAN,
  LAT_SPAN,
  ENGINE_TILE,
  regionSize,
  regionTiles,
  tileBounds,
  sourceZoomForLevel,
} from './region';

export { formatElev };
// E0 = 5×4 tiles of 256px (1280×1024); stage 1 is a small instant preview
const STAGE1_W = 640;
const STAGE1_H = Math.round((STAGE1_W * LAT_SPAN) / LON_SPAN);

// ---------------------------------------------------------------------------
// IndexedDB persistent cache for decoded source grids (survives reloads,
// enables offline revisits). Memory layer stays tileCache in elevation.ts.
// ---------------------------------------------------------------------------
const IDB_NAME = 'prefeud-terrain-v2'; // v2: grids now carry real bathymetry
let idb: IDBDatabase | null = null;
let idbFailed = false;

function openIdb(): Promise<IDBDatabase | null> {
  if (idb) return Promise.resolve(idb);
  if (idbFailed || typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('grids');
      req.onsuccess = () => {
        idb = req.result;
        resolve(idb);
      };
      req.onerror = () => {
        idbFailed = true;
        resolve(null);
      };
    } catch {
      idbFailed = true;
      resolve(null);
    }
  });
}

async function idbGet(k: string): Promise<Float32Array | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('grids', 'readonly');
      const rq = tx.objectStore('grids').get(k);
      rq.onsuccess = () => {
        const v = rq.result as Float32Array | ArrayBuffer | undefined;
        if (!v) return resolve(null);
        resolve(v instanceof Float32Array ? v : new Float32Array(v));
      };
      rq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(k: string, grid: Float32Array): void {
  // fire-and-forget; quota errors must never break rendering
  openIdb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction('grids', 'readwrite');
      tx.objectStore('grids').put(grid.slice(), k);
    } catch {
      /* ignore */
    }
  });
}

/** Local DEM tile (pre-rendered from the 60m source, same folder as the app). */
const localUrl = (e: number, x: number, y: number) =>
  `${import.meta.env.BASE_URL}terrain/elev/${e}/${x}/${y}.png?v=2`;

/** Local DEM tile with memory → IDB → file fallback. Populates both caches. */
export async function getLocalTile(e: number, x: number, y: number): Promise<Float32Array | null> {
  const { nx, ny } = regionTiles(e);
  if (x < 0 || x >= nx || y < 0 || y >= ny) return null;
  const k = localKey(e, x, y);
  const mem = tileCache.get(k);
  if (mem) return mem;
  const disk = await idbGet(k);
  if (disk) {
    tileCache.set(k, disk);
    return disk;
  }
  try {
    const res = await fetch(localUrl(e, x, y));
    if (!res.ok) return null;
    const decoded = await decodeGrid(await res.blob());
    const grid = decoded ? decoded.grid : null;
    if (grid) {
      if (tileCache.size > 640) {
        const first = tileCache.keys().next();
        if (!first.done) tileCache.delete(first.value);
      }
      tileCache.set(k, grid);
      idbPut(k, grid);
    }
    return grid;
  } catch {
    return null;
  }
}

/** Equirectangular projection into a source level's global pixel space. */
function localProj(sz: number) {
  const { nx, ny } = regionTiles(sz);
  return {
    x: (lon: number) => ((lon - REGION.lonMin) / LON_SPAN) * nx * TILE_PX,
    y: (lat: number) => ((REGION.latMax - lat) / LAT_SPAN) * ny * TILE_PX,
    nx,
    ny,
  };
}
const localKey = (e: number, x: number, y: number) => `L${e}/${x}/${y}`;

/** Decode any-size PNG blob to a Float32 elevation grid (row-major). */
async function decodeGrid(blob: Blob): Promise<{ grid: Float32Array; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const n = c.width * c.height;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    }
    return { grid: out, w: c.width, h: c.height };
  } catch {
    return null;
  }
}

async function eachLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const t = items[i++];
      await fn(t);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Fast scanline painter (projection hoisted to row/column tables; chunked
// yields keep input smooth; stale paints abort). See prior revision notes.
// ---------------------------------------------------------------------------
type Sampler = (gx: number, gy: number) => number;

function makeSampler(
  grids: (Float32Array | null)[][],
  sx0: number,
  sy0: number,
  wrapX = 0,
): Sampler {
  const rows = grids.length;
  const cols = grids[0].length;
  const read = (ix: number, iy: number): number => {
    const qx = Math.floor(ix / TILE_PX);
    const qy = Math.floor(iy / TILE_PX);
    let rx = qx - sx0;
    const ry = qy - sy0;
    if (wrapX > 0) rx = ((rx % wrapX) + wrapX) % wrapX;
    if (rx < 0 || rx >= cols || ry < 0 || ry >= rows) return NaN;
    const gr = grids[ry][rx];
    if (!gr) return NaN;
    const lx = ix - qx * TILE_PX;
    const ly = iy - qy * TILE_PX;
    if (lx < 0 || lx >= TILE_PX || ly < 0 || ly >= TILE_PX) return NaN;
    return gr[ly * TILE_PX + lx];
  };
  return (gx, gy) => {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = read(x0, y0);
    const b = read(x0 + 1, y0);
    const c = read(x0, y0 + 1);
    const d = read(x0 + 1, y0 + 1);
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
      if (!Number.isNaN(a)) return a;
      if (!Number.isNaN(b)) return b;
      if (!Number.isNaN(c)) return c;
      return d;
    }
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

async function renderEquirect(
  w: number,
  h: number,
  lonOf: (x: number) => number,
  latOf: (y: number) => number,
  xOff: number,
  yOff: number,
  sampler: Sampler,
  proj: { x(lon: number): number; y(lat: number): number; kx: number },
  dLon: number,
  dLat: number,
  mask: Uint8Array | null,
  simple: boolean,
  coast: boolean,
  isStale?: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);

  const gxC = new Float64Array(w);
  for (let x = 0; x < w; x++) gxC[x] = proj.x(lonOf(x));
  const gyR = new Float64Array(h);
  const gyN = new Float64Array(h);
  const gyS = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const lat = latOf(y);
    gyR[y] = proj.y(lat);
    gyN[y] = proj.y(lat + dLat);
    gyS[y] = proj.y(lat - dLat);
  }
  const kx = proj.kx;

  const BAND = 32;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    if (isStale?.()) return null;
    for (let y = y0; y < Math.min(h, y0 + BAND); y++) {
      const lat = latOf(y);
      const gy = gyR[y];
      const gyNn = gyN[y];
      const gySs = gyS[y];
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const gx = gxC[x];
        paintPixel(
          buf, row + x, xOff + x, yOff + y, lat,
          sampler(gx, gy),
          sampler(gx + kx, gy),
          sampler(gx - kx, gy),
          sampler(gx, gyNn),
          sampler(gx, gySs),
          dLon, dLat,
          mask, w,
          simple,
          coast,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Views: region-px mappings shared by painter, mask, lakes, rivers.
// ---------------------------------------------------------------------------
function tileView(ez: number, ex: number, ey: number): HydroView & { W: number; H: number } {
  const S = ENGINE_TILE;
  const { w: W, h: H } = regionSize(ez);
  const b = tileBounds(ez, ex, ey);
  return {
    w: S, h: S, W, H,
    xOf: (lon) => ((lon - REGION.lonMin) / LON_SPAN) * W - ex * S,
    yOf: (lat) => ((REGION.latMax - lat) / LAT_SPAN) * H - ey * S,
    lonMin: b.lonMin, lonMax: b.lonMax, latMin: b.latMin, latMax: b.latMax,
  };
}

function fullView(w: number, h: number): HydroView {
  return {
    w, h,
    xOf: (lon) => ((lon - REGION.lonMin) / LON_SPAN) * w,
    yOf: (lat) => ((REGION.latMax - lat) / LAT_SPAN) * h,
    lonMin: REGION.lonMin, lonMax: REGION.lonMax,
    latMin: REGION.latMin, latMax: REGION.latMax,
  };
}

// ---------------------------------------------------------------------------
// Detail tile painter (256×256). Source-zoom fallback: coarser-but-real data
// always beats a hole.
// ---------------------------------------------------------------------------
export async function paintTile(
  ez: number,
  ex: number,
  ey: number,
  isStale?: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const S = ENGINE_TILE;
  const { nx, ny } = regionTiles(ez);
  if (ex < 0 || ex >= nx || ey < 0 || ey >= ny) return null;
  const b = tileBounds(ez, ex, ey);

  const { w: W, h: H } = regionSize(ez);
  const dLon = LON_SPAN / W;
  const dLat = LAT_SPAN / H;

  // Display levels sample local DEM files: E1 downsamples E2, E2/E3 sample
  // their own level. Fallback steps one level down (coarser-but-real wins).
  const szTop = Math.max(2, ez);
  const g = 2 * Math.max(dLon, dLat);
  try {
  for (let sz = szTop; sz >= 2; sz--) {
    const sn = regionTiles(sz);
    const proj = localProj(sz);
    // NOTE: proj returns global SOURCE PIXELS — divide to tile indices
    const sx0 = Math.max(0, Math.floor(proj.x(b.lonMin - g) / TILE_PX));
    const sx1 = Math.min(sn.nx - 1, Math.floor(proj.x(b.lonMax + g) / TILE_PX));
    const sy0 = Math.max(0, Math.floor(proj.y(Math.min(90, b.latMax + g)) / TILE_PX));
    const sy1 = Math.min(sn.ny - 1, Math.floor(proj.y(Math.max(-90, b.latMin - g)) / TILE_PX));
    if (sx0 > sx1 || sy0 > sy1) continue; // empty range: graceful skip, never throw

    const needed: { x: number; y: number }[] = [];
    for (let yy = sy0; yy <= sy1; yy++)
      for (let xx = sx0; xx <= sx1; xx++)
        needed.push({ x: xx, y: yy });
    if (needed.length > 48) continue;

    await eachLimit(needed, 6, async (t) => {
      await getLocalTile(sz, t.x, t.y);
    });
    const grids: (Float32Array | null)[][] = [];
    for (let yy = sy0; yy <= sy1; yy++) {
      const row: (Float32Array | null)[] = [];
      for (let xx = sx0; xx <= sx1; xx++) {
        row.push(tileCache.get(localKey(sz, xx, yy)) ?? null);
      }
      grids.push(row);
    }
    if (grids.flat().some((gr) => !gr)) continue;

    const view = tileView(ez, ex, ey);
    const mask = landReady() ? rasterizeLandMask(view) : null;
    const sampler = makeSampler(grids, sx0, sy0);
    const canvas = await renderEquirect(
      S, S,
      (x) => REGION.lonMin + ((ex * S + x + 0.5) / W) * LON_SPAN,
      (y) => REGION.latMax - ((ey * S + y + 0.5) / H) * LAT_SPAN,
      ex * S, ey * S,
      sampler,
      { x: proj.x, y: proj.y, kx: (dLon / LON_SPAN) * sn.nx * TILE_PX },
      dLon, dLat,
      mask,
      false, // detail tiles keep the full dark-ambient ramp
      ez < 2, // shoreline accents only while pixels are small
      isStale,
    );
    if (!canvas) return null;
    // inland lakes bake in (areas suit pixels); rivers render as a live
    // vector overlay instead (see redrawRivers) so they never pixelate
    drawLakes(canvas.getContext('2d')!, view, 99);
    return canvas;
  }
  } catch (e) {
    console.error(`paintTile E${ez} ${ex}/${ey} failed:`, e);
    return null;
  }
  return null;
}

import biomeLegend from '../assets/biome-legend.json';

// ---------------------------------------------------------------------------
// Biome layer: categorical IDs painted with the legend palette (flat +
// boundary definition). Separate caches/grids; tiles + base mirror the
// elevation pipeline. See region.ts for the play box.
// ---------------------------------------------------------------------------
interface BundledLegend {
  [k: string]: { name?: string; comp?: string[]; color?: [number, number, number] };
}
const BIOME_LUT: [number, number, number][] = [];
for (let i = 0; i <= 60; i++) {
  const e = (biomeLegend as unknown as BundledLegend)[String(i)];
  BIOME_LUT[i] = e?.color ?? [63, 67, 75];
}
export interface BiomeInfo {
  name: string;
  comp: string[];
}
export function biomeInfo(id: number): BiomeInfo {
  const e = (biomeLegend as unknown as BundledLegend)[String(id)];
  return { name: e?.name ?? 'Unknown', comp: e?.comp ?? [] };
}
export const BIOME_LIST: { id: number; name: string; color: [number, number, number] }[] = [];
for (let i = 0; i <= 60; i++) {
  const info = biomeInfo(i);
  BIOME_LIST.push({ id: i, name: info.name, color: BIOME_LUT[i] });
}

// Display mode: false = elevation ramp, true = biome categories.
let biomeModeOn = false;
export function setBiomeMode(b: boolean): void {
  biomeModeOn = b;
}
export function isBiomeMode(): boolean {
  return biomeModeOn;
}

// Uint8 ID grids (categorical — never interpolated).
const biomeCache = new Map<string, Uint8Array>();
const bioUrl = (e: number, x: number, y: number) =>
  `${import.meta.env.BASE_URL}terrain/bio/${e}/${x}/${y}.png`;

export async function getBiomeTile(e: number, x: number, y: number): Promise<Uint8Array | null> {
  const { nx, ny } = regionTiles(e);
  if (x < 0 || x >= nx || y < 0 || y >= ny) return null;
  const k = `B${e}/${x}/${y}`;
  const hit = biomeCache.get(k);
  if (hit) return hit;
  try {
    const res = await fetch(bioUrl(e, x, y));
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4]; // R == G == B == id
    if (biomeCache.size > 192) {
      const first = biomeCache.keys().next();
      if (!first.done) biomeCache.delete(first.value);
    }
    biomeCache.set(k, out);
    return out;
  } catch {
    return null;
  }
}

/** Nearest sampler over stitched Uint8 ID grids (stride = tile px, usually 256). */
function makeNearSampler(
  grids: (Uint8Array | null)[][],
  sx0: number,
  sy0: number,
  stride: number,
): (gx: number, gy: number) => number {
  const rows = grids.length;
  const cols = grids[0].length;
  return (gx, gy) => {
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const qx = Math.floor(ix / stride);
    const qy = Math.floor(iy / stride);
    const gr = grids[qy - sy0]?.[qx - sx0];
    if (!gr) return -1;
    const lx = ix - qx * stride;
    const ly = iy - qy * stride;
    if (lx < 0 || lx >= stride || ly < 0 || ly >= stride) return -1;
    return gr[ly * stride + lx];
  };
}

async function renderBiome(
  w: number,
  h: number,
  lonOf: (x: number) => number,
  latOf: (y: number) => number,
  sampler: (gx: number, gy: number) => number,
  proj: { x(lon: number): number; y(lat: number): number },
  stepX: number,
  stepY: number,
  isStale?: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const gxC = new Float64Array(w);
  for (let x = 0; x < w; x++) gxC[x] = proj.x(lonOf(x));
  const gyR = new Float64Array(h);
  for (let y = 0; y < h; y++) gyR[y] = proj.y(latOf(y));
  const pack = (r: number, g: number, b: number) => (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
  const BAND = 64;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    if (isStale?.()) return null;
    for (let y = y0; y < Math.min(h, y0 + BAND); y++) {
      const gy = gyR[y];
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const gx = gxC[x];
        const id = sampler(gx, gy) | 0;
        const c = BIOME_LUT[Math.max(0, Math.min(60, id))] || BIOME_LUT[0];
        let r = c[0];
        let g = c[1];
        let b = c[2];
        // darken where the west/north neighbor differs: biome boundaries read
        if (sampler(gx - stepX, gy) !== id || sampler(gx, gy - stepY) !== id) {
          r *= 0.68;
          g *= 0.68;
          b *= 0.68;
        }
        buf[row + x] = pack(r, g, b);
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export async function paintBiomeTile(
  ez: number,
  ex: number,
  ey: number,
  isStale?: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const S = ENGINE_TILE;
  const { nx, ny } = regionTiles(ez);
  if (ex < 0 || ex >= nx || ey < 0 || ey >= ny) return null;
  const b = tileBounds(ez, ex, ey);
  const { w: W, h: H } = regionSize(ez);
  const szTop = Math.max(2, ez);
  const gDeg = 0.02;
  for (let sz = szTop; sz >= 2; sz--) {
    const sn = regionTiles(sz);
    const proj = localProj(sz);
    const sx0 = Math.max(0, Math.floor(proj.x(b.lonMin - gDeg) / TILE_PX));
    const sx1 = Math.min(sn.nx - 1, Math.floor(proj.x(b.lonMax + gDeg) / TILE_PX));
    const sy0 = Math.max(0, Math.floor(proj.y(b.latMax + gDeg) / TILE_PX));
    const sy1 = Math.min(sn.ny - 1, Math.floor(proj.y(b.latMin - gDeg) / TILE_PX));
    if (sx0 > sx1 || sy0 > sy1) continue;
    const needed: { x: number; y: number }[] = [];
    for (let yy = sy0; yy <= sy1; yy++)
      for (let xx = sx0; xx <= sx1; xx++)
        needed.push({ x: xx, y: yy });
    if (needed.length > 48) continue;
    await eachLimit(needed, 6, async (t) => {
      await getBiomeTile(sz, t.x, t.y);
    });
    const grids: (Uint8Array | null)[][] = [];
    for (let yy = sy0; yy <= sy1; yy++) {
      const row: (Uint8Array | null)[] = [];
      for (let xx = sx0; xx <= sx1; xx++) row.push(biomeCache.get(`B${sz}/${xx}/${yy}`) ?? null);
      grids.push(row);
    }
    if (grids.flat().some((gr) => !gr)) continue;
    const sampler = makeNearSampler(grids, sx0, sy0, TILE_PX);
    // source px per display px (E1 downsamples E2 → 2; same level → 1)
    const stepX = sn.nx / nx;
    const stepY = sn.ny / ny;
    return renderBiome(
      S, S,
      (x) => REGION.lonMin + ((ex * S + x + 0.5) / W) * LON_SPAN,
      (y) => REGION.latMax - ((ey * S + y + 0.5) / H) * LAT_SPAN,
      sampler,
      proj,
      stepX,
      stepY,
      isStale,
    );
  }
  return null;
}

let baseBiome: Uint8Array | null = null;

/** Ensure the biome ID grid is decoded (cheap one-time local fetch).
 *  biobase.png ships at half E0 resolution (≈34 KB) and is nearest-upscaled
 *  to full E0 here, so every consumer keeps exact-size indexing. */
export async function ensureBiomeGrid(): Promise<Uint8Array | null> {
  if (baseBiome) return baseBiome;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}terrain/biobase.png`);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx0 = c.getContext('2d', { willReadFrequently: true })!;
    ctx0.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx0.getImageData(0, 0, c.width, c.height).data;
    const raw = new Uint8Array(c.width * c.height);
    for (let i = 0; i < raw.length; i++) raw[i] = d[i * 4];
    const { w: W, h: H } = regionSize(0);
    if (c.width === W && c.height === H) {
      baseBiome = raw;
      return raw;
    }
    // half-res source: nearest-upscale to E0 (IDs are categorical)
    const sx = W / c.width;
    const sy = H / c.height;
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || sx < 1 || sy < 1) return null;
    const grid = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const sy0 = Math.min(c.height - 1, Math.floor(y / sy));
      for (let x = 0; x < W; x++) grid[y * W + x] = raw[sy0 * c.width + Math.min(c.width - 1, Math.floor(x / sx))];
    }
    baseBiome = grid;
    return grid;
  } catch {
    return null;
  }
}

export async function buildBiomeBase(): Promise<HTMLCanvasElement | null> {
  const grid = await ensureBiomeGrid();
  const { w: W, h: H } = regionSize(0);
  if (!grid || grid.length !== W * H) return null;
  const sampler = (gx: number, gy: number): number => {
    const ix = Math.max(0, Math.min(W - 1, Math.floor(gx)));
    const iy = Math.max(0, Math.min(H - 1, Math.floor(gy)));
    return grid[iy * W + ix];
  };
  const proj = localProj(0);
  return renderBiome(
    W, H,
    (x) => REGION.lonMin + ((x + 0.5) / W) * LON_SPAN,
    (y) => REGION.latMax - ((y + 0.5) / H) * LAT_SPAN,
    sampler,
    proj,
    1,
    1,
  );
}

/** Biome id + name at a point from the finest cached grid. */
export function sampleBiome(lat: number, lon: number): { id: number; name: string } | null {
  if (lon < REGION.lonMin || lon > REGION.lonMax || lat < REGION.latMin || lat > REGION.latMax)
    return null;
  for (const e of [3, 2]) {
    const { nx, ny } = regionTiles(e);
    const gx = ((lon - REGION.lonMin) / LON_SPAN) * nx * TILE_PX;
    const gy = ((REGION.latMax - lat) / LAT_SPAN) * ny * TILE_PX;
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
    const g = biomeCache.get(`B${e}/${tx}/${ty}`);
    if (!g) continue;
    const lx = Math.max(0, Math.min(TILE_PX - 1, Math.floor(gx - tx * TILE_PX)));
    const ly = Math.max(0, Math.min(TILE_PX - 1, Math.floor(gy - ty * TILE_PX)));
    const id = g[ly * TILE_PX + lx];
    return { id, name: biomeInfo(id).name };
  }
  if (baseBiome) {
    const { w, h } = regionSize(0);
    const ix = Math.max(0, Math.min(w - 1, Math.floor(((lon - REGION.lonMin) / LON_SPAN) * w)));
    const iy = Math.max(0, Math.min(h - 1, Math.floor(((REGION.latMax - lat) / LAT_SPAN) * h)));
    const id = baseBiome[iy * w + ix];
    return { id, name: biomeInfo(id).name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Base underlay: single fast build from the local pre-rendered base grid
// (E0-size, exact meters). No network, no staging — first paint in ~1s.
// ---------------------------------------------------------------------------
/** Bilinear sampler over one full-size grid (edge-clamped). */
function makeGridSampler(grid: Float32Array, w: number, h: number): Sampler {
  const at = (ix: number, iy: number): number => {
    const x = Math.max(0, Math.min(w - 1, ix));
    const y = Math.max(0, Math.min(h - 1, iy));
    return grid[y * w + x];
  };
  return (gx, gy) => {
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

let baseGrid: Float32Array | null = null;

export function getBaseGrid(): Float32Array | null {
  return baseGrid;
}
export function getBaseBiome(): Uint8Array | null {
  return baseBiome;
}

const gateTimeout = (ms: number) => new Promise<null>((res) => setTimeout(() => res(null), ms));

export async function buildBaseUnderlay(
  onProgress?: (p: number) => void,
): Promise<{ canvas: HTMLCanvasElement; masked: boolean } | null> {
  onProgress?.(0.05);
  // wait briefly for the land mask so base + tiles share true coasts
  // (bounded: slow networks fall back to the elev rule, still correct here)
  await Promise.race([loadLand().then(() => true).catch(() => false), gateTimeout(6000)]);
  let decoded: { grid: Float32Array; w: number; h: number } | null = null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}terrain/base.png?v=2`);
    if (!res.ok) return null;
    decoded = await decodeGrid(await res.blob());
  } catch {
    return null;
  }
  if (!decoded) return null;
  const { w: W, h: H } = regionSize(0);
  if (decoded.w !== W || decoded.h !== H) return null; // size drift guard
  onProgress?.(0.3);
  baseGrid = decoded.grid;
  const sampler = makeGridSampler(baseGrid, decoded.w, decoded.h);
  const view = fullView(W, H);
  const mask = landReady() ? rasterizeLandMask(view) : null;
  const proj = localProj(0);
  const canvas = await renderEquirect(
    W, H,
    (x) => REGION.lonMin + ((x + 0.5) / W) * LON_SPAN,
    (y) => REGION.latMax - ((y + 0.5) / H) * LAT_SPAN,
    0, 0,
    sampler,
    { x: proj.x, y: proj.y, kx: (proj.nx * TILE_PX) / W },
    LON_SPAN / W, LAT_SPAN / H,
    mask,
    true, // zoomed-out base: 5 flat height bands, shape intact
    true,
  );
  if (!canvas) return null;
  drawLakes(canvas.getContext('2d')!, view, 99);
  onProgress?.(1);
  return { canvas, masked: mask !== null };
}

/** Offline fallback: flat vector landmass with correct region coordinates. */
export async function paintVectorFallback(): Promise<HTMLCanvasElement | null> {
  if (!landReady()) return null;
  const W = 700;
  const H = Math.round((W * LAT_SPAN) / LON_SPAN);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#060b16';
  ctx.fillRect(0, 0, W, H);
  const view = fullView(W, H);
  if (!fillLand(ctx, view, '#3f434b')) return null;
  return canvas; // rivers come from the live overlay, even offline
}

// ---------------------------------------------------------------------------
// Painted-tile LRU (CPU canvases). GPU textures are owned by the renderer
// and destroyed on evict — GPU holds only the visible set.
// ---------------------------------------------------------------------------
const PAINTED_CAP = 96;
const painted = new Map<string, HTMLCanvasElement>();
export const engineKey = (ez: number, ex: number, ey: number) => `${ez}/${ex}/${ey}`;

export async function getTileCanvas(
  ez: number,
  ex: number,
  ey: number,
  isStale?: () => boolean,
): Promise<HTMLCanvasElement | null> {
  const k = engineKey(ez, ex, ey);
  const hit = painted.get(k);
  if (hit) {
    painted.delete(k);
    painted.set(k, hit);
    return hit;
  }
  const c = biomeModeOn
    ? await paintBiomeTile(ez, ex, ey, isStale)
    : await paintTile(ez, ex, ey, isStale);
  if (c) {
    if (painted.size >= PAINTED_CAP) {
      const first = painted.keys().next();
      if (!first.done) painted.delete(first.value);
    }
    painted.set(k, c);
  }
  return c;
}

export function clearPaintedCache(): void {
  painted.clear();
}

/** Fill lakes onto a region base canvas (additive). */
export function paintLakesOntoBase(canvas: HTMLCanvasElement): boolean {
  const W = canvas.width;
  const H = canvas.height;
  drawLakes(canvas.getContext('2d')!, fullView(W, H), 1);
  return true;
}

/** Raw elevation sample from the finest cached grid (null if none covers it). */
export function sampleElevAt(lat: number, lon: number): { elev: number; level: number } | null {
  if (lon < REGION.lonMin || lon > REGION.lonMax || lat < REGION.latMin || lat > REGION.latMax) return null;
  const bilin = (g: Float32Array, px: number, py: number, w: number, h: number): number => {
    const x0 = Math.max(0, Math.min(w - 1.001, px));
    const y0 = Math.max(0, Math.min(h - 1.001, py));
    const ix = Math.floor(x0);
    const iy = Math.floor(y0);
    const fx = x0 - ix;
    const fy = y0 - iy;
    const a = g[iy * w + ix];
    const b = g[iy * w + ix + 1];
    const c = g[(iy + 1) * w + ix];
    const d = g[(iy + 1) * w + ix + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  for (const e of [3, 2]) {
    const { nx, ny } = regionTiles(e);
    const gx = ((lon - REGION.lonMin) / LON_SPAN) * nx * TILE_PX;
    const gy = ((REGION.latMax - lat) / LAT_SPAN) * ny * TILE_PX;
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
    const g = tileCache.get(localKey(e, tx, ty));
    if (!g) continue;
    return { elev: bilin(g, gx - tx * TILE_PX, gy - ty * TILE_PX, TILE_PX, TILE_PX), level: e };
  }
  if (baseGrid) {
    const { w, h } = regionSize(0);
    return {
      elev: bilin(
        baseGrid,
        ((lon - REGION.lonMin) / LON_SPAN) * w,
        ((REGION.latMax - lat) / LAT_SPAN) * h,
        w, h,
      ),
      level: 0,
    };
  }
  return null;
}

/** Raw biome id sample from the finest cached grid (null if none covers it). */
export function sampleBiomeAt(lat: number, lon: number): { id: number; level: number } | null {
  if (lon < REGION.lonMin || lon > REGION.lonMax || lat < REGION.latMin || lat > REGION.latMax) return null;
  for (const e of [3, 2]) {
    const { nx, ny } = regionTiles(e);
    const gx = ((lon - REGION.lonMin) / LON_SPAN) * nx * TILE_PX;
    const gy = ((REGION.latMax - lat) / LAT_SPAN) * ny * TILE_PX;
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
    const g = biomeCache.get(`B${e}/${tx}/${ty}`);
    if (!g) continue;
    const lx = Math.max(0, Math.min(TILE_PX - 1, Math.floor(gx - tx * TILE_PX)));
    const ly = Math.max(0, Math.min(TILE_PX - 1, Math.floor(gy - ty * TILE_PX)));
    return { id: g[ly * TILE_PX + lx], level: e };
  }
  if (baseBiome) {
    const { w, h } = regionSize(0);
    const ix = Math.max(0, Math.min(w - 1, Math.floor(((lon - REGION.lonMin) / LON_SPAN) * w)));
    const iy = Math.max(0, Math.min(h - 1, Math.floor(((REGION.latMax - lat) / LAT_SPAN) * h)));
    return { id: baseBiome[iy * w + ix], level: 0 };
  }
  return null;
}

/** Best-available elevation from cached local grids (hover readout). */
export function sampleAny(lat: number, lon: number): { elev: number; z: number } | null {
  const s = sampleElevAt(lat, lon);
  return s ? { elev: s.elev, z: s.level } : null;
}
