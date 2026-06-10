# Share / link-preview assets

Source-of-truth for the social share image (`og:image`) and the app/touch
icons served from `apps/mobile/public/` (Expo's web export copies `public/`
verbatim into `dist/`, so they ship at `/share.png`, `/apple-touch-icon.png`,
`/icon-192.png`, `/icon-512.png`, `/site.webmanifest`).

The og/twitter meta itself is injected **server-side per request** with the
request origin (`server/src/meta.ts`) — never bake absolute URLs into the
export (`npm run check:origin` enforces).

## Files

- `gen-musewalk.js` — generates `musewalk-share.svg` (1200×630): real Fifth Ave
  floor-1 gallery polygons extracted from `data/snapshots/galleries.geojson`,
  a turn-by-turn route motif (Great Hall → Gallery 131, The Temple of Dendur),
  and the wordmark/tagline in `<g id="text-layer">`.
- `musewalk-share.svg` — generated, committed output (the user-approved composite).
- `musewalk-icon.svg` — hand-authored touch icon: brand-red `#e4002b` field,
  white map pin (same pin geometry as the share image). Full-bleed square;
  iOS/Android apply their own corner masks.
- `render-musewalk.js` — rasterizes both SVGs (Chromium 2× supersample →
  high-quality downscale) into `apps/mobile/public/`: `share.png` (1200×630),
  `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`.
- `rooms-screen.json` — screen-space gallery centers/bboxes for floor 1
  (same projection as the generated SVG); used to snap/verify the route
  waypoints in `gen-musewalk.js` when editing the route.

## Regenerating after a brand/text change

```sh
# 1. Edit the strings in <g id="text-layer"> inside gen-musewalk.js
#    (or the route/pin constants; icon changes go in musewalk-icon.svg).
node assets/share/gen-musewalk.js        # rewrites musewalk-share.svg
node assets/share/render-musewalk.js     # rewrites the PNGs in apps/mobile/public/
npm -w server test                       # asserts dimensions/size caps still hold
```

Commit the regenerated SVG + PNGs together. Keep `share.png` well under
300 KB (WhatsApp silently drops images over 600 KB; currently ~125 KB).

Font note: the render box lacks Georgia, so the SVG stack falls back to
Liberation Serif/Sans (metric stand-ins for the app's Georgia/Helvetica).
Rendering on a box with real Georgia will produce a slightly different (finer)
wordmark — that's expected and preferred.

If the og:title / og:description copy changes, that lives in
`server/src/meta.ts` (covered by `server/src/meta.test.ts`).
