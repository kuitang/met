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

### Typo tolerance (`autocompleteFuzzy` — fires only on zero rows)

Two-stage vocabulary correction, the standard search-as-you-type pattern.
Correct spellings never touch it: the exact prefix query runs first and any
non-empty result returns unchanged, so the fast path carries **zero added
latency and zero regression risk**. Only a zero-row keystroke (e.g. "Harlw")
enters the fuzzy pipeline:

1. **Per-token triage.** Each token is probed against the real index
   (`objects_fts MATCH '"tok"*' LIMIT 1`); tokens that still prefix-match
   stay as-is, the rest get corrected ("monet watr lilies" only corrects
   "watr").
2. **Candidate generation** — `vocab` + `vocab_trigram` (build-db.ts): every
   distinct searchable token (len ≥ 3, diacritics folded) plus multi-word
   artist names, with document frequency — 24,241 terms, **+1.7 MB raw /
   +0.9 MB gzip** on met.sqlite (29.2 → 30.9 raw; budget was <3 MB). The
   trigram FTS index is queried with an OR of the trigrams of the token PLUS
   its adjacent-swap variants — a transposition ("mnoet") shares zero
   trigrams with its target, but one swap variant IS the target; bm25 over
   the OR ranks shared-trigram count, top 50 survive. Trigram feasibility was
   verified in all three shipped runtimes before building: better-sqlite3
   3.53.1 and `@sqlite.org/sqlite-wasm` 3.53.0 by live query, expo-sqlite's
   vendored 3.50.3 by amalgamation inspection (`SQLITE_ENABLE_FTS5` set on
   android/iOS/SPM; trigram is core FTS5 since 3.34).
3. **Rerank** by length-normalized Damerau-Levenshtein — the better of
   whole-term distance and distance to the candidate's prefix of the token's
   length (±1), so "harlw" is 1 edit from "harle(quin)", not 5 from
   "harlequin". Accept ≤ 0.34 (~1 edit per 3 chars); order by distance minus
   a small `log10(df)` bonus so near-ties go to common terms ("drgas" →
   degas/107 docs, not durgas/4).
4. **Compound splits as 1-edit siblings**: a missing space costs `1/len` on
   the same scale, and an index-validated split (both halves prefix-match the
   same row) wins only when strictly cheaper — "goldsword" (0.11) splits to
   `"gold"* AND "sword"*` over goldwork (0.22); "monnet" (tie at 0.17) stays
   monet, never mon|net. Splits also rescue corrections-less compounds
   ("eyeidol", "stilllife", "washingtoncrossing").
5. **Two-pass execution**: the original query re-runs with each bad token
   replaced by its best correction (complete vocab terms, unstarred — porter
   covers morphology; multi-word corrections like "van gogh" stay quoted
   phrases). Only if that returns zero rows does an OR-expanded variant (top
   3 corrections per token) run — the conservative pass keeps "osiriss" →
   osiris from being flooded by sibling osiride's shorter-title bm25 wins.
   Explicit `AND` between parts: FTS5 implicit AND does not parse next to
   parenthesized groups (a silent zero-rows failure mode, caught by the eval).
6. **Confident-or-nothing**: a token with no acceptable correction and no
   valid split vetoes the whole query — gibberish returns empty rather than
   noise, which is what bounds the false-positive rate below.

A met.sqlite predating the vocab tables degrades to the old empty-result
behavior (the fuzzy stage is try-caught) until the client re-downloads.

**Measured** (`data/evals/typo-cases.json`, 82 typo cases generated from real
catalog titles/artists across 8 error classes + 20 gibberish negatives;
runner `data/evals/run-typos.mjs`, also gated into `shared/search.test.ts`):

| metric | target | better-sqlite3 | sqlite-wasm (shipped web runtime) |
|---|---|---|---|
| recall@8, typo cases | ≥ 85% | **96% (79/82)** | **96% (79/82)** |
| false positives, 20 negatives | ≤ 10% | **10% (2/20)** | **10% (2/20)** |
| fuzzy-path latency | p95 < 30 ms | p50 1.7 / p95 4.9 ms | **p50 2.3 / p95 6.8 ms** |
| exact-path latency (unchanged) | — | p50 0.04 ms | p50 0.07 ms |

Per class: transposition 12/12, missing-letter 12/12, doubled-letter 10/10,
phonetic 10/10, word-boundary 8/8, multi-token 8/8, truncation+typo 9/10,
adjacent-key 10/12. The three misses are genuinely ambiguous 1-edit
alternatives the catalog itself supports — "monwt" → *Mont* Sainte-Victoire
(1 deletion) vs Monet (1 substitution), "turnef" → *Turned* armchair vs
Turner, "relicar" → relief+cartouches split vs reliquary (2 edits) — fixable
only with keyboard-adjacency edit costs, not worth the complexity at 96%.
The two negative FPs ("florpus" → florenus, "xylozonk" → xylophone-family
instruments) are legitimate ≤0.34 matches of nonsense to rare real terms;
tightening the threshold below them costs real recall (sfinx → sphinx scores
0.33).

## Tier 2 — all results (same module, plus filters)

The autocomplete query without LIMIT, plus plain WHERE filters: site
(Fifth Ave / Cloisters), floor, permanent vs. exhibition rotation, has-image.
This is the overflow target ("142 results for Monet") and runs in ~1 ms.
Typo tolerance is deliberately tier-1-only for now: a misspelled query
surfaces corrected suggestions as you type, and a zero-row tier-2 page
escalates to tier 3 per the existing design.

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
