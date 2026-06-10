# Search eval — 50 golden cases at full catalog scale (Gate C)

Run date: 2026-06-10. Code under test: `shared/search.ts` (tiers 1–2, identical on
client and server) and `POST /api/v1/search/interpret` (tier 3, live
`gemini-3.1-flash-lite`, `server/src/routes/interpret.ts`). Golden cases:
`data/evals/search-cases.json`.

## Headline results

| Tier | Path exercised | Pass rate |
|---|---|---|
| autocomplete (26 cases) | local FTS5, every-token-prefix AND, top 8 | **26/26 (100%)** |
| full (11 cases) | local FTS5 + filters, top 25 | **11/11 (100%)** |
| llm (13 cases) — live interpret endpoint | flash-lite rewrite → relaxed FTS, agentic fallback | **11/13 (85%)** |
| llm (13 cases) — offline relaxed-FTS only (no Gemini) | post-rewrite execution path | 11/13 (85%) |
| **Overall (live)** | | **48/50 (96%)** |

Target was ≥90%: met. **No tuning changes to `shared/search.ts` were needed** — the
bm25 weights (10, 8, 3, 5, 2, 4), highlight boost (−2.0) and AND→OR relaxation
chosen on the 16-object planning fixture held unchanged at 44k-row scale.

Tier-3 latency on the live endpoint (cold, n=13): **p50 612 ms, p95 940 ms**, all 13
resolved by the rewrite path (no agentic escalation needed). Warm LRU cache hits:
12–15 ms. Local autocomplete on the full DB: p50 0.30 ms, p95 11.7 ms (worst case =
1-character prefix), full-results query ~1 ms — comfortably inside the
<10 ms-per-keystroke budget.

## The evaluation database (deviation, disclosed)

The B-stream production artifact `data/met.sqlite` did not exist when this eval ran
(`data/src/build-db.ts` was still a stub and the objects pipeline was mid-hydration
at its WAF-safe 10 req/s — a full run takes >75 min). Rather than evaluate on a toy
fixture, we built a full-scale DB with the exact `shared/search.ts` schema contract
from real catalog data (`data/evals/fullscale-eval-db.mjs`):

1. **Live on-view ID set** — one Met API request (`isOnView=true&q=*`): 45,502 IDs.
2. **Official CC0 Met Open Access CSV** (GitHub, frozen 2023-06-17) for text
   metadata — title/artist/culture/classification/medium/tags/gallery/isHighlight.
   Frozen-ness affects freshness, not ranking realism: what the eval needs is true
   distractor density (44k real catalog rows), which the CSV provides.
3. **Fresh API rows** from the objects pipeline's resume cache (711 rows, 2026 data)
   overlaid on top.
4. **Targeted hydration** of golden objectIDs missing from 1+3 (one object, 42210,
   fetched at 0.5 s spacing).

Result: 44,468 objects (97.7% of the live on-view set; 1,034 post-2023 additions
are absent), 458 galleries + 96 amenities from the B-stream geometry snapshots,
18.2 MB. Known gaps: `imageUrl` empty except for the 712 patched rows (no golden
asserts images); the 2023 text may differ from 2026 for a small fraction of rows.

**This is an eval stand-in, not the product artifact.** The vitest suite
(`shared/search.test.ts`) auto-runs the same 50 goldens against the real
`data/met.sqlite` the moment B4 lands (`npm -w shared run test`), asserting ≥70%
as a regression floor; re-check the numbers here at that point.

## Golden-case corrections made during this run

Three cases were corrected against ground truth (all annotated with `note` in
`search-cases.json`):

1. **"great wave"** re-tiered full→llm: Hokusai's Great Wave (45434) is **not on
   view** on 2026-06-10 (prints rotate; verified against the live on-view ID set).
   The full tier correctly returns 0 rows, which auto-escalates to tier 3 in the
   product; the case now asserts that escalated behavior (any "wave" title — the
   live rewrite returns Courbet's *The Green Wave* etc.).
2. **"sake bottle willow"** re-tiered full→llm: the Met titles 52945 "Wine Bottle
   with a Bird on a Rock under a Willow Tree" — "sake" cannot match lexically, AND
   yields 0 rows → tier 3. The live rewrite ranks 52945 second. Pass.
3. **"carnelian ring stone"** gained `expectTitleContains`: gallery 171 holds
   dozens of objects literally titled "Carnelian ring stone"; pinning one objectID
   among identical titles tested bm25 tie-breaking, not search quality.

## The two failures, exactly

Both fail on the live endpoint and offline; both are vocabulary leaps the rewrite
did not make and the agentic tier never saw (the rewrite returned ≥3 plausible
rows, so the count-based escalation did not fire):

1. **"bronze statue of a roman household god"** → expected 250684 *Bronze statuette
   of a Lar*. flash-lite produced `bronze OR statue OR household OR god` +
   classification Sculpture-Bronze + culture Roman — reasonable, but the catalog
   says "statuette" (porter does not stem statuette→statue) and never "household
   god"; title-matching rows like *Statue of the God Ptah* flood the top 25. The
   model needed to know the iconographic term "Lar".
2. **"beads from ancient mesopotamia"** → expected 325329 *Beads* (culture "Iran",
   period "Iron Age II, Hasanlu Period IV"). The token "mesopotamia" appears in
   **zero** of the 44k catalog rows — the case is lexically unwinnable; only a
   culture remap (and arguably Hasanlu isn't Mesopotamia) could hit it.

Both point at the same two levers, deliberately deferred in the plan:
**index-time synonym expansion** (batch LLM column in build-db: Lar→"household
god", culture→region translations) and a **score-aware escalation trigger**
(escalate to the agentic loop when the top results are weak matches, not only when
there are <3 of them). Neither was worth building before the failure modes were
measured; now they are, with exactly two known victims out of 50.

## Reproduction

```sh
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
# 1. inputs (downloaded once to /tmp/c4-fullscale; ~318 MB CSV)
#    see header of data/evals/fullscale-eval-db.mjs for the two curl commands
# 2. build the eval DB (~90 s)
node data/evals/fullscale-eval-db.mjs
# 3. offline tiers (autocomplete/full/llm-relaxed + amenity intents)
node data/evals/run-goldens.mjs /tmp/c4-fullscale/met.sqlite
# 4. live tier 3 (real Gemini; needs high rate-limit for 13 back-to-back calls)
export GEMINI_API_KEY=$(cat ~/.gemini_key)
DATA_DIR=/tmp/c4-fullscale PORT=8899 RATE_LIMIT_RPM=1000 RATE_LIMIT_BURST=100 \
  node server/dist/index.js &   # npm -w server run build first
node /tmp/c4-fullscale/run-llm-live.mjs   # or adapt; raw output committed below
```

Raw live-endpoint transcripts (interpreted queries, top-5, latencies):
`data/evals/reports/llm-live-results.json`. Note: the first live attempt tripped
the server's own per-IP limiter (10 rpm — working as designed); the committed run
used the raised eval limits above.
