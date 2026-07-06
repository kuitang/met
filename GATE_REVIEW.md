# Gate review — Gates A–D (Phase 1–2, historical) · Gate M (multi-museum)

## Gate M — Universal Museum Navigator (multi-museum) — READY FOR REVIEW

Shipped 2026-07-05/06 as squash PRs #21–#36 per the approved plan
(`Universal Museum Navigator` brief; single merged artifact, sites are the
museum dimension). Every number measured on this machine; reproduce with the
inline commands.

**Watch:** 18 journey videos (J1–J17, 390×844, 20/20 specs passing) +
UI screenshots + eval reports on the tailnet review server —
`http://100.87.13.37:8123`. J16 (multi-museum search) and J17 (Louvre
walking navigation) are the new centerpieces.

### Museums in the artifact (8 + Rijksmuseum landing; 119,949 on-view objects, 104.6 MB raw / 50.4 MB gz)

| Museum | Rows | Fidelity | Goldens | License posture |
|---|---|---|---|---|
| Met | 44,842 | routed (2 sites) | **50/50 — held through every milestone** | CC0 |
| AIC | 3,510 | room-labels | 25/25 after PR #40's synonyms | CC0 machine-readable |
| Cleveland | 6,899 | room-labels | 13/15 | CC0 + per-record image gate |
| NGA DC | 2,808 | room-labels (2 sites) | 14/14 | CC0, images excluded from grant |
| SMK | 1,481 | room-labels | 13/14 | PD-marked |
| V&A | 58,092 | room-labels | 11/12 | NC + **28-day license TTL (enforced in-client, live-verified)** |
| Harvard | 1,817 | room-labels | 10/10 | NC + **14-day TTL** (19 API calls/pull vs 2,500/day cap) |
| Louvre | 500 partial → 26,653 (self-healing hydration vs their bot-wall) | **routed** (OSM/ODbL; gate: 1 component, 500/500 pairs, Joconde→Vénus 263 m) | FR/EN bilingual via titleAlt | Etalab (attribution) |
| Rijksmuseum | landing (OAI-PMH harvest in flight, ~8k expected) | room-labels (case-level codes) | — | CC0-leaning metadata, per-record image rights |

Measured excludes (memos in data/evals/reports/): **Paris Musées**
(room-fill 0.40% vs the 60% criterion; Petit Palais flagged as a future
standalone candidate), British Museum (bot-blocked + NC-SA), Cooper Hewitt
(dump dead since 2017), Smithsonian (no structured location).

Data quality: `data/evals/reports/museums-audit.md` (PR #38) — per-museum
fill rates, structural hard-gates (all PASS), churn dashboard fed by the
nightly's previous-artifact pull.

### Search guarantees (the north star — plan requirement)
- Met goldens **50/50 at every single milestone** including the 118k-row merge;
  bm25 bit-identical across the contentless-FTS cutover (0.00% drift).
- English queries match French Louvre titles at full title weight
  ("funerary papyrus" → "papyrus funéraire"); French queries unaffected.
- Typo evals ALL TARGETS MET on the merged corpus.
- Room-code collisions (102 across museums, a live prod bug found mid-build)
  fixed via site-scoped room ids (#32) + 6 seam regressions caught by the
  video gate (#36) — `apps/mobile/scripts/check-room-scoping.mts` is the
  regression harness.

### Pipeline LLM decisions (measured bake-off, $0.47 total; report on the review server)
- Translation: DeepSeek V4 Flash via OpenRouter (Kui-approved; 5.1× cheaper,
  statistically tied; id-keyed batches mandatory — echo-keyed measured
  off-by-one). Baseline prompt, T=0 (3 enhancement variants measured: all CIs
  straddle null).
- Synonyms + ALL runtime LLM: Gemini (unchanged locked rule).

### Known-partial / follow-ups
- Louvre full snapshot lands after the overnight hydration (collections.louvre.fr
  serves HTML bot-challenges with HTTP 200 at ≥2 req/s — politeFetch hardened
  #34, pace 1 req/s) → `feat/mm-d6c-louvre-full` + final nightly.
- Kui-action items: Harvard API key (form), Paris Musées token (signup),
  Rijksmuseum inclusion (spike verdict: include; recommended next sprint).
- Artifact size 49.5 MB gz vs ~35 MB planned (V&A's 58k rows) — accepted,
  revisit trigger documented in ARCHITECTURE.md.

---
# Historical gates below (Phase 1–2)


**LAUNCHED 2026-06-11.** Every gate below (including the final deployment
gate #24 — user approval of the PR-2 preview) was reviewed, approved, and is
now historical record. The product is live at https://musewalk.app
(Fly app `musewalk`, CI/CD + nightly data refresh + PR previews); the
operator runbook is [DEPLOY_NOTES.md](DEPLOY_NOTES.md), the system reference
is [ARCHITECTURE.md](ARCHITECTURE.md). Numbers below were measured on this
machine on 2026-06-10; commands to reproduce are inline.

## Gate D — architecture + full integration (Phase 2) — REVIEWED (historical)

**Look at:** [`ARCHITECTURE.md`](ARCHITECTURE.md) — the system as actually built
(one-artifact data flow, positioning design with the GPS eval evidence, LLM
integration, refresh job, module map with verified `path:symbol` references).

**Watch:** the 16 journey videos in `e2e/recordings/` (J1–J15 + J8b, 390×844,
real provider + real map + mocked LLM; J9 navigate/auto-advance/reroute is the
centerpiece). The directory is gitignored (videos are delivered with this
review); re-record any time: `npm -w e2e run journeys` (boot recipe in
`e2e/README.md` and CLAUDE.md).

**Phase 2 resolutions of the Phase 1 open questions (below):**
1. Non-CC0 images → server image proxy `GET /api/v1/img/{objectID}` for what the
   API does provide, "view on metmuseum.org" link on the object page for the rest.
2. COEP → **image proxy** (not `credentialless`), headers kept on everything;
   web SQLite moved to the official `@sqlite.org/sqlite-wasm` (expo-sqlite's web
   backend shipped without FTS5 and with a sync-bridge corruption bug — measured,
   documented in ARCHITECTURE.md).
3. Score-aware escalation → implemented (`rows < 3 OR top-1 bm25 > −11.5`), plus
   an index-time LLM synonyms column: offline goldens now **50/50 (100%)**.

**Phase 2 status headline:** checks 33/33 passing (+3 conditionally skipped),
journeys 16/16 with videos, shared unit tests 90 passing, tsc clean everywhere;
`data/met.sqlite` still the partial (120-object) snapshot — full 45.5k hydration
+ auto rebuild/re-eval running in the background (see ARCHITECTURE.md "Known state").

---

# Phase 1 gates (historical, all reviewed)

---

## Gate A — clickable mockup (all screens, stub data)

**Look at:** `docs/mockup/home.png · search.png · results.png · object.png · route.png · locate.png`
(phone-sized 390×844, regenerated by the test suite so they always match the code), plus
`docs/mockup/README.md` for a guided click-path.

**Click it yourself:**
```sh
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm install && npm run web        # → http://localhost:8081 (≈390px window matches the shots)
```
Try: tap a room on the map → object list → Directions · search `Monet`, `gold swords`
(weak → "Ask differently" interpret flow), `restroom` (amenity intent) · object page ‹/›
cycles the gallery · route view "I'm here" steps, avoid-stairs toggle, simulated reroute ·
locate sheet's four entry modes (gallery # / artifact / photo / GPS — GPS honestly capped
at entrance level).

**Headline:** 19/19 Playwright checks pass (`cd e2e && npx playwright test --project=checks`,
9.3 s); zero console errors on the production web export; `tsc` clean in app, server, e2e.

---

## Gate B — data pipelines, met.sqlite, evals

**Look at:** `docs/DATA.md` (provenance, measured reliability, update story, known gaps),
then the eval reports in `data/evals/reports/`: `coverage.md`, `geometry.md`, `graph.md`,
`gps.md`, `visual.md`, and the 9 per-floor SVG renders in `data/evals/reports/floors/`
(open in a browser — polygons + door/walk graph + stairs/elevator markers; this is the
"show me your work" artifact).

**Headline** (`npm run evals`, exit 0):
- geometry **PASS** — 463 gallery polygons, 0 invalid, 0 overlaps >1 m², centroid-vs-API p50 0.0 m / p90 2.8 m
- graph **WARN** — 500/500 random pairs routable, 1 connected component per site, Great Hall→Dendur 167 m (1.17× straight line); 3 galleries (738/739/741) lack a door edge
- gps **PASS** — entrance fix resolves wing-level, 800 m outlier rejected, and the data *proves* room-level GPS is impossible (65 m noise → 69 candidate rooms, true room 14%) — the app's "never claim a room from GPS" rule is load-bearing
- coverage **WARN** — 100% of objects resolve to a polygon, but on a **partial snapshot** (see caveat)

**The one big caveat:** `data/met.sqlite` currently holds **120 of 45,502** on-view objects.
The Met API sits behind an Imperva WAF that throttles to ~1.3 req/s effective (published cap
is 80/s) — the full hydration is a ~9 h resumable job that was still running at commit time.
Everything is built and verified to flip to the full catalog with one command when it lands:
`npm -w data run build-db && npm run evals` (the search golden suite re-activates itself).

---

## Gate C — search + LLM endpoints + benchmarks

**Look at:** `docs/SEARCH.md` (the three-tier design as built), `docs/llm-bench.md`
(model bake-off + cost model), `data/evals/reports/search-eval.md` (full methodology +
failure post-mortems — the honest part).

**Headline** (measured at full catalog scale, 44,468 objects, live Gemini):
- **48/50 golden queries pass (96%)** — autocomplete 26/26, full-results 11/11, LLM tier 11/13 *(post-hydration update: **50/50** on the production 44,842-object met.sqlite after the Phase 2 synonyms + escalation upgrades — `data/evals/reports/search-eval.md`)*
- Latency: local autocomplete p50 **0.3 ms**; live LLM interpret p50 **612 ms** / p95 940 ms (cache hits 12–15 ms)
- Cost: ~$0.0003/interpret call → **≈$20/mo worst case** at 1,000 queries/day; hard budget cap at $40/mo (server `LLM_DAILY_BUDGET`)
- The 2 failures are documented with root cause (count-based escalation never fires when the rewrite returns ≥3 plausible-but-wrong rows; score-aware escalation is the written fix)
- Photo-localization full-index eval **DONE (2026-06-10)**: 500 real guest photos (NeurIPS Met benchmark) vs the complete 33.6k-vector production index — **81.2% top-1 / 91.0% top-5 / 86.8% gallery-level**; live endpoint p50 849 ms / p95 1,254 ms, 40/40 live↔offline parity; DINOv3 self-hosted upgrade gate NOT triggered → `data/evals/reports/photo-locate.md`

Because the full met.sqlite wasn't ready, C's numbers come from an equivalent-schema eval DB
built from the official CC0 CSV × today's live on-view ID set (97.7% coverage) — method and
rationale disclosed in `search-eval.md`.

---

## Integration notes from the final pass

- Fixed the one real integration break: B's `build-db.ts` emitted `galleries(number, …)` /
  `amenities(kind, …)` while the shared search contract expects `galleries(galleryNumber, site)`
  PK and `amenities.type`. build-db now matches `shared/search.ts`; rebuilt, all suites green.
- CLAUDE.md's COEP plan was wrong and is corrected: `images.metmuseum.org` sends **no** CORS
  headers (measured 3/3), so Phase 2's server must use `COEP: credentialless` or an image proxy.
- `data/raw/` committed at 4 MB (Living Map tiles — the irreplaceable part); the re-fetchable
  Met image/object caches are gitignored with regeneration documented in `docs/DATA.md`.

## Open questions for you

1. **Met images are mostly *not* CC0 for famous works** (e.g. every on-view Monet is flagged
   `isPublicDomain: false` — no image via the API). The mockup shows text-only cards for those.
   OK, or should Phase 2 add a "view on metmuseum.org" image link instead?
2. **COEP decision** (affects Phase 2 server): `credentialless` header (simple, Chrome/Firefox
   fine, Safari ≥17.4-ish) vs. proxying Met images through our server (works everywhere, adds
   bandwidth). Default plan is `credentialless` unless you object.
3. **Search escalation tuning:** accept the 2/50 known misses for now, or have Phase 2 implement
   score-aware escalation (escalate on weak bm25 scores, not just <3 rows) before wiring the
   real client?
