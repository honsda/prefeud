# Prefeud — pixel map of Japan (bathymetry + topography)

Full-screen Japan (Honshu, Hokkaido, Shikoku, Kyushu + satellites, Ryukyu cut
at 30°N) rendered as individually addressable pixels. Astro + Svelte + Tailwind + PixiJS.

## Run

```sh
npm install
npm run dev
```

## How it works (virtual texture + LODs over a regional box)

- **Play region** (`src/lib/region.ts`): lon 128.5–146, lat 30–45.8. Everything —
  pyramid, tiles, underlays, overlays, hover — keys off this box, so Ryukyu
  simply doesn't exist (no mask surgery needed).
- **Elevation + bathymetry from your files** (`Documents`: 60 m DEM + GEBCO 2025):
  converted locally to Terrarium-style RGB tiles (E2 17 MB + E3 50 MB + base,
  exact int16 meters). Merge rule: DEM wins above sea level, GEBCO below —
  hover the Japan Trench for ▼ −7,125 m. Your TIFFs stay put.
- **True water:** sea is decided by land vectors (world-atlas 50m, bundled),
  never raw elevation; inland lakes from OSM detail (Biwa's 967-pt shoreline) +
  Natural Earth 50m (bundled), filled on top — NE copies covered by bundled
  detail are skipped so shorelines never double-draw. Hover still reports true
  meters. Fully offline: zero external requests at runtime.
- **Rivers as live vectors:** OSM named systems joined into continuous reaches
  (no more isolated dashes) render in a resolution-independent overlay at
  constant screen width — crisp at any zoom, never baked into pixels. Gentle
  per-view simplification keeps meanders natural at fit view too.
- **LOD honesty rules:** sub-2-tile-px lakes deferred to the level that resolves
  them; sub-6px enclosed sea specks generalized away (border-touching kept);
  shoreline accents only while pixels are small. What remains at deep zoom is
  real micro-hydrography (inlets, islets, mouths) — zoom once more and every
  dot resolves into shape.
- **Zoomed-out palette:** the base paints 5 flat height bands (abyss / shelf /
  lowland / highland / alpine, coasts intact); detail levels use the full ramp.
  Legend swaps to match.
- **Zoom-proof streaming:** chunked painter with aborts, settle + hysteresis on
  level switches, ≤2 paints in flight, ≤2 uploads/frame. Soft loading
  transitions (focus-pull, crossfades, tile fade + crisp settle).
- **Dark ambient style:** elevation → brightness with contrast where Japan's
  land actually lives (0–2500 m spread, not crushed), deep-blue oceans, no polar
  whitening. Subtle hillshade keeps island topography readable.
- **Camera:** smooth eased zoom (wheel/pinch/dblclick/Fit glide to target),
  zoom-out limited to fit, viewport clamped inside the map box — you can never
  lose the islands.
- **Settlements (right panel):** place city nodes on the map; each sprawls a
  cost-weighted Voronoi territory in two tiers: a coarse full-map solve (fixed
  max budget) picks global winners, then a viewport-native solve (1 sim px =
  1 map px at the current LOD, cell-grid-snapped and box-anchored) paints a
  flat raster fill with smooth vector borders (marching-squares + Chaikin,
  constant screen width) — the classic look, crisp at any zoom. Sea, lakes
  (any size) and big rivers (bundled detail + NE rank ≤ 2, rasterized as
  unbroken barriers) stay unpainted, exactly as drawn; minor streams bend
  growth gently with ford costs on the same drawn courses. Off-screen nodes still compete via boundary
  injection; stats and centroids are budget-filtered from the coarse distances
  (no re-solve per slider tick). Snow/peaks/deserts costly; fields and settled
  land cheap; slope + altitude penalized. Sprawl-level slider sets the
  cost-distance budget, area color + opacity are pickable, nodes are 6px rings
  with a toggleable amber centroid. The first node founds a ★ capital with
  further reach; click #id to inspect cells, supply %, and shared borders.
  A fog-of-war veil darkens everything beyond scout reach. Hover names the
  territory under the cursor. Collapsible panels both sides.
- **Settlement engine (game-ready):** heavy solves run in a Web Worker
  (`sprawl.worker.ts`, main-thread fallback) over a DOM-free session
  (`sprawlSession.ts`); node-independent cost grids cache in memory (LRU) and
  persist across sessions (IndexedDB); budget increases resume the retained
  frontier instead of re-settling; view settles re-solve only when the box
  moved. Game logic can query authoritative snapshots —
  `ownerAt(lon,lat)`, territory cells/neighbors/shared-border lengths —
  without touching render pixels.
- **Biome layer from your files** (`Documents/sengokujidai/biomes`): the v10
  uint8 ID map (60 classes) converted locally to tiny grayscale tiles
  (E0+E2+E3 ≈ 4.7 MB total — IDs ride in pixel values, NEAREST only so no fake
  classes are ever invented). Toggle Terrain|Biomes; hover names live classes
  ("Rose Field — Autumnal · Highland · Open"); legend chip list included.
  Your 140 MB TIFFs stay in Documents — only the derived pixels ship.
- Offline fallback: flat vector outline with correct region coordinates.
