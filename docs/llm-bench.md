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

## 3. Photo localization at full index scale — **pending**

The Gate C photo eval (real handheld photos vs. the production embedding index)
is owned by the C3 stream; at the time of writing its embedding pipeline is still
hydrating/embedding (~1,600 objects for the eval departments; the committed
`data/snapshots/image-embeddings/` index holds a partial shard). Until it lands,
the planning-phase real-guest-photo numbers above (90% top-1 / 95% top-5 over a
158-image gallery) are the best measurement, bracketed below by DINOv3's published
80.7% top-1 over 224k classes on the same benchmark. Expect the full-scale top-1
to land between those bounds; `data/evals/photo-locate-eval.mjs` is the runner.

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
# photo eval (once C3's index is complete)
node data/evals/photo-locate-eval.mjs
```
