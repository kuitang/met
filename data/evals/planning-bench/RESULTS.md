# Planning-phase LLM benchmark results (run 2026-06-10)

All numbers recomputed from the raw JSON in `results/` (they match the tables in the
approved plan). Scripts and corpus definitions live alongside this file; image sets
are regenerated per `FETCH.md`.

## Synthetic corpus

16 real on-view Met objects (7 famous / 9 obscure, incl. 3D: mace, beads, eye idol);
catalog images degraded into "visitor photos" (`degrade.py`: perspective, rotation,
dim, glare, blur); 8 synthesized wall labels photographed at angles; 10 search
queries with goldens. Raw: `results/llm-bench.json` (+ `results/llm-bench-openai.json`,
a GPT rerun after a `json_object` request-format quirk failed the first GPT pass) and
`results/embed-retrieval.json`.

| Model | Interpret acc / p50 / $ | Label OCR acc / p50 / $ | Artwork-ID acc (famous / obscure) |
|---|---|---|---|
| gemini-3.1-flash-lite | 100% (10/10) / 587 ms / $0.00010 | 100% (8/8) / 1197 ms / $0.00036 | 63% (4/7, 6/9) @ 936 ms |
| gemini-3-flash-preview | 100% (10/10) / 1042 ms / $0.00021 | 100% (8/8) / 1499 ms / $0.00071 | 69% (5/7, 6/9) @ 1049 ms |
| gpt-5.4-mini | 100% (10/10) / 1548 ms / $0.00047 | 100% (8/8) / 1868 ms / $0.00123 | 38% (4/7, 2/9) @ 2846 ms |
| gpt-5.4-nano | 100% (10/10) / 1248 ms / $0.00007 | 100% (8/8) / 1745 ms / $0.00032 | 19% (3/7, 0/9) @ 1838 ms |
| **gemini-embedding-2 retrieval** | — | — | **100% top-1 (16/16)** over 76-image gallery, embed p50 963 ms |

## Real guest photos (published Met benchmark, cmp.felk.cvut.cz/met)

40 real visitor query photos from `test_met.tar.gz` with ground truth, 158-image
catalog gallery, all approaches on identical queries. Raw:
`results/real-guest-photos.json`.

| Approach | Accuracy | p50 | $/call |
|---|---|---|---|
| **gemini-embedding-2 retrieval** | **90% top-1 (36/40), 95% top-5 (38/40)** | 843 ms | ~$0.0001 |
| gemini-3-flash-preview LLM-ID | 65% (26/40) | 1149 ms | $0.00065 |
| gemini-3.1-flash-lite LLM-ID | 52% (21/40) | 1016 ms | $0.00033 |
| gpt-5.4-mini LLM-ID | 17% (7/40) | 3531 ms | $0.00180 |
| gpt-5.4-nano LLM-ID | 2% (1/40) | 2271 ms | $0.00031 |

## Conclusions (carried into the locked architecture)

1. Interpretation and label OCR are commoditized — every mini model is perfect;
   chosen on latency/cost: **gemini-3.1-flash-lite**.
2. LLM image *identification* collapses on real visitor photos (GPT minis 17%/2%;
   even Gemini minis trail retrieval) — identification must be grounded in an
   embedding index; the LLM only reads text (labels).
3. **gemini-embedding-2 retrieval at 90/95% on real photos** validates the API-only
   photo-locate pipeline. Production gallery is 34k images (vs 158 here), so expect
   some top-1 erosion; Gate C re-measures at full index scale (DINOv3-vitb16
   self-hosted is the upgrade path).
