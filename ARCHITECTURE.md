# Architecture

MuseWalk (an unofficial companion app): indoor navigation + collection search for the Metropolitan Museum
of Art (Fifth Avenue + The Cloisters). One npm-workspaces monorepo, one deployed
artifact (Fly.io app = static Expo web export + Node API server), one data
artifact (`met.sqlite`) that every client downloads and queries locally.

This file is updated in the same commit as any structural change.

## System diagram

```
                Met Open Access API          Living Map endpoints (one-time ETL,
                (official, CC0)              raw tiles committed in data/raw/)
                       │                                  │
                       ▼                                  ▼
   data/src/objects.ts ──► objects.json.gz   data/src/geometry.ts ─► galleries/amenities/routes.geojson
   data/src/synonyms.ts ─► synonyms.json     data/src/graph.ts ────► graph.json (nodes/edges/doors)
                       └────────────┬─────────────────────┘
                                    ▼
                       data/src/build-db.ts ──► data/met.sqlite  (objects + FTS5 + galleries +
                                    │            amenities + graph + geojson blobs; one file)
                                    │            ETag = data/VERSION
        ┌───────────────────────────┴───────────────────────────────┐
        ▼                                                           ▼
server/ (Node + Hono, Fly.io)                          apps/mobile (Expo SDK 56, web/iOS/Android)
  GET  /api/v1/data/version · /data/met.sqlite ───────►  downloads met.sqlite once, caches it,
  GET  /api/v1/img/{objectID}   (image proxy + LRU)      re-downloads only on version change
  POST /api/v1/search/interpret (Gemini, server-only)    ALL search / map / routing / positioning
  POST /api/v1/locate/photo     (OCR ∥ embedding)        run on-device against the local file
  POST /api/v1/admin/refresh    (Bearer ADMIN_TOKEN)     (offline after first load; only LLM,
  GET  /api/v1/health                                     images and refresh need the network)
  nightly self-refresh: Met delta → rebuild → atomic swap
```

The OpenAPI contract `shared/openapi.yaml` (generated types:
`shared/api-types.d.ts`) is the **only** client↔server surface; the seven
routes above are the entire dynamic API. Everything else — autocomplete, full
search, the floor-plan map, Dijkstra routing, positioning fusion — is
client-local code in `shared/` and `apps/mobile/` running against the
downloaded database.

## The one artifact: met.sqlite

Design rule (user-locked): **no client/server index fragmentation**. A single
SQLite file is the source of truth; the server's only relationship to search is
(a) serving the file and (b) holding its own copy to execute LLM-rewritten
queries and validate photo matches.

Tables (built by `data/src/build-db.ts`):

- `objects` — on-view rows (45.5k at full hydration): objectID, accession,
  title, artist, culture, period, classification, medium, tags, synonyms,
  galleryNumber, site (`fifthAve|cloisters`), rotation
  (`permanent|exhibition`), isHighlight, imageUrl, metadataDate.
- `objects_fts` — FTS5 external-content index, `porter unicode61`,
  `prefix='2 3 4'`, over (title, artist, culture, classification, medium, tags,
  synonyms) with query-time weights `bm25(objects_fts,10,8,3,5,2,4,1)`.
  The `synonyms` column is index-time LLM vocabulary expansion
  (`data/src/synonyms.ts`, one-time ≈$0.30): "katana"→"samurai sword",
  culture translations, antiquities nicknames — recall fixed before any
  query-time LLM is involved.
- `vocab(id, term UNIQUE, df)` + `vocab_trigram` — typo-correction vocabulary
  (~24k distinct searchable tokens + multi-word artist names, diacritics
  folded, with document frequency) and its FTS5 `trigram` index
  (`detail=column`). Feeds the fuzzy autocomplete fallback in
  `shared/search.ts` (+1.7 MB raw / +0.9 MB gzip; see docs/SEARCH.md).
- `galleries(galleryNumber, site, …)` / `amenities` — centroids, floors,
  titles for 463 gallery polygons + 125 amenities.
- `graph_nodes` / `graph_edges` — the routing graph (2,125 nodes / 8,096 edges:
  door, walk, stairs, elevator) derived from Living Map walking linestrings.
- `blobs` — gzipped `galleries.geojson` (room polygons), `amenities.geojson`,
  `routes.geojson`; the map renders entirely from these.
- `meta` — dataVersion etc.

Size: ~32 MB raw / ~10 MB gzip at full 45.5k scale (measured on the interim
full-scale build); the committed snapshot is partial until the in-flight
hydration completes (see Data provenance below).

### How clients get it

`apps/mobile/src/data/DataGate.tsx:DataGate` gates the app: open local copy
first (never blocks on the network), first-run download with a retry screen,
then a fire-and-forget `GET /api/v1/data/version` poll → ETag re-download → hot
swap → persist. The platform seam is `./sqlite`:

- native (`apps/mobile/src/data/sqlite.ts`): expo-sqlite,
  `deserializeDatabaseAsync` + backup-API persist into the document directory.
- web (`apps/mobile/src/data/sqlite.web.ts`): official
  `@sqlite.org/sqlite-wasm`, main-thread in-memory via `sqlite3_deserialize`,
  raw bytes persisted in Cache Storage. **Why not expo-sqlite web** (its wasm
  backend was the plan's flagged alpha risk, and it failed measurement): the
  vendored wa-sqlite.wasm ships **without FTS5**, and its sync worker bridge
  truncates result lengths mod 256 (any sync result >255 bytes is corrupt;
  reproduced and patched locally to confirm, present through
  56.0.5-canary). The official wasm build has FTS5+porter, is natively
  synchronous, and needs no SharedArrayBuffer. Same bytes, same SQL, same
  provider code — exactly the fallback the plan reserved.

Both export the `MetDb` contract (`apps/mobile/src/data/sqlite.ts:MetDb`,
`tryOpenLocal`, `downloadDb`, `fetchServerVersion`).

## Client data layer

`apps/mobile/src/data/provider.ts:DataProvider` is the single interface the UI
sees; `StubDataProvider` (curated stub.json, Gate A) and
`apps/mobile/src/data/SqliteDataProvider.ts:SqliteDataProvider` (real) both
implement it. Selection is bundle-time: `EXPO_PUBLIC_DATA=real` → SQLite.
The provider:

- runs autocomplete/full search through the shared builders
  (`shared/search.ts:buildAutocompleteQuery` / `buildFullQuery`) with
  rank-preserving hydration; digit-bearing queries additionally match
  accession numbers (`buildAccessionSearchQuery` LIKE containment — accession
  is not an FTS column; FTS hits rank first, accession hits are appended,
  deduped);
- `searchGalleries` returns gallery rooms for the omnibar's room rows via
  `shared/search.ts:matchGalleries` over the in-memory gallery list (digit
  query: exact number, then number prefixes; letter query: title-word prefix
  match);
- `objectsInGallery` is a CAPPED display list (500 rows; the densest gallery
  holds ~4.5k objects) in the canonical `shared/search.ts:GALLERY_ORDER`
  (`isHighlight DESC, objectID` — deterministic). Counts and positions are
  never derived from it: `galleryObjectCount` (true COUNT), and the object
  page's "n of N" counter + ‹/› neighbors run as keyed SQL over the full
  ordering (`buildGalleryPositionQuery` / `buildGalleryNeighborsQuery`,
  wraparound at the true ends; no row materialization);
- loads galleries/amenities/graph/geometry once in `create()`;
- `route()` delegates to `shared/routing.ts:buildRouteGraph` + `route` and
  emits `Route.geo` — the node path projected into the map's meter space plus
  the site viewBox — which `apps/mobile/src/components/RoutePolyline.tsx`
  draws as an overlay aligned with the floor map;
- `galleriesGeometry(site, floor)` feeds the map renderer.

## Map rendering

`apps/mobile/src/components/MapGeometry.ts` turns the geojson blobs into a
render model: equirectangular projection around the site bbox center
(`x=(lon−lon0)·111320·cos(lat0)`, `y=(lat0−lat)·110540`, y flipped for SVG;
meters = SVG user units), shoelace centroid/area for label placement, one
per-site viewBox across floors (`buildSiteGeometry`, `availableFloors`,
`resolveGeometryFn`). `apps/mobile/src/components/FloorMap.tsx:FloorMap`
renders it with react-native-svg: memoized room paths, closed galleries
hatched + dimmed, zoom/area-gated labels, data-driven floor chips
(`G|1|1M|2|3|5` today — floors come from the data, not a constant), and
pinch/pan/wheel applied as a screen-space transform so zooming never
re-renders the SVG tree. The venue (Fifth Avenue ⇄ The Cloisters) is **not
map chrome**: FloorMap has no site switcher and renders whatever `site` prop
it is given — the active venue is location state (see Positioning), surfaced
as the second line of the home locate chip and overridden via the locate
sheet's segmented VENUE row. Measured: 204 polygons on
Fifth Ave floor 1, cold paint→first room 431 ms, floor switch 75 ms — no
polygon simplification needed (measured before optimizing).

## Positioning: ranked signals, fused in one state machine

`shared/positioning.ts`. The signal ranking (strongest wins):

1. **Gallery-number entry** → exact room+floor, confidence 1.0.
2. **Artifact lookup** ("I'm next to this") → that object's gallery, 1.0.
3. **Photo** → server `POST /api/v1/locate/photo`: wall-label OCR match
   (deterministic, high confidence) or embedding candidates the user confirms.
4. **GPS** → *wing level only, never a room.*

The GPS ceiling is type-enforced, and it is an eval result, not a policy
choice: `data/evals/reports/gps.md` shows that at realistic indoor accuracy
(65 m, no floor signal on either platform) a naive smallest-room resolver over
200 simulated Great Hall fixes claims **69 distinct rooms across floors and
hits the true room 14% of the time**, while wing-level resolution is stable
(modal wing 51%, at-museum 200/200, 800 m outliers rejected). So
`resolveGpsArea` returns an `AreaAnchor` that **has no gallery field**, and
`RoomSource` excludes `'gps'` — a GPS room claim cannot be expressed.

Fusion semantics (`applyInput`): room inputs always win; a usable GPS fix may
supersede a room anchor only when the room anchor is older than
`ROOM_ANCHOR_DECAY_MS` (4 min ≈ how long before a browsing visitor has drifted
a few rooms), and when it does, the previous floor is retained as
`assumedFloor` ("Floor 2 (assumed)") since GPS carries no floor.
`anchorLevel`/`effectiveConfidence` expose the room→wing decay for display.
Route integration: `onRouteAnchor(progress, anchor, perStepGalleries)` returns
`advance | reroute | none` — checkpoint auto-advance and exactly-once
rerouting per deviation (re-arms after an on-route advance); GPS area anchors
are inert on routes by type. Verified by a scenario simulator
(`shared/positioning.sim.test.ts`) that runs GPS timelines with 40–100 m noise
around real gallery centroids through the real machine, including a 500-random-
fix property test asserting no room claim is ever produced.

**Venue is location state** (gate decision): which building the app shows
(`fifthAve | cloisters`) is part of the position, not a map control.
`applyFusedInput(state, input)` composes venue with anchor fusion under the
coupling rules documented in the `shared/positioning.ts` header: a defined
anchor's site always equals the active venue; explicit inputs (room entry,
locate-sheet manual override, cross-venue object tap) switch venue
unconditionally and clear any other-venue anchor (no floor — not even
`assumedFloor` — crosses buildings); GPS auto-switches the venue (emitting a
`venue-switch` event → dismissible toast) only when the venue wasn't manually
pinned this session and no fresh room anchor exists. `resolveGpsVenue` accepts
fixes up to `VENUE_MAX_ACCURACY_M` (1 km — far looser than area anchoring)
because the venues are ~9.8 km apart while the acceptance radius stays
≤1.35 km, so a usable fix structurally cannot resolve to the wrong venue —
property-tested over 500 noisy fixes at both venues' real centroids, plus
manual-pin and fresh/stale-anchor venue scenarios, in the same simulator.

UI state lives in `apps/mobile/src/components/LocateState.tsx`
(`setAnchor`/`useAnchor`/`anchorForRoom`, plus `useVenue`/`applyVenue` and the
venue-switch toast); the locate sheet (`apps/mobile/src/app/locate.tsx`) runs
GPS-first on open and routes every signal through the shared machine.

## Routing & instructions

`shared/routing.ts`: plain Dijkstra (binary heap, multi-source) over
`graph_nodes`/`graph_edges` rows; `avoidStairs` filters stair edges (elevators
remain). Instructions are templated over the edge sequence, grouped by room,
with door-crossing bearings turned into compass directions: "Exit Gallery 375
through the southwest door into Gallery 374 (European Ceremonial Armor)" /
"Take the stairs to Floor 2". Sample 131→822: 309 m, 24 steps. Runs entirely
on-device (offline routing works; J11 asserts it).

## Navigation mode: the map IS the app (variant D, user-approved)

Navigation is not a screen — it is a **mode of the home screen**, addressed
by URL params: `/?nav=<fromId>:<toId>[&avoid=stairs][&obj=<objectID>]`.
Entering navigation (object page NAVIGATE HERE, room/amenity sheet
DIRECTIONS) **pushes** a home entry with those params, so the native/browser
back button exits the mode; the ✕ in the sheet header exits **in place**
(params cleared via `setParams` — browse chrome returns, the anchor is
preserved). `/route/[from]/[to]` survives as a redirect into home-nav-mode
(existing deep links keep working, `?avoid=` preserved). While navigating the
top chrome (wordmark + search bar) and the locate chip disappear — the map
plus the **NavSheet** teardown are the whole app; floor chips stay (they are
map controls, and they carry the home/star bubbles for cross-floor routes).

NavSheet (`apps/mobile/src/components/NavSheet.tsx`) runs on **DetentSheet**
(`DetentSheet.tsx`) — the three-detent drag/snap/cycle machinery extracted
verbatim from HomeRoomSheet so the navigation teardown and the artifacts
teardown are the IDENTICAL mechanism (one spring tuning, two consumers; a
user-confirmed requirement). Its header is the destination identity (★ +
serif title — the artwork title when entered from an object page via `obj=`,
else the room name — plus gallery/floor/step/distance meta and a 44×44 ✕);
the sheet's top border doubles as a route progress bar (red over ink),
glanceable even at HEADER-ONLY. Tapping the title opens search in retarget
mode (`/search?retarget=<originId>`): room rows there swap the nav target in
place (`RoomRow.focusRoom`'s retarget branch) instead of opening a browse
sheet. The body is the room-grouped step list (instruction phrasing ported
from the retired route screen into `NavSheet.displayInstruction`) with the
avoid-stairs chip (URL-backed: toggling rewrites `?avoid=`) and the I'M HERE
checkpoint button. Arrival swaps the header for WHAT'S HERE (exits nav and
opens the destination's artifacts teardown, anchored there — the modal hands
back to browse seamlessly) and DONE (exits nav, re-anchors at the
destination). Room taps during navigation still open the room sheet — it
stacks over the nav sheet, and its I'M HERE doubles as a manual location fix.

The positioning machine wiring moved into `app/index.tsx` unchanged:
anchor changes run `onRouteAnchor` (auto-advance / exactly-once reroute with
the "Rerouting…" toast; a reroute rewrites the `nav=` origin in place).
Cross-floor steps auto-switch the visible floor; `RoutePolyline` draws the
current floor's segments solid and other floors' dimmed; and FloorMap accepts
a `fitBounds` request — on route/floor/detent changes (below FULL) the
viewport animates to frame the visible route segment above the sheet.

## Search: three tiers, LLM strictly server-side

1. **Autocomplete** (every keystroke, local, p50 0.3 ms): normalized input →
   FTS5 every-token-prefix AND, weighted bm25 + isHighlight boost, gallery
   joined inline. `shared/search.ts:buildAutocompleteQuery`. On zero rows a
   typo-tolerant fallback fires (`autocompleteFuzzy`): trigram candidates from
   the `vocab` tables, Damerau-Levenshtein rerank, corrected query re-run —
   "harlw" → Harlequin (measured: recall@8 96% on the 82-case typo eval,
   ≤10% gibberish false positives, fuzzy p95 6.8 ms on wasm; docs/SEARCH.md).
   Digit-bearing queries union in accession-containment matches
   (`buildAccessionSearchQuery`; accession is not FTS-indexed — measured
   0.6 ms LIKE scan over the full catalog). Above the object rows the omnibar
   shows **room rows**: galleries (`matchGalleries` — exact gallery number →
   number prefixes → title-word matches, cap 4) and amenities (substring +
   synonyms, nearest-first by graph distance). Room rows share one anatomy
   (kind glyph, name, floor chip; no inline actions) and one tap grammar:
   tapping lands on the home map with the room highlighted, floor switched,
   and the dual-action sheet open (`/?focus=` param; HomeRoomSheet renders a
   thin glyph+actions variant for amenities). Object rows go to the object
   page.
2. **All Results** (local): same query + filters (site/floor/classification/
   hasImage/rotation) as WHERE clauses, plus the same gallery/amenity room
   rows above the object list. `shared/search.ts:buildFullQuery`,
   `amenityIntent`.
3. **LLM interpret** (the only server hop, `POST /api/v1/search/interpret`,
   one round trip): the server rewrites *and executes and ranks*, returning
   final results — the client never orchestrates LLM steps.

How the catalog meets Gemini — **never by pasting it** (45k rows ≈ 1M+ tokens:
rejected on latency, cost, and long-context recall during planning). Instead
the prompt carries only the **vocabulary**: distinct classification/culture
value lists generated from met.sqlite (`server/src/vocab.ts:getVocabulary`,
cached per DB handle). Two paths inside `server/src/routes/interpret.ts`:

- **Rewrite (default)**: one `gemini-3.1-flash-lite` call with structured
  output (`server/src/gemini.ts:interpretedQuerySchema`) → `{ftsQuery,
  filters}` → executed against the server's met.sqlite with AND→OR relaxation
  (`shared/search.ts:relaxQuery`). ~$0.0003/query, live p50 ≈ 610 ms.
- **Agentic escalation (rare)**: when the rewrite is weak — `rows < 3 OR
  top-1 bm25 score > −11.5` (threshold measured: healthy top-1 scores
  −12.6…−54 vs low-signal −5.6…−12.1; the score test catches
  "plausible-but-wrong" results that row counts cannot) — flash-lite gets one
  `search_catalog` tool executed in-process, hard-capped at 3 calls.

Gemini integration is one thin client, `server/src/gemini.ts:createGemini`
(`@google/genai` 2.8.0, `responseMimeType`+`responseJsonSchema`, thinking
minimal) — no provider abstraction (Gemini is user-locked). `LLM_MOCK=1`
serves deterministic fixtures (`server/src/llm-mock.ts`) for tests.

## Photo localization

`server/src/routes/locate.ts`: two concurrent server-side paths, one round
trip — (a) label OCR (flash-lite vision reads title/accession off any wall
label; benchmarked 100% on the planning corpus) → deterministic met.sqlite
match; (b) `gemini-embedding-2` query embedding → brute-force cosine against
the precomputed image-vector index (`server/src/embeddings.ts:
loadEmbeddingIndex`/`searchByEmbedding`; sharded Float32Array files in
`data/snapshots/image-embeddings/`, lazy-loaded, ~40 ms at full scale) → top-3
candidates for one-tap confirm. **No LLM image recognition anywhere** —
benchmarks showed retrieval at 90% top-1 / 95% top-5 on real guest photos vs
17–65% for vision-LLM identification (`docs/llm-bench.md`). The index builder
is `data/src/embed-images.ts` (incremental; ≈$4 one-time at 34k images).

## Images: Tigris CDN first, server proxy as fallback

Image bytes do NOT route through the app server on the happy path. The
thumbnail pipeline (`data/src/thumbnails.ts`) pre-generates JPEG derivatives
of every catalog image into the PUBLIC Tigris bucket `musewalk-images`
(anonymous GET, CORS `GET/HEAD from *`), content-addressed as
`img/{objectID}/{sha256(imageUrl)[:12]}/{t320,c1080}.jpg` and recorded in
met.sqlite as `objects.thumbKey`. Clients (web AND native — the derivatives
are smaller than the raw Met CDN files) load
`https://musewalk-images.fly.storage.tigris.dev/{thumbKey}/{variant}.jpg`
directly: `t320` for list rows (results, room sheet), `c1080` for the
object-detail hero. The URL policy lives in ONE module,
`apps/mobile/src/data/imageCdn.ts`; the components are
`apps/mobile/src/components/ObjectImage.tsx` (hero `ObjectImage` + list-row
`ObjectThumb`). On web the bucket `<img>` carries `crossorigin="anonymous"`:
Tigris sends no CORP header, so under the app's COEP `require-corp` the
response is only embeddable via a CORS load. The baked bucket base URL is
origin-independent infra (identical for every deploy origin) and is
allowlisted by `scripts/check-origin-portability.mjs`.

Fallback (why the proxy stays): measured 2026-06-10, `images.metmuseum.org`
sends **no** CORS/CORP headers, so under the server's cross-origin-isolated
pages (COOP `same-origin` + COEP `require-corp`, kept for dev/prod parity)
the raw Met CDN cannot be embedded directly on web.
`server/src/routes/img.ts:imgRoutes` (`GET /api/v1/img/{objectID}`, disk LRU
cache at `DATA_DIR/img-cache/`, cap `IMG_CACHE_MAX_MB`, permissive CORP/CORS
headers, `?v={dataVersion}` cache-buster) is now FALLBACK-ONLY: web clients
hit it when an object has no thumbKey yet (newer than the last thumbnail run,
or a pre-thumbKey met.sqlite artifact — `SqliteDataProvider` detects the
column and degrades cleanly) or when a bucket fetch errors; native falls back
to the direct Met CDN URL instead (no COEP there). ObjectImage shows a
fixed-height neutral block with a small Met-red spinner until the bytes paint
(zero layout shift). The e2e guard is `e2e/checks/imagecdn.spec.ts`: every
sampled thumbnail/hero must actually load (naturalWidth > 0) AND zero
requests may hit `/api/v1/img` during the happy-path sweep.

## Nightly self-refresh

`server/src/refresh.ts`: a 60 s-tick scheduler (`startRefreshScheduler`) fires
once per UTC day at `REFRESH_CRON_HOUR` (default 4; `RUN_REFRESH=0` disables).
The job (`runRefresh`): Met API objects delta (`objects?metadataDate=` since
the snapshot ∩ on-view, ≤10 req/s with WAF-aware backoff) → incremental
synonyms → `build-db.ts` into a staging dir → **atomic swap** (fsync, previous
artifact kept as `met.sqlite.prev`, rename, VERSION bump) → in-process handle
reload (`server/src/routes/interpret.ts:reopenInterpretDb`,
`server/src/embeddings.ts:reloadEmbeddingIndex`). Any failure aborts before
the rename; the live artifact is never touched. Manual trigger:
`POST /api/v1/admin/refresh` (Bearer `ADMIN_TOKEN`; 404 when unset, 409 when
in-flight). Clients pick the new version up via the version poll + ETag.

## Abuse protection

`server/src/middleware/ratelimit.ts:llmRateLimit` (per-IP, `RATE_LIMIT_RPM`/
`RATE_LIMIT_BURST`, 429 + Retry-After) on both LLM endpoints, plus a global
daily budget (`LLM_DAILY_BUDGET`, 503 `budget_exhausted` — clients show a
graceful notice, J11 asserts the offline/degraded path). `imgRateLimit`
separately on the image proxy.

## Data provenance & reliability (eval evidence)

Full detail in `docs/DATA.md`; reports regenerate via `npm run evals` into
`data/evals/reports/`. Headlines as of 2026-06-10:

| Eval | Status | Key numbers |
|---|---|---|
| geometry.md | PASS | 463 gallery polygons, 0 invalid, 0 overlaps >1 m²; centroid vs features-API p50 0.0 m / p90 2.8 m |
| graph.md | WARN | 2,125 nodes / 8,096 edges; 1 connected component per site; 500/500 random pairs routable; Great Hall→Dendur 167 m walked vs 142 m straight (1.17×); 3 galleries lack a door edge (repair walk edges only) |
| gps.md | PASS | wing-level resolution stable at 65 m noise; naive room-level would claim 69 rooms, true room 14% — the never-claim-a-room rule is data-proven |
| coverage.md | WARN | 100% of objects resolve to a polygon — on the partial snapshot (caveat below) |
| search-eval.md | PASS | offline goldens **50/50 (100%)** after Phase 2 upgrades (synonyms column + score-aware escalation); live LLM tier 13/13 with 0 escalations, interpret p50 ≈610 ms; autocomplete p50 0.3 ms |
| visual.md | PASS | 9 per-floor SVG renders (polygons + graph + stairs/elevators) in `data/evals/reports/floors/` for human review |
| llm-bench.md | — | model bake-off that locked flash-lite + embedding retrieval; real-guest-photo retrieval 90% top-1 / 95% top-5 |

Sources: Met Open Access API (official, CC0 — but WAF-throttled to ~1.3 req/s
effective, hence hours-long hydrations with resume); Living Map endpoints
behind maps.metmuseum.org (unofficial — ETL'd once, raw tiles committed in
`data/raw/` so geometry never depends on them again; if they vanish, the app
runs on the frozen snapshot). metmuseum.org itself is never scraped
(bot-blocked, and out of etiquette).

**Known state**: the committed `data/met.sqlite` is a partial snapshot (120
objects) while the full 45.5k hydration runs; a watcher rebuilds the DB and
re-runs evals + goldens when it lands. The schema, code paths, and all suites
are row-count-independent (e2e fixtures derive from the live DB at spec load).
The image-embedding index is similarly mid-build (10k+ of ~34k vectors) and
loads whatever shards exist.

## Module map

| Path:symbol | Role |
|---|---|
| `shared/openapi.yaml` → `shared/api-types.d.ts` | the only client↔server contract (`npm -w shared run gen`) |
| `shared/search.ts:buildAutocompleteQuery` / `buildFullQuery` / `relaxQuery` / `amenityIntent` | FTS query construction, shared verbatim by client and server |
| `shared/routing.ts:buildRouteGraph` / `route` | Dijkstra + room-grouped compass instructions |
| `shared/positioning.ts:applyInput` / `applyFusedInput` / `resolveGpsArea` / `resolveGpsVenue` / `onRouteAnchor` | signal fusion, decay, venue coupling + GPS venue auto-detect, route advance/reroute |
| `apps/mobile/src/data/provider.ts:DataProvider` / `StubDataProvider` / `useData` | UI-facing data interface |
| `apps/mobile/src/data/SqliteDataProvider.ts:SqliteDataProvider` | real provider over the local DB |
| `apps/mobile/src/data/DataGate.tsx:DataGate` | boot: local-first open, download, version poll, hot swap |
| `apps/mobile/src/data/sqlite.ts` / `sqlite.web.ts` (`MetDb`) | per-platform SQLite backends behind one contract |
| `apps/mobile/src/components/MapGeometry.ts:buildSiteGeometry` | geojson → projected render model |
| `apps/mobile/src/components/FloorMap.tsx:FloorMap` | SVG floor-plan renderer (real + stub paths) + fit-to-bounds viewport requests |
| `apps/mobile/src/components/RoutePolyline.tsx` | route overlay from `Route.geo` (solid on-floor, dimmed off-floor) |
| `apps/mobile/src/components/DetentSheet.tsx:DetentSheet` | shared three-detent bottom-sheet machinery (room + nav teardowns) |
| `apps/mobile/src/components/NavSheet.tsx:NavSheet` | navigation teardown: destination header, progress border, step list, arrival |
| `apps/mobile/src/app/index.tsx:HomeScreen` | browse + nav modes of the one map screen (`?nav=` params, route-machine wiring) |
| `apps/mobile/src/components/LocateState.tsx:setAnchor` / `useAnchor` / `useVenue` / `applyVenue` | global anchor + venue state for the UI (and the venue-switch toast) |
| `server/src/index.ts` | Hono wiring: COOP/COEP, x-data-version, rate limits, static SPA |
| `server/src/meta.ts:injectOgMeta` / `requestOrigin` | per-request og/twitter meta injection into index.html with absolute URLs from the request origin (Host + x-forwarded-proto) — keeps the export origin-portable; assets authored in `assets/share/`, served from `apps/mobile/public/` |
| `server/src/gemini.ts:createGemini` | the one Gemini client (rewrite, agentic loop, OCR, embeddings) |
| `server/src/routes/interpret.ts:interpretRoutes` | tier-3 search: rewrite → score-aware agentic escalation |
| `server/src/routes/locate.ts:locateRoutes` | photo localization (OCR ∥ embedding retrieval) |
| `server/src/routes/data.ts:dataRoutes` | versioned ETag delivery of met.sqlite |
| `server/src/routes/img.ts:imgRoutes` | Met-CDN image proxy + disk LRU |
| `server/src/embeddings.ts:searchByEmbedding` | in-RAM cosine over the sharded vector index |
| `server/src/refresh.ts:runRefresh` / `adminRefreshRoutes` | nightly delta → rebuild → atomic swap |
| `server/src/vocab.ts:getVocabulary` | DB-derived vocabulary for the interpret prompt |
| `data/src/objects.ts` / `geometry.ts` / `graph.ts` / `synonyms.ts` / `build-db.ts` / `embed-images.ts` | pipelines (scripts; also driven by the server refresh job) |
| `data/src/evals.ts` | regenerates all eval reports (`npm run evals`) |
| `e2e/checks/` · `e2e/journeys/` | fast assertion gate (incl. HIG sweep) · J1–J15 user-journey videos |

## Testing

- `npm -w shared test` — vitest: routing, search builders, positioning unit +
  scenario simulator.
- `npm -w server test` — vitest: og-meta injection matrix (origins, deep
  paths, title dedupe) + shipped share/icon asset dimensions.
- `cd e2e && npx playwright test --project=checks` — fast gate: all screens,
  real-map rendering, HIG conformance sweep (≥44 pt targets, ≥16 px inputs,
  no horizontal overflow at 390 px), data-provider spec (gated on
  `REAL_TARGET`).
- `npm -w e2e run journeys` — J1–J15 acceptance videos against the production
  boot (real provider + `LLM_MOCK=1` server); recordings in `e2e/recordings/`.
  `@live`-tagged variants hit real Gemini under `LLM_LIVE=1`.
- `npm run evals` — data eval reports with hard pass/fail gates.
