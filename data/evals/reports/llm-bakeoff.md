# LLM bake-off — offline pipeline models (milestone G)

**Decision report, 2026-07-05.** Which model should the offline `data/` pipelines use for
(1) FR→EN translation of Louvre records and (2) per-museum synonym generation — measured
BEFORE committing to the expensive full runs. Total measured spend: **$0.474** (budget $8; incl. the $0.172 prompt-variant follow-up arm).

**TL;DR**

| Pipeline | Recommendation | Why |
|---|---|---|
| FR→EN translation (Louvre) | **`deepseek/deepseek-v4-flash`** | Quality parity-to-better vs the incumbent (judge win-rate 0.556 [0.494, 0.619], ref-similarity delta −0.000 [−0.010, 0.010]), 100% schema compliance, **5.1× cheaper** ($0.028 vs $0.143 per 1k records). Runner-up: `mistralai/mistral-small-3.2-24b-instruct` (statistical tie, similar price). |
| Synonym generation (met + aic) | **Keep `gemini-3.1-flash-lite`** (incumbent) | Lowest noise by a significant margin — every challenger is worse with 95% CI excluding zero (best challenger +4.3pp [1.8, 7.0] noise) — best batch integrity, and the whole full-catalog run costs well under $1, so there is nothing worth saving. |

Everything below is reproducible for $0: `node data/evals/llm-bakeoff/task{1,2,3}-*.mjs`
(responses are disk-cached in `data/evals/llm-bakeoff/cache/`, gitignored; the committed
`results/cache-index.json` records every cached call's tokens/cost/latency).

## Method

- **Contestants** — the recommended 6 from `data/evals/llm-bakeoff/candidates.md`, all via
  OpenRouter `chat/completions` with `response_format: json_schema (strict)` and reasoning
  suppressed (`reasoning: {effort:"none"}`, ladder to `low`/absent where rejected):
  incumbent `google/gemini-3.1-flash-lite`, `google/gemini-2.5-flash-lite`,
  `deepseek/deepseek-v4-flash`, `qwen/qwen3.6-flash`,
  `mistralai/mistral-small-3.2-24b-instruct`, `openai/gpt-oss-20b`.
  **Caveat:** production calls Gemini through `@google/genai` directly; here the incumbent
  runs through OpenRouter for comparability. OpenRouter's Gemini pricing matched Google's
  direct pricing byte-for-byte at pull time (re-verified 2026-07-05, no drift vs candidates.md).
- **Judge** — `deepseek/deepseek-v4-pro`: the strongest cheap model that is in NO comparison
  (never a contestant). Every pair judged twice with A/B order swapped; positional
  disagreement or an explicit tie counts as a tie (win 1 / tie 0.5 / loss 0).
- **Stats** — paired per-item comparisons vs the incumbent; percentile bootstrap 95% CIs,
  1,000 seeded resamples (`lib.mjs bootstrapCI`). No claims without CIs.
- **Cost** — OpenRouter's measured `usage.cost` per call (not estimated), accumulated in
  `results/spend.json` with a hard stop at $6.50.

## Task 1 — FR→EN translation of Louvre records

**Data.** 200 live records sampled from collections.louvre.fr (≤2 req/s, UA
`MuseWalk-research/0.1 (kuitang@gmail.com)`); arks from a Wikidata SPARQL pull over
P9394 "Louvre Museum ARK ID" (3,999 arks, 1,473 with English labels). 73/200 on-view.
Fields translated per record: `{title, objectType, materialsAndTechniques, period}`
(period = `dateCreated[0].text`), batched 10 records/call, id-keyed. Committed fixture:
`data/evals/llm-bakeoff/louvre-sample.json`.

**Scoring.** (a) *Reference subset* — 101 records whose Wikidata item has an EN label:
normalized edit similarity (lowercase, diacritics/punctuation/articles stripped) of the
model's title vs the label, after stripping inventory-number suffixes from labels
("…animals-E 20008"). Absolute values are deflated because Wikidata labels are display
names, not literal translations (FR "statue" ↔ EN "Thot as baboon protecting a general
of Ramesses II") — that noise hits all models identically, so the **paired delta** is the
meaningful column. (b) *Judged subset* — 80 non-reference records, pairwise vs incumbent
with the debiasing above.

| Model | judge win-rate vs incumbent ±CI | ref-sim delta vs incumbent ±CI | ref-sim | schema | p50/call (10 rec) | measured $ | $/1k records |
|---|---|---|---|---|---:|---:|---:|
| gemini-3.1-flash-lite (incumbent) | — | — | 0.425 | 100% | 2.9 s | $0.0285 | $0.143 |
| **deepseek-v4-flash** | **0.556 [0.494, 0.619]** (18W/53T/9L) | −0.000 [−0.010, 0.010] | 0.425 | 100% | 11.2 s | $0.0056 | **$0.028** |
| qwen3.6-flash | 0.500 [0.431, 0.563] (15W/50T/15L) | −0.002 [−0.022, 0.020] | 0.423 | **0%** | 3.8 s | $0.0209 | $0.104 |
| mistral-small-3.2-24b | 0.494 [0.419, 0.563] (18W/43T/19L) | −0.009 [−0.026, 0.010] | 0.416 | 100% | 12.2 s | $0.0048 | $0.024 |
| gemini-2.5-flash-lite | 0.425 [0.356, 0.494] (10W/48T/22L) | −0.017 [−0.044, 0.003] | 0.408 | 100% | 2.4 s | $0.0082 | $0.041 |
| gpt-oss-20b | 0.156 [0.106, 0.212] (1W/23T/56L) | −0.085 [−0.126, −0.049] | 0.340 | 100% | 7.0 s | $0.0028 | $0.014 |

**Read.** deepseek-v4-flash is the only model whose judge win-rate CI sits at-or-above 0.5
(0.556, lower bound 0.494 — parity at worst) while matching the incumbent exactly on the
reference metric, at 1/5 the price. mistral-small and qwen are statistical ties on quality;
qwen is disqualified by schema behavior (below), mistral is a fine fallback.
gemini-2.5-flash-lite is measurably *worse* than its 3.1 sibling (win-rate CI upper bound
0.494 < 0.5) — the cheaper-same-vendor option buys nothing here. gpt-oss-20b craters:
it silently dropped 13% of records from batches (missing translation = automatic loss)
and loses 56/80 judged pairs — the price floor is below the quality floor.

**Recommendation (Task 1): `deepseek/deepseek-v4-flash`**, with id-keyed batches exactly as
in this harness. At Louvre scale (~500k records) the projected spend is ~$14 vs ~$71 for
the incumbent — and quality does not pay for the difference. Latency p50 11 s/batch is
irrelevant for an offline pipeline. Fallback: mistral-small-3.2-24b (same price class,
tie on quality, 100% schema).

## Task 2 — synonym generation (met + aic)

**Data.** 60 vocab values per museum (20 classifications + 20 cultures + 20 periods,
seeded sample from the committed snapshots: `data/snapshots/` for met,
`data/museums/aic/snapshots/` for aic) + 22 hand-verified vocabulary-leap probes
(all real catalog values/titles), run through the **verbatim prompts of
`data/src/synonyms.ts`** (VOCAB_PROMPT / TITLE_PROMPT; museum name swapped for AIC).

**Metrics.** *Noise rate* = per-term fraction of synonym phrases that are literal echoes of
the source value (substring either direction after normalization, incl. naive stem) or
gibberish (charset/length/shape heuristics) — lower is better; it maps directly to junk
tokens entering the FTS `synonyms` column. *Probe recall* = does the synonym set contain
the visitor phrase ("Lar"→household god, "Assyrian"→Mesopotamia, AIC "woodblock
print"→ukiyo-e, …). *Missing* = input terms not echoed back (batch-integrity failure —
production keys the cache on exact term echo).

| Model | noise ±CI | noise delta vs incumbent ±CI | probes | missing | schema | measured $ | $/1k values |
|---|---|---|---:|---:|---:|---:|---:|
| **gemini-3.1-flash-lite (incumbent)** | **0.060 [0.039, 0.081]** | — | 20/22 | 0.0% | 100% | $0.0102 | $0.072 |
| gemini-2.5-flash-lite | 0.103 [0.077, 0.132] | +0.043 [0.018, 0.070] | 21/22 | 0.0% | 100% | $0.0032 | $0.022 |
| deepseek-v4-flash | 0.132 [0.106, 0.159] | +0.076 [0.048, 0.108] | **11/22** | 1.4% | 100% | $0.0023 | $0.016 |
| mistral-small-3.2-24b | 0.150 [0.118, 0.185] | +0.086 [0.052, 0.125] | 21/22 | 0.7% | 100% | $0.0017 | $0.012 |
| qwen3.6-flash | 0.157 [0.126, 0.192] | +0.108 [0.073, 0.141] | 21/22 | 14.1% | 0% | $0.0128 | $0.090 |
| gpt-oss-20b | 0.356 [0.312, 0.407] | +0.296 [0.254, 0.341] | 19/22 | 0.0% | 100% | $0.0011 | $0.008 |

**Read.** The incumbent wins outright: every challenger's paired noise delta is positive
with a CI excluding zero. Two disqualifying behaviors surfaced:

- **deepseek-v4-flash returned the title batch OFF BY ONE** — each title was echoed with
  the *previous* title's synonyms ("Terracotta kylix" → "household god, guardian spirit";
  "Faience Ushabti" → "wine pitcher, ancient greek jug"). `synonyms.ts` matches results by
  term echo, so this would **silently poison the index** — 11/22 probes, delta −0.409
  [−0.636, −0.227]. (Its id-keyed Task-1 batches were fine; the failure is specific to
  echo-keyed association.)
- **qwen3.6-flash's OpenRouter provider (DashScope) silently downgrades `json_schema`** to
  `json_object` (and 400s unless the prompt contains the word "json"): 0% strict-schema
  compliance, flat `{term: [...]}` maps instead of `{entries:[...]}`, 14.1% of terms
  unmatched. Unusable without a provider-specific compatibility layer.

**Recommendation (Task 2): no change — keep `gemini-3.1-flash-lite`.** The documented full
Met run was ~$0.30 (docs/SEARCH.md); at the measured $0.072/1k values, even a 10-museum
fleet with 10k values each is ~$7 *one-time* and ~$0 nightly (incremental cache). The
cheapest challenger saves pennies and adds statistically certain noise to a column whose
whole purpose is precision at weight 1.

## Task 3 — interpret-rewrite awareness check (tiny; NOT a decision)

The 13 Met llm-tier goldens through each model with the exact production rewrite prompt
(`server/src/gemini.ts` interpretQuery + frequency-ordered 200/250 vocab block). Metric:
rewrites carrying the golden's key term(s). Runtime stays Gemini-locked (`@google/genai`,
architecture rule); this is only a capability signal.

| Model | key-term hits | schema | p50 |
|---|---:|---:|---:|
| gemini-3.1-flash-lite | 13/13 | 100% | 1.1 s |
| gemini-2.5-flash-lite | 13/13 | 100% | 0.7 s |
| deepseek-v4-flash | 13/13 | 92% | 1.7 s |
| gpt-oss-20b | 13/13 | 100% | 2.0 s |
| mistral-small-3.2-24b | 12/13 | 100% | 1.4 s |
| qwen3.6-flash | 12/13 | 0% | 0.9 s |

Signal: the rewrite task is easy for every price tier (deltas vs incumbent all include 0);
nothing here argues for or against the runtime lock.

## Spend

| Bucket | Calls | $ |
|---|---:|---:|
| 6 contestants × 3 tasks | 256 | $0.135 |
| judge (deepseek-v4-pro, 800 pair-orders, 579 unique after cache dedup) | 579 | $0.166 |
| prompt-variant arm (task 1b: 6 variant runs + 480 judge pair-orders) | — | $0.172 |
| **Total** | | **$0.474** |

Louvre/Wikidata/OpenRouter-catalog fetches: free. Everything is cached; full reruns are $0.

## What would change the answer

- **Task 1 → incumbent instead of deepseek-v4-flash** if: DeepSeek's OpenRouter provider
  pool becomes unreliable at pipeline volume (the off-by-one behavior appearing in
  *id-keyed* batches would be disqualifying — spot-check the first ~1k records of the full
  run for id/title coherence before letting it finish); or v4-flash pricing (currently
  $0.09/$0.18 per M) rises ~5× toward Gemini's; or the pipeline later needs FR *fields we
  didn't test* (long free-text descriptions — this eval covered short label fields only).
- **Task 1 → mistral-small** if data-governance ever prefers an EU/French provider at equal
  measured quality.
- **Task 2 → re-open the bake-off** if the incumbent's price rises sharply, or if a museum's
  vocabulary is dominated by non-English/non-Western terms where a challenger might close
  the noise gap (worth a $0.05 re-run of this harness per new museum); or if `synonyms.ts`
  switches to id-keyed batching, which removes the echo-alignment risk and would let
  deepseek/mistral be re-scored on noise alone.
- **Judge validity**: conclusions lean on deepseek-v4-pro as judge for Task 1's non-reference
  half. The reference-scored half (independent of any LLM judge) agrees with the ranking,
  which is the main guard against judge-family bias — but note the judge and the Task-1
  winner share a vendor; if that bothers us, a $0.20 re-judge with a different strong model
  (e.g. kimi-k2.6) on the same cached translations would settle it.
- **Sample bias**: Wikidata-linked Louvre records skew famous (73/200 on-view); if the full
  pipeline hits obscure records with heavy specialist vocabulary, the reference metric says
  nothing about them — mitigated by the judged half, which sampled unlabeled (more obscure)
  records.

## Prompting techniques (follow-up arm, 2026-07-05)

Question from Kui: *are there model-specific MT prompting techniques we should apply, or is a
straight prompt good enough?* Measured on the two Task-1 finalists over the same cached
200-record fixture (`task1b-prompt-variants.mjs`, +$0.172 spend; cumulative total $0.474).
**Answer: the straight prompt is good enough — no variant beat baseline with a CI excluding
the null, on either model.**

### What the literature says (research pass, July 2026)

- **Few-shot exemplars** are the best-documented MT prompt lever; template form barely
  matters, exemplar *quality* matters more than similarity to the query, and gains
  concentrate in low-resource pairs and long-form text
  ([Prompting PaLM for Translation](https://arxiv.org/pdf/2211.09102),
  [LLM-MT survey 2025](https://arxiv.org/pdf/2504.01919),
  [TreePrompt](https://arxiv.org/pdf/2510.03748)). Google's Vertex "Translation LLM"
  productizes exactly this (few-shot style/domain examples,
  [Google Cloud translate-text docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/translate/translate-text));
  no flash-lite-specific MT prompt guidance exists beyond it.
- **Glossary/terminology injection** (dictionary-based phrase-level prompting) helps rare
  domain terms but can hurt fluency when over-applied
  ([constraint-aware iterative prompting](https://arxiv.org/pdf/2411.08348),
  [WMT 2025 terminology shared task](https://arxiv.org/pdf/2510.17504)).
- **Chain-of-thought hurts MT** — word-by-word reasoning induces over-literalness (−8.8
  COMET EN→ZH measured in [arXiv 2309.11668](https://arxiv.org/pdf/2309.11668)); reasoning-token
  studies find thinking ≈ no-thinking for MT quality with T=0 best overall
  ([arXiv 2510.11919](https://arxiv.org/pdf/2510.11919)). Our harness already suppresses
  reasoning everywhere (`reasoning: {effort:"none"}`); the literature says keep it that way.
- **DeepSeek-specific**: DeepSeek's docs recommend thinking mode OFF for translation and
  publish temperature **1.3** for translation (sampling params are ignored in thinking mode) —
  [DeepSeek temperature guide](https://deepseekv4pro.com/guides/deepseek-temperature-parameter-guide),
  [machinetranslation.com DeepSeek review](https://www.machinetranslation.com/blog/deepseek-v3-translation-use).
  Academic replication finds T=0 performs as well or better.
- **Gemini flash-lite-specific**: nothing documented beyond generic few-shot ICL scaling
  ([Gemini 1.5 report](https://arxiv.org/pdf/2403.05530)).

### Measured variants

Baseline = the Task-1 prompt **verbatim** (stated in full in `results/task1b.json`
`.baselinePrompt`; note its third line already carries a conventional-EN-names
instruction, so V1's brief partially overlaps it). Cumulative arms: **V1** + 3-sentence
museum-catalog domain brief; **V2** = V1 + 6 hand-verified FR→EN exemplars spanning
title/objectType/materials/period; **V3** = model-specific per the research — deepseek:
V2 + temperature 1.3 (its documented MT setting); gemini: no documented temperature rec
exists, so fallback rule: V2 + a fixed-translation glossary of the fixture's 20 most
frequent materials terms. Scoring identical to Task 1 (101 referenced records, paired
delta vs baseline; position-debiased judge on 40 unreferenced records; bootstrap 95% CIs).

| Model / variant | ref-sim delta vs baseline ±CI | judge win vs baseline ±CI | schema | $/1k records |
|---|---|---|---:|---:|
| gemini-3.1-flash-lite baseline | — | — | 100% | $0.143 |
| + V1 domain brief | +0.002 [−0.002, 0.006] | 0.537 [0.487, 0.588] | 100% | $0.144 |
| + V2 few-shot | +0.004 [−0.001, 0.010] | 0.525 [0.463, 0.588] | 100% | $0.147 |
| + V3 glossary | +0.003 [−0.002, 0.009] | 0.475 [0.388, 0.563] | 100% | $0.143 |
| deepseek-v4-flash baseline | — | — | 100% | $0.028 |
| + V1 domain brief | −0.004 [−0.012, 0.002] | 0.463 [0.388, 0.525] | 100% | $0.028 |
| + V2 few-shot | −0.006 [−0.018, 0.005] | 0.550 [0.463, 0.637] | 100% | $0.030 |
| + V3 temp 1.3 | −0.002 [−0.013, 0.008] | 0.525 [0.438, 0.613] | 100% | $0.032 |

### Recommendation (what ships in translate.ts)

**Ship the baseline prompt, temperature 0, reasoning suppressed — for both models.** Every
CI straddles the null on both metrics for both finalists; the largest point estimate
(gemini V1, judge 0.537) bottoms out at 0.487. Cost deltas are within ±14% and every
variant is schema-clean, so none of the techniques is *harmful* — but with no measurable
quality gain there is no reason to carry the extra prompt mass. This matches the research:
few-shot and glossary gains concentrate in low-resource pairs, long-form text, and rare
terminology, whereas FR→EN short museum-label fields are maximally high-resource and the
baseline already encodes the one domain instruction that matters (conventional English
names). DeepSeek's documented temperature 1.3 showed no gain over T=0 — keep T=0 for
deterministic, cache-friendly pipeline runs. Revisit only if the pipeline starts
translating long free-text descriptions; few-shot + glossary are the first re-tests
(~$0.20 on this harness).

## Files

- Harness: `data/evals/llm-bakeoff/{lib,fetch-louvre,task1-translate,task1b-prompt-variants,task2-synonyms,task3-interpret,build-cache-index}.mjs`
- Fixture: `data/evals/llm-bakeoff/louvre-sample.json` (200 records)
- Results: `data/evals/llm-bakeoff/results/{task1,task1b,task2,task3,spend,cache-index}.json`
- Raw response cache: `data/evals/llm-bakeoff/cache/` (gitignored; delete to force live reruns)
