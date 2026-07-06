# Data: sources, pipelines, reliability (Gate B)

Everything the app knows about the Met — 45.5k on-view objects, 463 gallery
polygons, a 2,125-node routing graph, 125 amenities — is built by four pipelines
in `data/src/` into one artifact, `data/met.sqlite`, that every client downloads.
This document covers where the data comes from, how trustworthy it is (with
measured eval numbers, not assertions), how to rerun everything, and what the
known gaps are.

## Sources & provenance

### 1. Met Open Access API (official, CC0)

`https://collectionapi.metmuseum.org/public/collection/v1` — no auth, published
cap 80 req/s. Verified facts this build relies on:

- `GET /search?isOnView=true&q=*` returns all on-view object IDs in one response
  (45,502 on 2026-06-10; 34,027 with images).
- `GET /objects/{id}` → `GalleryNumber` (string; non-empty = on view), title,
  artist, classification, medium, tags, `isHighlight`, `primaryImageSmall`,
  `metadataDate` (drives incremental refresh).
- The GitHub CSV dump is frozen at 2023-06-17 and is **not** used.
- **Measured reality (2026-06-10)**: the API sits behind an Imperva WAF that
  403-blocks sustained traffic well below the published cap — ~10 req/s nominal
  degrades to ~1.3 req/s effective once retry waits are included. A full
  45.5k hydration takes hours, not the planned ~20 minutes. The pipeline
  paces itself, reuses session cookies, retries 403/429/5xx with backoff, and
  resumes from `/tmp/met-objects-cache.ndjson` after interruption.

### 2. Living Map (unofficial — the endpoints behind maps.metmuseum.org)

The Met's official interactive map is a Living Map SPA whose backing endpoints
are unauthenticated:

- Vector tiles `prod.cdn.livingmap.com/tiles/the_met/{z}/{x}/{y}.pbf` — layer
  `indoor`: room polygons (`category=room`, `name` = gallery number, floor,
  closed flag), door/threshold barrier lines, stair/lift/escalator unit polygons.
- Features API `map-api.prod.livingmap.com/v1/maps/the_met/features` — 679
  features: 460 gallery label points (centroid + floor), wing/section centers,
  entrances, amenities.

**Caveats, stated plainly:** this is a production API we do not own, used
outside any documented contract. Mitigations: a **one-time ETL** — every raw
response is committed under `data/raw/livingmap/` (4 MB: 37 tiles + 2 feature
pages + styles), all decoding runs from that cache and never re-hits the
network; fetching was throttled to ~4 req/s; clients never touch Living Map. If
the endpoints change or disappear, geometry is frozen at this snapshot and the
app keeps working. Attribution: indoor geometry © Living Map / The Metropolitan
Museum of Art, extracted from the museum's public map service.

One finding contradicts the original plan: the tiles' `category=route` lines are
**7 static showcase paths, not a wayfinding graph** (live A→B routing is
computed per-request server-side and never tiled). The routing graph is
therefore *derived* — see the graph pipeline below. `routes.geojson` is kept
only as evidence of this.

### 3. Gemini image embeddings (for photo localization)

`data/src/embed-images.ts` embeds each on-view object's primary image with
`gemini-embedding-2` (768d) into `data/snapshots/image-embeddings/` (flat
Float32Array shards + index.json), loaded into server RAM for
`/api/v1/locate/photo`. Server-side only; never shipped to clients, and not
committed to git (≈100 MB at full scale) — regenerate with the incremental
command below; in prod it is baked into the Docker image from the Tigris
artifact bucket.

### 4. Other registry museums (multi-museum fleet)

Every non-Met museum enters through its source adapter in
`data/src/sources/{id}.ts` (run: `npm -w data run objects -- --museum {id}`);
each adapter's header comment is the provenance record — endpoints, measured
politeness envelope, on-view semantics, license reading. Notable per-source
etiquette: the Uffizi adapter queries the Italian ministry's ArCo SPARQL
endpoint (`dati.beniculturali.it/sparql`, keyless) at ≤1 req/s with simple
paged SELECTs only — the endpoint silently returns empty/partial results for
heavy GROUP BY queries, so all aggregation happens client-side (≈25 requests
for the full harvest, page cache under `data/raw/uffizi/`). Museums with
`translateFrom` in the registry (Louvre fr, Rijksmuseum nl, Uffizi it) run
`data/src/translate.ts` after hydration to fill `titleAlt` + English facets.

## Pipelines (all in `data/src/`, rerun with these commands)

Prereq: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` (Node ≥ 22).

| Command | In → out | Notes |
|---|---|---|
| `npm -w data run objects` | Met API → `snapshots/objects.json.gz`, `vocab.json`, `objects-meta.json` | Hours (WAF); resumable; `--limit N` for samples |
| `npm -w data run geometry` | `data/raw/livingmap/` cache → `snapshots/galleries.geojson` (828 rooms, 463 galleries), `amenities.geojson` (125), `routes.geojson` | No network once cached; MVT decode + cross-tile polygon union |
| `npm -w data run graph` | raw tiles + galleries.geojson → `snapshots/graph.json` (2,125 nodes / 8,096 edges) | Doors probed from barrier lines (probe both sides → connected room pair); vertical shafts by cross-floor polygon overlap; inline verification gates |
| `npm -w data run build-db` | all snapshots → `data/met.sqlite` + `data/VERSION` | Atomic tmp+rename; FTS5 (porter, prefix 2/3/4); geometry blobs gzipped in a `blobs` table |
| `npm -w data run evals` | snapshots + met.sqlite → `data/evals/reports/*.md` + `floors/*.svg` | No network; exit 1 on FAIL; also runs the Louvre gate + the museums audit below |
| `npm -w data run audit` | met.sqlite (+ optional `PREV_DB=<path>` previous artifact) → `data/evals/reports/museums-audit.md` | Per-museum fill rates, structural invariants, distribution sanity, churn — see below; also chained into `npm run evals` |
| `GEMINI_API_KEY=$(cat ~/.gemini_key) npm -w data run embed-images` | objects snapshot → `snapshots/image-embeddings/` | ~34k images ≈ $4 one-time; incremental |

Order matters only as: objects/geometry → graph → build-db → evals.

## Reliability — measured, not asserted

`npm run evals` produces five reports under `data/evals/reports/`. Numbers from
the 2026-06-10 run:

- **Coverage** (`coverage.md`): **99.8% of snapshot objects (44,768/44,842)
  resolve to a gallery polygon** (exact match → `data/src/gallery-aliases.json`
  manual aliases → Cloisters zero-pad rule), measured on the full snapshot. The
  aliases file covers Living Map's named exhibition polygons ("Exhibition
  Galleries 999" etc.), the 746 North/South split, and the Petrie Court Café.
  The zero-pad rule is also applied **inside met.sqlite**: `build-db.ts`
  canonicalizes `objects.galleryNumber` ("010" → "10") whenever the stripped
  form is a real galleries-table number and the padded form is not, so the
  plain SQL `objects ↔ galleries` join covers the Cloisters directly
  (44,321/44,842 = 98.8% in-DB; the remainder are alias-only codes plus four
  Cloisters numbers with no Living Map polygon: 005, 015, 021, 023).
  Exhibition codes like "099" are deliberately untouched — their polygons
  carry the *name* "Exhibition Gallery 099", not the number, so neither "099"
  nor "99" is in the galleries vocabulary and the rotation heuristic keyed on
  the raw code stays valid.
- **Geometry** (`geometry.md`): 828/828 polygons valid; **0 overlapping room
  pairs** > 1 m² per floor (floor-plate backdrop polygons excluded by design);
  polygon centroids vs the features API's independent label points: **p50 0.0 m,
  p90 2.8 m, max 20.0 m** over 458 matched galleries — the decode/stitch is
  faithful. All 7 Fifth Ave floors + 2 Cloisters floors present.
- **Graph** (`graph.md`): 1 connected component per site; **500/500 random
  gallery pairs routable** (p50 170 m, max 382 m); Great Hall → Temple of
  Dendur (gallery 131) = 167 m walked vs 142 m straight-line (1.17×, ≈2 min —
  plausible);
  460/463 galleries have ≥1 real doorway edge (3 American Wing period rooms —
  738, 739, 741 — connect via wall-adjacency repair edges instead: WARN, not
  wrong routes, just less precise "exit through the door" anchors there).
- **GPS** (`gps.md`): the resolver's output type has no room field — room claims
  are impossible by construction. Synthetic fixes confirm the data supports
  this: entrance fix → wing-level hint; Central Park outlier rejected both for
  accuracy (800 m) and distance (>200 m outside); a 200-fix 65 m-noise cloud
  resolves at-museum 100% with a 51% modal wing, while a *naive* room-level
  resolver would have claimed **69 different rooms** and hit the true room only
  **14%** of the time — the quantified reason GPS is capped at wing level.
- **Visual** (`visual.md` + `floors/*.svg`): 9 per-floor renders of every
  polygon with the routing graph, doorway nodes, stair/elevator markers, and
  gallery numbers overlaid — inspect these to judge the geometry with your own
  eyes.

The five reports above are Met-specific (Gate B, predating the multi-museum
registry). Every other registry museum's source, measured access facts, and
etiquette envelope live in its adapter's header comment
(`data/src/sources/{id}.ts` — e.g. Museo Egizio is a robots-sanctioned
sitemap crawl of collezioni.museoegizio.it at ≤1 req/s, resumable, with an
explicit per-page on-view field) and in the per-museum sections of
ARCHITECTURE.md. Every OTHER registry museum's fill rates, structural invariants
(site-scoped object→gallery join, sourceId/objectID uniqueness, license/TTL
consistency), catalog-noise clusters, and artifact-to-artifact churn are in
**`data/evals/reports/museums-audit.md`** (`data/src/museums-audit.ts`,
`npm -w data run audit`) — the cross-museum data-quality dashboard, Kui's
replacement for a hard per-museum merge gate: only true structural bugs FAIL
the process, everything else is a measured WARN.

## Update story

- **Production**: a nightly GitHub Actions job (`data/src/nightly.ts`, see
  ARCHITECTURE.md "Deployment & nightly data pipeline") re-runs the objects
  pipeline in incremental mode (`metadataDate` delta against last night's
  bucket artifact), embeds only new/changed images, rebuilds `met.sqlite` with
  the *committed* geometry/graph snapshots, uploads a verified version to the
  Tigris bucket, and redeploys (the Docker image bakes the data). Clients poll
  `GET /api/v1/data/version` and re-download on ETag change. Geometry and the
  graph are **not** refreshed nightly — gallery walls don't move; they are
  re-ETL'd manually if the Met renovates (the coverage eval's orphan list is the
  signal that a gallery number appeared without a polygon).
- **Local**: the same code paths, run by hand with the commands above; dated
  outputs live in `data/snapshots/`. Evals are the regression gate after any
  rebuild.

## Known gaps & risks

1. **Cloisters gallery numbers are zero-padded by the Met API** ("003", "010")
   while Living Map geometry uses unpadded numbers ("3", "10"). RESOLVED at the
   single canonicalization point, `build-db.ts`: `objects.galleryNumber` is
   stripped of leading zeros on insert iff the stripped form exists in the
   galleries table and the padded form does not (snapshots keep the raw API
   value; the build is idempotent either way). Before the fix, 0 of 1,158
   Cloisters objects joined a gallery row; after, 1,145/1,158 do. Residual
   orphans: 005/015/021/023 (no Living Map polygon) and the exhibition codes,
   which only resolve via name aliases in the eval, not in the DB join.
2. **Living Map could change or vanish.** Frozen snapshot keeps working;
   re-tracing from the official PDF map is the (slow) fallback. Unofficial use
   is a ToS gray zone — acceptable for a portfolio build, attributed, never
   client-hit.
3. **The routing graph is derived, not authoritative.** Doors come from
   probing barrier lines (3,356 deduped segments → 1,292 doorways); 3 galleries lack
   door edges; within-room edges are straight lines (slightly optimistic in
   concave rooms); stairs/elevator traversal costs (15/25 m-equivalent per
   level) are tuning guesses pending Phase 2 instruction QA. One-way/closed
   passages aren't modeled beyond the `closed` flag.
4. **No floor signal in GPS anywhere** (browser or native). Wing-level hints
   only; room anchoring always comes from user input, photo, or artifact lookup.
5. **Special exhibitions are a heuristic** — the dedicated exhibition-gallery
   set {099, 199, 899, 964, 965, 999} flags rotation; the API has no exhibition
   field and metmuseum.org is bot-blocked, so exhibition *names* come only from
   Living Map polygon titles, which go stale between geometry re-ETLs.
6. **Petrie/746 alias judgment calls**: objects labeled "746" are anchored to
   746 North; café sculptures anchor to the café polygon. Room-level error of
   one wall at worst.
7. **Room closures are a binary current-state flag, not a schedule.** The
   only closure signal we have is the Living Map `closed` boolean on room
   polygons and amenity points, captured at ETL/nightly-refresh time — "this
   space is inaccessible right now (as of the last snapshot)". The Met
   publishes no machine-readable opening/closing schedule, and the
   gallery-closings page on metmuseum.org is bot-blocked like the rest of the
   site, so the UI says "currently inaccessible" and nothing more: no
   reopening dates, no hours. Closed rooms stay tappable on the map (grey +
   hatched) but offer no DIRECTIONS / I'M HERE.
