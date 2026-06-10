# MuseWalk mockup (Gate A) — review package

Phone-sized (390×844) captures of every screen are in this directory:
`home.png`, `search.png`, `results.png`, `object.png`, `route.png`, `locate.png`.
They are regenerated automatically by the e2e checks suite (see below), so they
always match the committed code.

## Run it locally

```sh
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"   # Node >= 22
npm install        # once, at the repo root
npm run web        # Expo dev server → http://localhost:8081
```

Open http://localhost:8081 in a browser (it is responsive; a ~390px-wide window
matches the screenshots). Everything is clickable:

- **Home** — schematic floor map, floor switcher (1/2), tap a room for its
  object list + Directions, location chip at the bottom → Locate sheet.
- **Search** — tap the search bar; try `Monet`, `gold swords` (weak match →
  "Ask differently" LLM-interpret stub), `restroom` (amenity intent).
- **Results** — filter chips (floor / site / permanent–exhibition / has image).
- **Object** — synopsis card, ‹/› cycles objects in the same gallery,
  "Navigate here".
- **Route** — step cards (swipe or "I'm here — next step"), avoid-stairs
  toggle, "Simulate off-route fix" shows the rerouting flow, arrival state.
- **Locate** — four entry modes: gallery #, artifact lookup, photo (stub
  candidates), GPS (entrance-level only, honestly labeled).

Smoke tests + screenshot regeneration (kills nothing itself — free port 8081
first):

```sh
lsof -ti:8081 | xargs -r kill
cd e2e && npx playwright test --project=checks
```

## What is real vs stub

| Real | Stub (Phase 2 replaces) |
|---|---|
| 79 objects from the Met Open Access API (titles, artists, dates, mediums, credit lines, accessions, images, **real gallery numbers**), fetched live 2026-06-10 | Floor-plan geometry: 29 hand-drawn schematic rectangles on 2 floors — **not** the Met's real architecture (real Living Map polygons land in Phase 2) |
| Search ranking (title > artist > any-field, diacritic-insensitive), routing (Dijkstra + avoid-stairs), instruction templating — same algorithms planned for production | Routing graph: 35 hand-placed edges between room centers; distances ≈ meters but schematic |
| The `DataProvider` interface — the UI never touches stub.json directly, so swapping in met.sqlite + the server API changes no screen code | "Ask differently" interprets locally with a filler-word strip; Phase 2 calls server-side Gemini (`/api/v1/search/interpret`) |
| | Photo locate returns 3 canned candidates (labeled as such in the UI); Phase 2 = server-side label OCR + embedding retrieval |
| | GPS anchors at the Fifth Ave entrance unconditionally; Phase 2 does point-in-polygon against real geometry |

Stub data: `apps/mobile/src/data/stub.json`. 36 of 79 objects fall in the 29
drawn rooms; the rest keep their real gallery numbers, are searchable, and the
object page says "(gallery not in stub map)".

## Known gaps (honest list)

- **Met CDN images vs the prod server's COEP** — RESOLVED (gate review):
  `images.metmuseum.org` sends *no* `Access-Control-Allow-Origin` and no CORP
  header (verified live 2026-06-10), so `require-corp` would block its images.
  The server now proxies them at `GET /api/v1/img/{objectID}` (disk LRU cache
  on the Fly volume, `ACAO *` + `CORP cross-origin`); web clients use the
  proxy, native uses the CDN directly. The mockup (stub provider, no server)
  still uses plain no-cors `<img>` pointing at the CDN — see
  `apps/mobile/src/components/ObjectImage.tsx`.
- The 3 Monets in stub data have no image: the Met flags them
  `isPublicDomain: false` (no CC0 image in the API). Rows render with an empty
  thumbnail box — which is also the honest production behavior.
- Cloisters / special-exhibition / has-image filter chips filter to 0 or are
  no-ops: all stub objects are Fifth-Ave permanent collection with the Monets
  the only image-less records. The filter logic itself works.
- Ground floor (G) chip is disabled — no ground-floor stub geometry.
- The route polyline aligns with the map's default pan/zoom only; pinch/pan
  moves the map under it (Phase 2 folds the polyline into the map component).
- Route directions ("through the east door") are compass headings on the
  schematic grid, not real Met doorways.
- Location anchor is in-memory only; it resets on reload.
- Dev-server console shows react-native-svg responder-prop warnings (dev-only
  React DOM noise; LogBox toast). The production export's console is clean —
  verified against `dist` with zero console errors. Screenshots hide the
  dev-server LogBox/fast-refresh chrome via CSS; nothing app-rendered is
  altered.
