# Search — three tiers, one database, one server hop

How a visitor's query — from "mon" to "that huge painting of washington crossing a
river in a boat" — becomes a ranked list of objects with gallery numbers. Design
rule (locked): **no index fragmentation**. One SQLite file (`met.sqlite`) is the
entire search index; it is built nightly, downloaded to every client, and queried
locally. The only server hop is the LLM tier, and even that executes against the
same file.

```
keystroke ──► Tier 1  autocomplete   local FTS5, top 8        p50 0.3 ms
   │
   ├────────► Tier 2  all results    local FTS5 + filters     ~1 ms
   │             │  <3 hits, or "Ask differently"
   └─────────────▼
              Tier 3  POST /api/v1/search/interpret           p50 0.6 s
                      flash-lite rewrite ► relaxed FTS (server-side met.sqlite)
                      └ <3 rows OR weak top score ► agentic search_catalog loop,
                        ≤3 calls (2–3 s)
```

A fourth, invisible lever runs at **index time**: an LLM-generated `synonyms`
FTS column (visitor vocabulary the catalog doesn't use — "household god" for
*Lar*, "Mesopotamia" for Assyrian/Babylonian/Sumerian cultures) built by
`data/src/synonyms.ts` and refreshed nightly for ~$0 (see below).

## Tier 1 — autocomplete (`shared/search.ts`, runs on device)

Every keystroke: normalize (lowercase, strip punctuation — this also neutralizes
FTS5 syntax injection), star every token (`"washington"* "cros"*`, implicit AND),
rank by weighted bm25 over `(title, artist, culture, classification, medium,
tags, synonyms)` with weights `(10, 8, 3, 5, 2, 4, 1)`, subtract a 2.0 boost for
museum highlights, join gallery floor inline, LIMIT 8. The FTS5 index uses
`porter unicode61` stemming ("swords"→"sword") and `prefix='2 3 4'` so short
prefixes stay fast. The `synonyms` column is weighted minimally (1) on purpose:
weights 2–3 measurably regressed "blue ming vases" (period-synonym noise
outranking literal "vase" titles); weight 1 adds recall without ever outranking
a literal match.

Measured on the full 44k-row catalog: **p50 0.30 ms, p95 11.7 ms** per query
(worst case is a 1-character prefix) — far inside a 10 ms keystroke budget.

An **amenity intent check** (`amenityIntent`) runs token-level before FTS:
"restroom", "where can i eat lunch", "lift", "water fountain" route to the
`amenities` table (16 restrooms, 9 dining, 55 elevators…) instead of the catalog.
Token-level matching with plural folding means "water lilies" still finds Monet.

**Digit queries + room rows.** The accession column is deliberately NOT in
`objects_fts` (digits live almost exclusively there — "21.131" — while titles
rarely carry them), so digit-bearing queries union in an accession
LIKE-containment scan (`buildAccessionSearchQuery`; measured 0.6 ms over the
full 44.8k catalog). FTS bm25 hits rank first, accession hits append deduped.
Above the object rows the omnibar (and All Results) shows **room rows**:
galleries via `matchGalleries` (digit query → exact gallery number, then
number prefixes, cap 4; letter query → title-word prefix match, "dendur" →
The Temple of Dendur) and amenities nearest-first. Room rows have one anatomy
(kind glyph, name, floor chip — no inline buttons) and one tap grammar: home
map, floor switched, room highlighted, dual-action sheet (DIRECTIONS /
I'M HERE) open. Known limitation: the Great Hall has no gallery polygon in
the Living Map data, so "great hall" surfaces its amenities (Great Hall
Balcony Cafe, the escalator) rather than a gallery row.

## Tier 2 — all results (same module, plus filters)

The autocomplete query without LIMIT, plus plain WHERE filters: site
(Fifth Ave / Cloisters), floor, permanent vs. exhibition rotation, has-image.
This is the overflow target ("142 results for Monet") and runs in ~1 ms.

## Tier 3 — LLM interpret (the only server hop)

When local search yields <3 hits, the client makes **one** round trip; everything
LLM-related completes server-side (`server/src/routes/interpret.ts`).

**How the catalog meets Gemini — never by pasting it.** 45k records ≈ 1M+ tokens:
slow, expensive, and lossy. Instead the prompt carries only the catalog's
**vocabulary** — its actual distinct classification and culture values (200 + 250
entries ≈ 2.1k tokens, generated from met.sqlite and cached per DB handle in
`server/src/vocab.ts`). Two layers:

1. **Rewrite (default)**: one `gemini-3.1-flash-lite` call with structured JSON
   output → `{ftsQuery, filters}`. The server executes it with AND→OR relaxation
   (stopwords dropped, bm25 ranks rows matching more terms first); LLM filter
   values are folded in as soft OR-terms rather than hard WHEREs, so an
   over-confident filter can't zero out recall. ≥3 rows **and a healthy top
   score** → done (`method: "rewrite"`, p50 612 ms live).
2. **Bounded agentic loop (escalation)**: flash-lite gets one tool,
   `search_catalog(ftsQuery, filters)`, executed in-process against the same
   met.sqlite (top-10 lean rows back to the model), hard-capped at **3 tool
   calls**, then one structured ranking call. Only objectIDs the tool actually
   returned are rankable — a hallucinated ID is dropped. Returns
   `method: "agentic"` plus a one-line `why`. Measured 2.2–2.8 s; rare by design
   (0/13 escalations on the golden set).

**Score-aware escalation (the Gate C fix, measured).** The original trigger
(`<3 rows`) never fired when the rewrite returned ≥3 *wrong* rows. The trigger
is now `rows < 3 OR rows[0].score > −11.5` (SQLite bm25 is negative; > −11.5
means "weak"). The −11.5 constant is empirical, from live runs against the
full-scale synonyms DB: all 13 healthy llm-tier goldens score −12.60…−53.98 at
top-1, while low-signal/out-of-catalog rewrites ("mona lisa" −5.59, "dinosaur
bones" −10.42) sit above −10.5 — the threshold bisects the gap, giving 0 false
escalations on the golden set while catching queries whose terms barely occur
in the catalog. Known limit: a *strong-but-wrong* rewrite (pre-synonyms
"roman household god" top-1 −29.33) is indistinguishable from a good one by
score — that failure mode is fixed at the index by the synonyms column, not at
query time. Full experiment: `data/evals/reports/search-eval.md`.

## Index-time synonym expansion (`data/src/synonyms.ts`)

Fixes vocabulary mismatch before any query-time LLM is involved. A flash-lite
batch expands every distinct culture/period/classification value (3,501) plus
object titles in the antiquities classifications where Gate C measured
vocabulary leaps (3,577 titles: Bronzes, Vases, Terracottas, Gold and Silver,
Stone Sculpture, Gems, Glass) into plain visitor words — *Lar* → "household
god, guardian spirit"; Assyrian/Babylonian/Sumerian/ancient-Iranian cultures
all gain "Mesopotamia". Output lands in `data/snapshots/synonyms.json`
(~177 batched calls, ≈$0.30 one-time); `build-db.ts` joins it into the
FTS-indexed `synonyms` column. The file is a cache keyed by exact value/title:
the nightly refresh reruns the script and only catalog-**new** entries hit
Gemini (measured $0.000 on an unchanged catalog). Result: **50/50 goldens**
(was 48/50) with the two Gate C misses now passing through plain local FTS.

Responses are LRU-cached by normalized query (1 h TTL, 500 entries; hits 12–15 ms).
Failure modes degrade, never break: no `GEMINI_API_KEY` → 503 `llm_unavailable`
(local tiers unaffected); missing met.sqlite → 503 `data_unavailable`, recovering
automatically when the nightly artifact lands; per-IP rate limit and a global
daily budget cap guard cost.

## Measured quality (full catalog scale, after the Phase 2 upgrades)

50 golden cases (`data/evals/search-cases.json`) against a 44,468-object DB
rebuilt with the synonyms column — 97.7% of the live on-view set; full
methodology, provenance and the Gate C failure post-mortems in
`data/evals/reports/search-eval.md`:

| Tier | Gate C | with synonyms + score-aware escalation |
|---|---|---|
| autocomplete (26) | 26/26 | **26/26 — 100%** |
| full results (11) | 11/11 | **11/11 — 100%** |
| LLM interpret, live Gemini (13) | 11/13 | **13/13 — 100%** |
| **overall** | 48/50 | **50/50 — 100%** |

The journey cases all pass: "washington crossing a river in a boat" → *Washington
Crossing the Delaware* in the top 2; "gold swords" → Swords via porter stemming;
"stone idol with big eyes" → the Tell Brak eye idols; "restroom" → amenity route.
The two Gate C failures (catalog-vocabulary leaps: *statuette of a Lar*,
"mesopotamia" in zero catalog rows) now pass via the synonyms column — through
the cheap rewrite path, no escalation needed.

## Latency budget

| Path | Measured | Budget | Notes |
|---|---|---|---|
| Autocomplete keystroke | p50 0.3 ms / p95 11.7 ms | <10 ms | local, 44k rows |
| All-results page | ~1 ms | <50 ms | local |
| Interpret, rewrite | p50 612 ms / p95 940 ms | <1.5 s | one flash-lite call |
| Interpret, agentic | 2.2–2.8 s | <4 s | rare escalation, ≤3 tool calls |
| Interpret, cached | 12–15 ms | — | server LRU; client also caches |

## What to watch at scale

- **Escalation threshold drift**: −11.5 was tuned on today's catalog + golden
  set. A nightly rebuild shifts bm25 corpus statistics slightly; if escalation
  rate creeps up (cost) or weak junk stops escalating (quality), re-run the
  threshold experiment in `search-eval.md` against the current DB.
- **Synonym quality**: the column is LLM-generated; a bad synonym is weighted 1
  so it can add noise rows but never outranks literal matches. The goldens guard
  the known cases; spot-check `data/snapshots/synonyms.json` when a search
  regression appears.
- **Vocab prompt growth**: 2.1k tokens today. If distinct classifications/cultures
  grow it past a few k, switch to `ai.caches` context caching (priced in
  `docs/llm-bench.md`).
- **Cache hit rate / cost**: worst-case $20/mo at 1k interpret queries/day; watch
  the LRU hit rate and the daily budget counter once public.
- **Eval refresh**: `shared/search.test.ts` auto-runs all 50 goldens against
  `data/met.sqlite` on every `npm -w shared run test` once the production artifact
  exists (≥70% regression floor); the on-view set rotates (the Great Wave is off
  view today), so expect occasional golden maintenance of the kind documented in
  the eval report.
