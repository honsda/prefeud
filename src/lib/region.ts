// Play region: Japan's four main islands + satellites, Ryukyu excluded.
// The Ryukyu arc lies south of ~28.5°N; cutting at 30.0°N keeps Kyushu's
// southern tip (31°N), Yakushima/Tanegashima, and drops all of Ryukyu.
// Everything (pyramid, tiles, underlays, overlays, hover) keys off this box.

export const REGION = {
  lonMin: 128.5,
  lonMax: 146.0,
  latMin: 30.0,
  latMax: 45.8,
  // E0 tile grid: 5×4 of 256px → 1280×1024 (≈73×65 px/deg, near-square pixels)
  nx0: 5,
  ny0: 4,
};

export const ENGINE_TILE = 256;
export const MAX_LEVEL = 3;

export type PerfMode = 'eco' | 'balanced' | 'ultra';
export const PERF_LEVELS: Record<PerfMode, { maxLevel: number; label: string }> = {
  eco: { maxLevel: 1, label: 'Eco · up to E1' },
  balanced: { maxLevel: 2, label: 'Balanced · up to E2' },
  ultra: { maxLevel: 3, label: 'Ultra · up to E3 (~90 m/px)' },
};

export const LON_SPAN = REGION.lonMax - REGION.lonMin;
export const LAT_SPAN = REGION.latMax - REGION.latMin;

export const regionSize = (e: number) => ({
  w: REGION.nx0 * ENGINE_TILE * 2 ** e,
  h: REGION.ny0 * ENGINE_TILE * 2 ** e,
});
export const regionTiles = (e: number) => ({
  nx: REGION.nx0 * 2 ** e,
  ny: REGION.ny0 * 2 ** e,
});

// display px per degree at E0 (longitude basis)
export const PX_PER_DEG_E0 = (REGION.nx0 * ENGINE_TILE) / LON_SPAN;

/** Pick the level whose pixels best match screen pixels. */
export function levelForScreenPxPerDeg(spp: number, maxLevel: number): number {
  const e = Math.round(Math.log2(Math.max(0.5, spp / PX_PER_DEG_E0)));
  return Math.max(0, Math.min(maxLevel, e));
}

/** Terrarium source zoom oversampling a display level ~1.25×. */
export const sourceZoomForLevel = (e: number) => Math.min(e + 7, 12);

/** lon/lat bbox of a region tile. */
export function tileBounds(ez: number, ex: number, ey: number) {
  const { nx, ny } = regionTiles(ez);
  return {
    lonMin: REGION.lonMin + (ex / nx) * LON_SPAN,
    lonMax: REGION.lonMin + ((ex + 1) / nx) * LON_SPAN,
    latMax: REGION.latMax - (ey / ny) * LAT_SPAN,
    latMin: REGION.latMax - ((ey + 1) / ny) * LAT_SPAN,
  };
}

/** region-E0-px → lon/lat. */
export function lonLatOf(x: number, y: number): { lat: number; lon: number } {
  const { w, h } = regionSize(0);
  return {
    lon: REGION.lonMin + (x / w) * LON_SPAN,
    lat: REGION.latMax - (y / h) * LAT_SPAN,
  };
}

/** lon/lat → region-E0-px. */
export function xyOf(lon: number, lat: number): { x: number; y: number } {
  const { w, h } = regionSize(0);
  return {
    x: ((lon - REGION.lonMin) / LON_SPAN) * w,
    y: ((REGION.latMax - lat) / LAT_SPAN) * h,
  };
}
