# LLM bake-off candidates — offline batch translation (FR→EN) + synonym generation

Scope: two OFFLINE batch pipeline tasks (`data/` workspace, not the live server): (a) FR→EN translation
of artwork titles/descriptions, short texts, high volume; (b) museum-vocabulary → plain-English synonym
generation (e.g. "Lar" → "household god statuette", "kylix" → "wine-drinking cup"). Both need JSON-schema
structured output; latency is irrelevant (batch); $/token and JSON reliability dominate. Incumbent
production model (server-side, live path, via `@google/genai`) is **`gemini-3.1-flash-lite`** — kept
separate from these pipelines, used here only as the pricing/quality baseline.

Pricing sourced 2026-07-05 from the public OpenRouter models catalog (`GET https://openrouter.ai/api/v1/models`,
no key required) — raw pricing is `$/token`; table below converts to `$/M tokens` for readability. Gemini
direct pricing cross-checked against `ai.google.dev/gemini-api/docs/pricing` and matches the OpenRouter
figures exactly, so OpenRouter is not adding a spread on Gemini at least.

## Full catalog pull — relevant families

| Model id (OpenRouter) | Prompt $/M | Completion $/M | Cache read $/M | Context | JSON structured output | Reasoning control | Prompt caching |
|---|---:|---:|---:|---:|---|---|---|
| `google/gemini-3.1-flash-lite` (incumbent) | 0.25 | 1.50 | 0.025 | 1,048,576 | yes (`response_format`, `structured_outputs`) | yes (`reasoning` effort levels) | yes, automatic |
| `google/gemini-2.5-flash-lite` (prior gen) | 0.10 | 0.40 | 0.01 | 1,048,576 | yes | yes | yes |
| `google/gemini-3.5-flash` | 1.50 | 9.00 | 0.15 | 1,048,576 | yes | yes | yes |
| `deepseek/deepseek-v4-flash` | 0.09 | 0.18 | 0.018 | 1,048,576 | yes | yes | yes |
| `deepseek/deepseek-v4-pro` | 0.435 | 0.87 | 0.0036 | 1,048,576 | yes | yes | yes |
| `deepseek/deepseek-v3.2` | 0.229 | 0.343 | 0.023 | 131,072 | yes | yes | yes |
| `qwen/qwen3.6-flash` | 0.1875 | 1.125 | — | 1,000,000 | yes | yes | write-side only reported |
| `qwen/qwen3.6-35b-a3b` | 0.14 | 1.00 | — | 262,144 | yes | yes | no |
| `qwen/qwen3.5-plus-20260420` | 0.30 | 1.80 | — | 1,000,000 | yes | yes | write-side only |
| `moonshotai/kimi-k2.7-code` | 0.74 | 3.50 | 0.15 | 262,144 | yes | yes, explicit `reasoning_effort` param | yes |
| `moonshotai/kimi-k2.6` | 0.66 | 3.41 | 0.14 | 262,144 | yes | yes | yes |
| `z-ai/glm-4.7-flash` | 0.06 | 0.40 | 0.01 | 202,752 | yes | yes | yes |
| `z-ai/glm-5.2` | 0.574 | 1.804 | — | 1,048,576 | yes | yes | not confirmed |
| `mistralai/mistral-small-3.2-24b-instruct` | 0.075 | 0.20 | — | 128,000 | yes | **no** (non-reasoning dense model) | no |
| `mistralai/mistral-medium-3-5` | 1.50 | 7.50 | — | 262,144 | yes | yes | not confirmed |
| `openai/gpt-oss-20b` | 0.029 | 0.14 | — | 131,072 | yes | yes | no |
| `openai/gpt-oss-120b` | 0.03 | 0.15 | — | 131,072 | yes | yes | no |
| `meta-llama/llama-4-scout` | 0.10 | 0.30 | — | 10,000,000 | yes | no | no |
| `meta-llama/llama-4-maverick` | 0.15 | 0.60 | — | 1,048,576 | yes | no | no |

Notes on the catalog scan:
- Meta Llama 4.x and OpenAI gpt-oss both **do** appear on OpenRouter (an earlier partial pull missed them);
  neither Llama family model exposes `reasoning` as a supported parameter — they're non-reasoning dense/MoE
  chat models, which is fine for translation/synonym tasks (no wasted reasoning tokens).
- Alibaba's dedicated **Qwen-MT** translation model (Qwen3-MT-turbo/plus) is *not* on OpenRouter at all —
  it's Alibaba Cloud Model Studio (DashScope) only, direct API. Worth knowing about but out of scope for an
  OpenRouter-routed pipeline unless a direct-to-DashScope integration is added later.
- "Reasoning control" = OpenRouter's unified `reasoning: {effort: none|low|medium|high|xhigh}` request field,
  present wherever `reasoning`/`include_reasoning` show up in `supported_parameters`. Setting `effort: none`
  suppresses reasoning-token spend entirely on models that support it — important for a cheap batch job
  where the task (translate a museum label) needs zero chain-of-thought.
- "Prompt caching" = OpenRouter reports a non-null `pricing.input_cache_read`, meaning the provider path
  does automatic prefix caching (useful here: pipeline can put the (long, static) system prompt / few-shot
  exemplars for "translate museum object titles" or "generate visitor synonyms" first, and pay the cache
  rate on every subsequent short item in the batch).

## Web-search findings (July 2026 snapshot)

- **General "best cheap translation LLM" roundups** still name GPT-4o/Gemini 2.5 Pro as frontier-quality
  anchors, but flag **Gemini Flash tiers** and **Llama 4 Maverick** specifically as the cheap-API picks for
  high-volume translation pipelines (~100M tok/month economics cited around $24/mo at Maverick pricing).
  [Best LLM for Translation 2026 — LLMversus](https://llmversus.com/llm/best-for/best-llm-for-translation),
  [Apiyi.com top-10 translation API guide](https://help.apiyi.com/en/best-llm-api-for-translation-2026-top10-guide-en.html)
- **WMT26** (this year's shared-task cycle) dropped French↔English as a tracked pair entirely this edition
  (focus shifted to lower-resource pairs); no fresh FR-EN COMET leaderboard exists for 2026 to cite directly.
  [WMT26 general MT task](https://www2.statmt.org/wmt26/translation-task.html) — so FR→EN quality claims
  below are inferred from adjacent-language multilingual benchmarks and vendor claims, not a same-year
  FR-EN-specific leaderboard.
- **Qwen-MT** (Alibaba's dedicated MT-tuned model, not on OpenRouter) reports beating GPT-4.1-mini,
  Gemini-2.5-Flash and Qwen3-8B on WMT24 multilingual COMET/BLEU, plus human accept/excellence-rate wins
  across a 10-language panel that includes French — strongest *specific* MT-quality evidence found, but
  it's a signal for "Qwen's translation-tuned lineage is strong," not proof for the generic `qwen3.6-flash`
  chat model. [Qwen-MT blog](https://qwenlm.github.io/blog/qwen-mt/),
  [MarkTechPost Qwen3-MT coverage](https://www.marktechpost.com/2025/07/25/alibaba-qwen-introduces-qwen3-mt-next-gen-multilingual-machine-translation-powered-by-reinforcement-learning/)
- **Mistral** (Mistral Small family) is the one lab in this list that is *French*, trained French-first;
  no 2026 FR-EN-specific benchmark surfaced, but native French pretraining data share is the strongest
  a-priori argument for FR→EN label/description translation quality among the cheap tiers, and it's the
  cheapest non-reasoning dense model in the set ($0.075/$0.20 per M).
- **Chinese H1-2026 model wave**: DeepSeek V4 (Pro/Flash), Qwen 3.5/3.6/3.7, Kimi K2.5/K2.6/K2.7, GLM-5/5.1/5.2,
  MiniMax M2.5/M2.7/M3 all shipped this half; benchmark coverage found is overwhelmingly coding/agentic/math
  (SWE-Bench Pro, Terminal-Bench, BrowseComp), not translation. Qwen3.5 is called out as "strongest
  multilingual" among these but for CJK coverage, not FR-EN specifically.
  [BenchLM Chinese LLM ranking](https://benchlm.ai/blog/posts/best-chinese-llm),
  [DeepLearning.AI: Kimi K2.6 vs Qwen3.6 vs DeepSeek V4](https://www.deeplearning.ai/the-batch/kimi-k2-6-matches-open-qwen3-6-max-anddeepseek-v4-falls-just-behind-top-closed-models)
- **Gemini direct pricing baseline** (ai.google.dev, cross-checked): `gemini-3.1-flash-lite` = $0.25/M in,
  $1.50/M out, 1M context, free tier w/ reduced quota — confirmed byte-for-byte against the OpenRouter
  catalog entry. Prior-gen `gemini-2.5-flash-lite` remains available at $0.10/$0.40, a real 60-75% cost cut
  if 3.1's quality gain isn't needed for this task.
  [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing),
  [Gemini 3.1 Flash-Lite announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/)

## Recommended bake-off set (6 models, spanning price tiers)

Selected to span ~50x in price, keep the current production model as the control, and cover the two
axes that matter for this task (native-French pretraining vs. generic multilingual; reasoning-suppressible
vs. non-reasoning-by-design):

| Priority | Model id | Why it's in the bake-off |
|---|---|---|
| Control (incumbent) | `google/gemini-3.1-flash-lite` | Current production model; must anchor the comparison. |
| Cheaper-same-vendor | `google/gemini-2.5-flash-lite` | Tests whether the 3.1 quality bump is worth 2.5-3.75x the cost for this specific, simple task. |
| Cheapest frontier-adjacent | `deepseek/deepseek-v4-flash` | $0.09/$0.18 per M, 1M context, full JSON+reasoning-control+caching support; best $/token-to-capability ratio found. |
| Qwen flash tier | `qwen/qwen3.6-flash` | Qwen's translation-tuned lineage (Qwen-MT) is the strongest MT-quality signal found even though MT itself isn't on OpenRouter; this is the closest cheap proxy, 1M context. |
| French-native cheap | `mistralai/mistral-small-3.2-24b-instruct` | Only French-lab model in the set; cheapest non-reasoning dense model ($0.075/$0.20); worth testing specifically for FR→EN since it's pretrained French-first. |
| Absolute floor | `openai/gpt-oss-20b` | Cheapest model with full JSON structured-output support found in the catalog ($0.029/$0.14 per M); sanity-checks whether quality craters below the mid tier, and is open-weight (self-host escape hatch if OpenRouter/API costs ever matter more than dev time). |

Also worth a look if the bake-off wants a 7th/8th row: `z-ai/glm-4.7-flash` ($0.06/$0.40, cheap GLM tier
with caching) and `deepseek/deepseek-v3.2` ($0.229/$0.343, the more "battle-tested" DeepSeek generation
vs. the very new V4-Flash). Not in the core 6 only to keep the run count small.

## Practical notes for wiring this into `data/` pipelines

- Every model above supports `response_format`/`structured_outputs`, so a JSON schema for
  `{ "translation": string }` or `{ "synonyms": string[] }` will work uniformly — no need to fall back to
  prompt-based JSON coaxing on any of the 6.
- For models with `reasoning` support (all but Mistral Small and the Llama 4 pair), explicitly pass
  `reasoning: { effort: "none" }` in the batch — these are trivial-latency, trivial-difficulty tasks and
  paying for chain-of-thought tokens on every row would be pure waste at high volume.
  Mistral Small and Llama 4 don't have the toggle because they don't reason by default — nothing to disable.
- Put the shared instructions/few-shot exemplars first in the prompt and the per-item text last, since
  4 of the 6 candidates (Gemini both tiers, DeepSeek V4-Flash, and — for the write side — Qwen3.6-Flash)
  report non-null cache pricing on OpenRouter, so a static prefix should get materially cheaper on repeat
  calls within a batch run.
- No paid inference was run for this task — all figures are catalog/pricing/doc lookups only, per instructions.

## Post-bake-off addendum (2026-07-05, milestone G run)

- **Pricing re-pulled from the OpenRouter catalog on 2026-07-05 before the paid runs: zero drift** —
  all $/M figures in the table above matched byte-for-byte (incl. `deepseek/deepseek-v4-pro`, used as
  the bake-off judge at $0.435/$0.87).
- Two provider behaviors discovered during the run that the catalog does not tell you (details and
  measurements in `data/evals/reports/llm-bakeoff.md`):
  - `qwen/qwen3.6-flash`'s provider path (DashScope) **silently downgrades `json_schema` to
    `json_object`** and 400s unless the prompt literally contains the word "json" — 0% strict-schema
    compliance in practice despite `structured_outputs` in `supported_parameters`.
  - `deepseek/deepseek-v4-flash` mis-aligned an echo-keyed batch (term N echoed with term N−1's
    payload) while id-keyed batches were flawless — echo-keyed pipelines (current `synonyms.ts`)
    cannot trust it; id-keyed ones can.
- Bake-off outcome: FR→EN translation → `deepseek/deepseek-v4-flash`; synonym generation → keep
  incumbent `google/gemini-3.1-flash-lite`. See the report for CIs and the decision rationale.
