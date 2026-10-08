// High-resolution equirectangular world rasterizer.
// Strategy: fetch compact vector land polygons (world-atlas TopoJSON,
// tens–hundreds of KB) and rasterize locally to a pixel buffer at
// GPU-optimal power-of-two sizes. One texture upload => 1 draw call.
// This gives "biggest resolution possible" without shipping a 100MB PNG.

import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';

export type Quality = 'low' | 'medium' | 'ultra';

export const WORLD_SOURCES: Record<Quality, { url: string; w: number; h: number; label: string }> = {
  // 110m land ≈ 108KB — instant load, chunky pixels
  low: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json',
    w: 2048,
    h: 1024,
    label: '2048 × 1024 (2.1M px)',
  },
  // 50m land ≈ 760KB — best balance, crisp per-pixel look
  medium: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json',
    w: 4096,
    h: 2048,
    label: '4096 × 2048 (8.4M px)',
  },
  // same 50m vectors, rasterized denser — max safe WebGL texture (POT)
  // 8192×4096 = 33.5M px ≈ 134MB RGBA. Desktop only.
  ultra: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json',
    w: 8192,
    h: 4096,
    label: '8192 × 4096 (33.5M px)',
  },
};

// --- fast deterministic hash noise (no Math.random per pixel) ---
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number): number {
  return (
    smoothNoise(x, y) * 0.55 +
    smoothNoise(x * 2.13 + 7.3, y * 2.13 + 3.1) * 0.28 +
    smoothNoise(x * 4.41 + 13.7, y * 4.41 + 9.2) * 0.17
  );
}

type Ring = [number, number][];
interface LandGeom {
  polygons: Ring[][];
}

function extractLand(topology: Topology, onProgress?: (p: number) => void): LandGeom {
  const obj = (topology.objects as Record<string, unknown>).land;
  // deno-lint-ignore no-explicit-any
  const geo = feature(topology as never, obj as never) as unknown as any;
  const polygons: Ring[][] = [];
  const pushPoly = (coords: number[][][]) => polygons.push(coords as Ring[]);
  if (geo.type === 'MultiPolygon') {
    for (const p of geo.coordinates) pushPoly(p);
  } else if (geo.type === 'Polygon') {
    pushPoly(geo.coordinates);
  } else if (geo.type === 'GeometryCollection') {
    for (const g of geo.geometries) {
      if (g.type === 'MultiPolygon') for (const p of g.coordinates) pushPoly(p);
      else if (g.type === 'Polygon') pushPoly(g.coordinates);
    }
  }
  onProgress?.(0.35);
  return { polygons };
}

function projectX(lon: number, w: number): number {
  return ((lon + 180) / 360) * w;
}
function projectY(lat: number, h: number): number {
  return ((90 - lat) / 180) * h;
}

/** Rasterize land polygons to a 1-byte mask. Handles antimeridian + poles. */
function rasterizeMask(
  land: LandGeom,
  w: number,
  h: number,
  onProgress?: (p: number) => void,
): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';

  const sx = w / 360;
  const sy = h / 180;

  // Draw each polygon ring as a path in pixel space.
  // Rings crossing the antimeridian (±180) are split by shifting longitudes.
  land.polygons.forEach((poly, pi) => {
    for (const ring of poly) {
      ctx.beginPath();
      let prevX: number | null = null;
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        // Clamp latitude to projection bounds (Antarctica extends to -90)
        const clat = Math.max(-90, Math.min(90, lat));
        let x = projectX(lon, w);
        const y = projectY(clat, h);
        if (prevX !== null && Math.abs(x - prevX) > w / 2) {
          // antimeridian jump: break path, continue on other side
          ctx.stroke();
          ctx.beginPath();
          // wrap x into range
          if (x - prevX > w / 2) x -= w;
          else x += w;
          ctx.moveTo(x, y);
        } else if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevX = x;
      }
      ctx.closePath();
      // nonzero winding + shifted copies cover wrap-around islands (Fiji, Russia)
      ctx.fill();
    }
    if (pi % 40 === 0) onProgress?.(0.35 + (pi / land.polygons.length) * 0.15);
  });

  // draw wrapped copies for seamless horizontal panning
  // (cheap: drawImage offsets of the mask itself — applied after fill)
  const img = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  const d = img.data;
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
  void sx;
  void sy;
  onProgress?.(0.55);
  return mask;
}

/** Pack RGB into a Uint32 (little-endian ABGR) for fast ImageData writes. */
function rgb(r: number, g: number, b: number): number {
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

// Palette (crisp pixel-art earth tones)
const OCEAN_DEEP = rgb(8, 47, 92);
const OCEAN = rgb(14, 71, 130);
const OCEAN_SHALLOW = rgb(28, 110, 178);
const BEACH = rgb(224, 203, 148);
const GRASS_D = rgb(46, 110, 52);
const GRASS = rgb(74, 148, 63);
const GRASS_L = rgb(118, 178, 80);
const STEPPE = rgb(168, 168, 96);
const DESERT = rgb(216, 188, 124);
const DESERT_D = rgb(198, 166, 100);
const ROCK = rgb(122, 110, 96);
const ROCK_D = rgb(88, 80, 72);
const SNOW = rgb(238, 244, 250);
const ICE = rgb(208, 226, 240);

function paintPixels(
  canvas: HTMLCanvasElement,
  mask: Uint8Array,
  w: number,
  h: number,
  onProgress?: (p: number) => void,
): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);

  // scale noise frequency with resolution so detail stays proportional
  const f = w / 2048;

  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    const absLat = Math.abs(lat);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const n = fbm(x * 0.012 * f, y * 0.012 * f);
      const n2 = fbm(x * 0.05 * f + 100, y * 0.05 * f + 100);
      const isLand = mask[i] === 1;

      if (!isLand) {
        // ocean: coastal lighten near land (3px kernel on mask)
        let coast = false;
        if (x > 0 && mask[i - 1]) coast = true;
        else if (x < w - 1 && mask[i + 1]) coast = true;
        else if (y > 0 && mask[i - w]) coast = true;
        else if (y < h - 1 && mask[i + w]) coast = true;
        if (coast) buf[i] = n2 > 0.5 ? OCEAN_SHALLOW : OCEAN;
        else buf[i] = n > 0.55 ? OCEAN : OCEAN_DEEP;
        // polar sea ice
        if (absLat > 72 + n * 8) buf[i] = ICE;
      } else {
        // edge => beach
        const edge =
          x === 0 || x === w - 1 || y === 0 || y === h - 1
            ? true
            : mask[i - 1] === 0 || (x < w - 1 && mask[i + 1] === 0) || mask[i - w] === 0 || mask[i + w] === 0;
        if (edge && absLat < 60) {
          buf[i] = BEACH;
        } else if (absLat > 66 + n * 10 || (lat < -58 && n > 0.35)) {
          buf[i] = n2 > 0.6 ? SNOW : ICE; // ice caps / antarctica
        } else if (absLat > 55) {
          buf[i] = n > 0.5 ? ROCK : ROCK_D; // tundra / mountains
        } else {
          const desertBand = absLat > 12 && absLat < 32 && n2 > 0.42;
          if (desertBand) buf[i] = n > 0.55 ? DESERT : DESERT_D;
          else if (n > 0.62) buf[i] = absLat > 40 ? ROCK : STEPPE;
          else if (n > 0.5) buf[i] = GRASS;
          else if (n > 0.4) buf[i] = GRASS_D;
          else buf[i] = GRASS_L;
          // high-frequency variation keeps close zooms from looking flat
          if (n2 > 0.72) buf[i] = GRASS_L;
        }
      }
    }
    if ((y & 255) === 0) onProgress?.(0.55 + (y / h) * 0.45);
  }
  ctx.putImageData(img, 0, 0);
  onProgress?.(1);
}

function proceduralFallback(w: number, h: number): Uint8Array {
  // offline fallback: value-noise super-continents (still real pixel data)
  const mask = new Uint8Array(w * h);
  const f = w / 2048;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = fbm(x * 0.006 * f, y * 0.006 * f);
      mask[y * w + x] = n > 0.52 ? 1 : 0;
    }
  }
  return mask;
}

export async function buildWorldCanvas(
  quality: Quality,
  onProgress?: (p: number, label: string) => void,
): Promise<{ canvas: HTMLCanvasElement; w: number; h: number; offline: boolean }> {
  const { url, w, h } = WORLD_SOURCES[quality];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  let mask: Uint8Array;
  let offline = false;
  try {
    onProgress?.(0.05, 'Fetching land vectors…');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onProgress?.(0.25, 'Decoding topology…');
    const topo = (await res.json()) as Topology;
    const land = extractLand(topo, (p) => onProgress?.(p, 'Decoding topology…'));
    onProgress?.(0.5, 'Rasterizing coastlines…');
    await new Promise((r) => setTimeout(r, 0)); // let UI paint
    mask = rasterizeMask(land, w, h, (p) => onProgress?.(p, 'Rasterizing coastlines…'));
  } catch {
    offline = true;
    onProgress?.(0.5, 'Offline — generating fallback…');
    mask = proceduralFallback(w, h);
  }
  onProgress?.(0.6, 'Painting pixels…');
  await new Promise((r) => setTimeout(r, 0));
  // paint in the same task; rows yield progress via callback
  paintPixels(canvas, mask, w, h, (p) => onProgress?.(p, 'Painting pixels…'));
  return { canvas, w, h, offline };
}

export function pixelToLatLon(px: number, py: number, w: number, h: number): { lat: number; lon: number } {
  const lon = (px / w) * 360 - 180;
  const lat = 90 - (py / h) * 180;
  return { lat, lon };
}
