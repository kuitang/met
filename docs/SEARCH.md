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
                      └ still <3 rows ► agentic search_catalog loop, ≤3 calls (2–3 s)
```

## Tier 1 — autocomplete (`shared/search.ts`, runs on device)

Every keystroke: normalize (lowercase, strip punctuation — this also neutralizes
FTS5 syntax injection), star every token (`"washington"* "cros"*`, implicit AND),
rank by weighted bm25 over `(title, artist, culture, classification, medium, tags)`
with weights `(10, 8, 3, 5, 2, 4)`, subtract a 2.0 boost for museum highlights,
join gallery floor inline, LIMIT 8. The FTS5 index uses `porter unicode61`
stemming ("swords"→"sword") and `prefix='2 3 4'` so short prefixes stay fast.

Measured on the full 44k-row catalog: **p50 0.30 ms, p95 11.7 ms** per query
(worst case is a 1-character prefix) — far inside a 10 ms keystroke budget.

An **amenity intent check** (`amenityIntent`) runs token-level before FTS:
"restroom", "where can i eat lunch", "lift", "water fountain" route to the
`amenities` table (16 restrooms, 9 dining, 55 elevators…) instead of the catalog.
Token-level matching with plural folding means "water lilies" still finds Monet.

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
   over-confident filter can't zero out recall. ≥3 rows → done
   (`method: "rewrite"`, p50 612 ms live).
2. **Bounded agentic loop (escalation)**: flash-lite gets one tool,
   `search_catalog(ftsQuery, filters)`, executed in-process against the same
   met.sqlite (top-10 lean rows back to the model), hard-capped at **3 tool
   calls**, then one structured ranking call. Only objectIDs the tool actually
   returned are rankable — a hallucinated ID is dropped. Returns
   `method: "agentic"` plus a one-line `why`. Measured 2.2–2.8 s; rare by design
   (0/13 escalations on the golden set).

Responses are LRU-cached by normalized query (1 h TTL, 500 entries; hits 12–15 ms).
Failure modes degrade, never break: no `GEMINI_API_KEY` → 503 `llm_unavailable`
(local tiers unaffected); missing met.sqlite → 503 `data_unavailable`, recovering
automatically when the nightly artifact lands; per-IP rate limit and a global
daily budget cap guard cost.

## Measured quality (Gate C, full catalog scale)

50 golden cases (`data/evals/search-cases.json`) against a 44,468-object DB —
97.7% of the live on-view set; full methodology, provenance and the failure
post-mortems in `data/evals/reports/search-eval.md`:

| Tier | Pass rate |
|---|---|
| autocomplete (26) | 26/26 — 100% |
| full results (11) | 11/11 — 100% |
| LLM interpret, live Gemini (13) | 11/13 — 85% |
| **overall** | **48/50 — 96%** |

The journey cases all pass: "washington crossing a river in a boat" → *Washington
Crossing the Delaware* in the top 2; "gold swords" → Swords via porter stemming;
"stone idol with big eyes" → the Tell Brak eye idols; "restroom" → amenity route.
The two failures are catalog-vocabulary leaps ("bronze statue of a roman household
god" — the catalog says *statuette of a Lar*; "beads from ancient mesopotamia" —
"mesopotamia" occurs in zero catalog rows).

## Latency budget

| Path | Measured | Budget | Notes |
|---|---|---|---|
| Autocomplete keystroke | p50 0.3 ms / p95 11.7 ms | <10 ms | local, 44k rows |
| All-results page | ~1 ms | <50 ms | local |
| Interpret, rewrite | p50 612 ms / p95 940 ms | <1.5 s | one flash-lite call |
| Interpret, agentic | 2.2–2.8 s | <4 s | rare escalation, ≤3 tool calls |
| Interpret, cached | 12–15 ms | — | server LRU; client also caches |

## What to watch at scale

- **Escalation trigger is count-based** (<3 rows), so a rewrite that returns 3+
  *wrong* rows never escalates — this is exactly how both golden failures slipped
  through. The measured fix, if those categories matter in practice: escalate on
  weak top-score too.
- **Vocabulary gaps** ("Lar", "mesopotamia", "sake"): the designed lever is
  index-time synonym expansion in `build-db.ts` (one-time batch LLM column), which
  fixes recall before any query-time model is involved. Deferred until real-user
  queries justify the batch cost; the eval now gives it a baseline.
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
