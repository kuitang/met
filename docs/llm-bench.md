# LLM benchmarks — model choices, measured performance, cost

Canonical benchmark record for the Met Navigator LLM surface. Everything here is
**measured, not estimated**; each section names its raw data. Provider is **locked
to Gemini** (`@google/genai`, all calls server-side in `server/src/gemini.ts`) —
the lock was a user decision made *after* the head-to-head numbers below, not a
prior; the OpenAI rows are retained as the evidence.

## 1. Planning-phase benchmark (2026-06-10, synthetic corpus)

16 real on-view objects (7 famous / 9 obscure incl. 3D), catalog images degraded
into "visitor photos", 8 synthesized wall labels shot at angles, 10 interpretation
queries with goldens. Raw JSON: `data/evals/planning-bench/results/`; regeneration:
`data/evals/planning-bench/FETCH.md`.

| Model | Interpret acc / p50 / $ | Label OCR acc / p50 / $ | Artwork-ID acc (famous/obscure) |
|---|---|---|---|
| **gemini-3.1-flash-lite** | **100% / 587 ms / $0.00010** | **100% / 1197 ms / $0.00036** | 63% (4/7, 6/9) @ 936 ms |
| gemini-3-flash-preview | 100% / 1042 ms / $0.00021 | 100% / 1499 ms / $0.00071 | 69% (5/7, 6/9) @ 1049 ms |
| gpt-5.4-mini | 100% / 1548 ms / $0.00047 | 100% / 1868 ms / $0.00123 | 38% (4/7, 2/9) @ 2846 ms |
| gpt-5.4-nano | 100% / 1248 ms / $0.00007 | 100% / 1745 ms / $0.00032 | 19% (3/7, 0/9) @ 1838 ms |
| **gemini-embedding-2 retrieval** | — | — | **100% top-1 (16/16)**, embed p50 963 ms |

### Real guest photos (published Met benchmark, cmp.felk.cvut.cz/met)

40 real visitor photos with ground truth, 158-image catalog gallery, identical
queries for every approach. Raw: `results/real-guest-photos.json`.

| Approach | Accuracy | p50 | $/call |
|---|---|---|---|
| **gemini-embedding-2 retrieval** | **90% top-1, 95% top-5** | 843 ms | ~$0.0001 |
| gemini-3-flash-preview LLM-ID | 65% | 1149 ms | $0.00065 |
| gemini-3.1-flash-lite LLM-ID | 52% | 1016 ms | $0.00033 |
| gpt-5.4-mini LLM-ID | 17% | 3531 ms | $0.00180 |
| gpt-5.4-nano LLM-ID | 2% | 2271 ms | $0.00031 |

### What the numbers decided

1. **Interpretation and label OCR are commoditized** — every mini model scored
   100%; choose on latency and cost → `gemini-3.1-flash-lite` (2–3× faster than
   the GPT minis at equal or lower cost).
2. **LLM image identification is disqualified** — on real visitor photos the GPT
   minis collapse (17% / 2%) and even Gemini minis trail retrieval by 25–38 pts.
   Identification must be grounded in an embedding index; the LLM only reads text
   (wall labels). `gemini-embedding-2` (multimodal, 768d) is the index model.
3. **Gemini-only lock**: with Gemini winning or tying every task on accuracy,
   latency and cost, a provider abstraction would be speculative flexibility with
   zero payoff — exactly what the project's parsimony rule forbids. One thin
   client (`server/src/gemini.ts`), no adapters.

## 2. Gate C: interpret endpoint at full catalog scale (2026-06-10)

Live `POST /api/v1/search/interpret` (rewrite → relaxed FTS → bounded agentic
fallback), real `gemini-3.1-flash-lite`, against a 44,468-object met.sqlite (97.7%
of the live on-view set; build provenance in `data/evals/reports/search-eval.md`).
Vocabulary prompt at full scale: 200 classifications + 250 cultures ≈ **2.1k
tokens** (the catalog itself is never sent).

| Measurement | Value | Source |
|---|---|---|
| llm-tier golden pass rate (13 cases) | **11/13 (85%)**; 48/50 (96%) across all tiers | `data/evals/reports/llm-live-results.json` |
| Rewrite-path latency (cold, n=13) | **p50 612 ms, p95 940 ms** | same |
| Agentic-path latency (fixture DB, C2 run) | 2.2–2.8 s, hard-capped at 3 tool calls | C2 live transcripts (interpret task) |
| Server LRU cache hit | 12–15 ms | measured against :8899 |
| Escalation rate on goldens | 0/13 (rewrite always found ≥3 rows) | llm-live-results.json |

All 13 goldens resolved via the cheap rewrite path; the two failures ("Lar",
"mesopotamia") are catalog-vocabulary leaps analyzed in the search eval report —
they fail identically on every model class because the words simply do not occur
in the catalog text.

### 2b. Phase 2 re-measure (same day): synonyms column + score-aware escalation

After the gate-approved upgrades (index-time `synonyms` FTS column from
`data/src/synonyms.ts`; escalation on `rows < 3 OR top-1 bm25 > −11.5`), live
re-run against the rebuilt full-scale DB:

| Measurement | Value |
|---|---|
| llm-tier golden pass rate | **13/13 (100%)**; 50/50 across all tiers |
| Rewrite-path latency (cold, n=13) | p50 ~610 ms (unchanged) |
| Escalation rate on goldens | still 0/13 — the threshold adds no cost on healthy queries |
| Synonyms batch (3,501 vocab values + 3,577 titles, ~177 flash-lite calls) | **≈$0.30 one-time** (estimated from output volume at $0.25/$1.50 per 1M; run log not retained) |
| Synonyms nightly incremental rerun, unchanged catalog | **$0.000 measured** (0 calls — the json is a cache keyed by value/title) |

The escalation threshold experiment (healthy top-1 −12.60…−53.98 vs. low-signal
−5.59…−12.12) is documented in `data/evals/reports/search-eval.md`; the
weak-score path only fires on queries whose terms barely occur in the catalog,
adding the ~$0.003 agentic cost exactly where the cheap path is known-bad.

## 3. Photo localization at full index scale (2026-06-10, production index)

Full-scale measurement, superseding the planning-phase 158-image-gallery numbers.
Full methodology, miss taxonomy and raw per-query rows:
`data/evals/reports/photo-locate.md` (+ `.json`).

**Setup**: the COMPLETE production index (33,640 vectors / 30,623 unique on-view
objects, gemini-embedding-2 768d) × the published Met benchmark's real visitor
photos (NeurIPS 2021). Of 1,003 ground-truthed testset queries, **722 qualify**
(GT object in the index; 280 of the rest are 2021 photos of objects not in
today's on-view catalog, 1 is a pipeline gap). Deterministic stratified sample
of **500 queries across 157 galleries**; query embedding + cosine math replicate
the server (`gemini.ts embedImage` / `embeddings.ts searchByEmbedding`) exactly.

| Metric | Full scale (30.6k objects) | Planning bench (158-image gallery) | DINOv3 published (224k classes, self-hosted) |
|---|---|---|---|
| top-1 object | **81.2% (406/500)** | 90% (36/40) | 80.7% |
| top-5 object | **91.0% (455/500)** | 95% (38/40) | — |
| top-1 **gallery** (the localization metric) | **86.8% (434/500)** | — | — |

Live endpoint pass (40 stratified photos, prod server, real Gemini): 40/40 OK,
**p50 849 ms / p95 1,254 ms** end-to-end (concurrent OCR + embed), top-3
contains GT 32/40 (80%), OCR path returned `label: null` on 39/40 artwork
photos (the 1 non-null was a real wall label legible in frame, deterministically
matched — correct behavior), and **40/40 live↔offline top-1 parity**.

Misses are dominated by extreme close-up/odd-angle shots of 3D objects vs. the
single catalog view, near-duplicate siblings/casts (wrong objectID, same work —
gallery still correct), and vitrine-glass degenerate framings; median miss is a
near-tie (GT 0.018 cosine below the wrong top-1), so top-5 recovers half of
them. **DINOv3 self-hosted upgrade gate: not triggered** — the hosted index
matches DINOv3's published top-1 at the top of the planning bracket (75–85%);
verdict and revisit conditions in photo-locate.md.

## 4. Cost model (measured per-call, projected)

Prices: flash-lite $0.25/1M in, $1.50/1M out; gemini-embedding-2 ~$0.00012/image.

| Call | Tokens (measured shape) | $/call |
|---|---|---|
| Interpret rewrite | ~2.2k in (2.1k vocab + query) + ~60 out | **~$0.00065** |
| Interpret agentic (≤3 tool calls + ranking call) | 4 calls, growing context | ~$0.003 |
| Label OCR (`media_resolution: LOW`, 280 tok/image) | ~0.5k in + ~50 out | ~$0.0004 |
| Photo embed (query image) | 1 image | ~$0.00012 |
| One-time image index (34k on-view images) | — | ~$4 one-time, incremental nightly |
| Synonyms batch (7,078 terms, 40/call) | ~550 in + ~1k out per call | ≈$0.30 one-time, **$0 measured** nightly incremental |

Planning bench measured $0.00010/interpret with its toy ~10-entry vocabulary; the
full-scale 2.1k-token vocabulary raises it to ~$0.00065. If the vocab block ever
grows past a few k tokens, `ai.caches` context caching is the documented next step
(storage $1.00/1M tok/h makes it break-even only above roughly steady traffic).

**Projection at 1,000 interpret queries/day** (worst case: zero cache hits, every
query LLM-bound): 1,000 × $0.00065 × 30 ≈ **$20/month**. Realistically lower: the
server LRU (1 h TTL) and client cache absorb repeats, and tier 3 only fires when
local search returns <3 hits. Photo locate at 200 photos/day ≈ (OCR + embed)
× 200 × 30 ≈ **$3/month**. Abuse ceiling is enforced independently of cost
assumptions: per-IP rate limit (10 rpm) + `LLM_DAILY_BUDGET` (2,000 calls/UTC-day
≈ $1.30/day worst-case ≈ $40/month hard cap).

## 5. Re-running

```sh
# planning bench (OpenAI rows need: source ~/openai_key.sh)
cd data/evals/planning-bench && node bench.mjs            # see FETCH.md for corpora
# full-scale interpret eval
#   build eval DB + run goldens + live tier-3: see data/evals/reports/search-eval.md
# full-scale photo eval: methodology + verbatim scripts in
#   data/evals/reports/photo-locate.md / .json (provenance field)
```
