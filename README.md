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
  lose the islands. Mode swaps keep their own base canvas, so terrain always
  comes back after biome mode.
- **Biome layer from your files** (`Documents/sengokujidai/biomes`): the v10
  uint8 ID map (60 classes) converted locally to tiny grayscale tiles
  (E0+E2+E3 ≈ 4.7 MB total — IDs ride in pixel values, NEAREST only so no fake
  classes are ever invented). Toggle Terrain|Biomes; hover names live classes
  ("Rose Field — Autumnal · Highland · Open"); legend chip list included.
  Every class carries its own hue inside its family (greens stay green, waters
  stay blue — water itself pinned), so all 60 read apart at a glance.
  Your 140 MB TIFFs stay in Documents — only the derived pixels ship.
- Offline fallback: flat vector outline with correct region coordinates.
