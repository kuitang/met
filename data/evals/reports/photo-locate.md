# Photo-locate eval — full-scale vision benchmark (NeurIPS Met guest photos × 33.6k index)

*Run 2026-06-10 against the COMPLETE production embedding index and the live
prod server. Raw per-query rows: `photo-locate.json` next to this file. This
supersedes the planning-scale (158-image gallery) numbers, kept below as the
history row.*

## Setup

- **Index under test**: `data/snapshots/image-embeddings/` — the production
  artifact the server loads: **33,640 vectors / 30,623 unique on-view objects**
  (gemini-embedding-2, 768d, L2-normalized; the 3,017 extra rows were verified
  to be exact duplicate stale rows from re-embedding — every one has a mapped
  twin at cosine ≥ 0.999, so they never change a result). met.sqlite
  dataVersion `2026-06-10-2e5aaf37`, 44,842 on-view objects.
- **Queries**: real visitor photos from the published Met benchmark
  ("The Met Dataset", NeurIPS 2021, cmp.felk.cvut.cz/met). `test_met/` holds
  1,132 photos = 1,003 testset + 129 valset queries; we use the **1,003
  testset queries**, each ground-truthed to a Met objectID.
- **Join against the index**: **722/1,003 queries qualify** (GT objectID is in
  the embedding index; 515 distinct objects). The 281 excluded: **280** have a
  GT object that is not in today's on-view catalog at all (the photos are
  2021-vintage; those objects are off view / have no current gallery), **1**
  (objectID 551890) is on view with an image but missing from the index — a
  single pipeline gap (99.997% coverage of eligible objects).
- **Query set**: 722 > 600, so a **deterministic stratified sample of 500**
  (sort qualifying queries by (gallery, path), stride-pick i·722/500 — spans
  157 galleries). Query embeddings replicate `server/src/gemini.ts embedImage`
  exactly (`@google/genai` `embedContent`, inlineData image/jpeg,
  `outputDimensionality: 768`, no task framing), cached resumably in /tmp.
- **Scoring**: brute-force cosine against the full index — identical math to
  `server/src/embeddings.ts searchByEmbedding` (pre-normalized rows, normalized
  query, dot = cosine), deduped to object level.

## Results — bulk (500 real guest photos vs the full 33.6k-vector index)

| Metric | Full scale (this run) | History: planning bench (158-image gallery, 40 photos) |
|---|---|---|
| top-1 object accuracy | **81.2% (406/500)** | 90% (36/40) |
| top-5 object accuracy | **91.0% (455/500)** | 95% (38/40) |
| **gallery-level top-1** (top-1 candidate's gallery == GT gallery — the metric that matters for localization) | **86.8% (434/500)** | — |
| reference bracket | DINOv3 (self-hosted, published): 80.7% top-1 @ 224k classes | — |

Confidence separation (cosine similarities):

| Population | median |
|---|---|
| hits: GT similarity | 0.887 |
| hits: margin over best wrong | **+0.052** |
| misses: wrong top-1 similarity | 0.831 |
| misses: GT deficit below wrong top-1 | −0.018 |

Hits are comfortably separated; misses are mostly *near*-ties (median deficit
0.018), which is why top-3/top-5 recovers so much: of the 94 top-1 misses, 49
still have GT in the top-5 and 28 land the correct gallery anyway.

## Results — live endpoint (40 stratified photos, prod server, real Gemini, no mock)

`POST /api/v1/locate/photo`, prod build (`server/dist`), `DATA_DIR=data`, full
index loaded in RAM (33,640 × 768d ≈ 104 MB):

| Metric | Value |
|---|---|
| requests OK | 40/40 (0 errors, 0 crashes) |
| end-to-end latency | **p50 849 ms / p95 1,254 ms** (OCR + embed run concurrently per request) |
| top-1 / top-3-contains-GT | 30/40 (75%) / **32/40 (80%)** |
| top-1 gallery correct | 32/40 (80%) |
| OCR path on artwork photos | **39/40 `label: null`** as designed |
| live ↔ bulk parity | **40/40 identical top-1 verdicts** — the endpoint reproduces the offline math exactly |

The 40-photo subsample is simply a harder draw (bulk math on the same 40 gives
the same 30/40). The single non-null label is *correct behavior*: photo
`148a000d3cc3.jpg` has a real wall label legible in frame; flash-lite read
accession `1979.206.314` and the deterministic met.sqlite match returned that
object (*Equestrian figure*, gallery 343) — the label-read path doing its job
on a guest photo, while the embedding path independently returned candidates.

## Miss taxonomy (10 of the 94 bulk misses, deterministically sampled, photos inspected)

| Pattern | n/10 | Examples |
|---|---|---|
| Extreme close-up / detail crop of a 3D object or architecture vs. the single catalog view | 4 | Temple of Dendur doorway relief (catalog = whole temple); *Saint Firmin* head close-up (same gallery anyway); Islamic basin engraving macro; rotated top-down aquamanile through case glass |
| Near-duplicate siblings or casts — top-1 is visually the same work, wrong objectID | 2 | *Lancet Window* 471187 → sibling 471188 (sim 0.8869 vs 0.8857, same gallery); Saint-Gaudens *Diana* 11999 → 11998 |
| Degenerate guest framing — vitrine glass edge/glare fills the frame, artwork barely visible | 2 | *Fragment of a Queen's Face* (GT sim 0.70); *Comb Morion* (plexi edge dominates) |
| Similar-instance confusion among look-alike objects | 1 | silver *Galatea* → another silver figure |
| Low-texture generic 3D object | 1 | weathered brick fragment → other stone fragment |

Notably the "sibling/cast" misses are correct for *localization* (same gallery,
same artwork to a visitor), and the degenerate-framing photos would fail any
retrieval system — they barely contain the artwork.

## Verdict on the DINOv3 upgrade gate

The documented bench-gate asked whether full-scale accuracy collapses toward /
below DINOv3's published 80.7% top-1 (224k classes, self-hosted), which would
justify swapping in a self-hosted DINOv3 index. **It does not trigger**:
gemini-embedding-2 lands at **81.2% top-1 / 91.0% top-5 / 86.8% gallery** on a
30.6k-object index — at the top of the planning bracket (planning predicted
75–85%), matching DINOv3's published number while remaining a hosted API call
with zero infra (the comparison is imperfect — different index sizes — but the
gate question was "did the hosted approach degrade enough to pay for
self-hosting"; at parity, no). Revisit only if the index grows ~10× or the
product needs object-level (not gallery-level) precision above 90% top-1.

## Cost

- One-time for this eval: 500 query embeds ≈ **$0.06**; 40 live calls
  (embed + OCR each) ≈ $0.02. Reruns are free until the /tmp cache is dropped.
- The production index itself: 33,640 embeds ≈ $4 one-time (see llm-bench.md §4).

## Reproduction

1. `data/evals/planning-bench/FETCH.md` §metds — download the Met dataset to
   `/tmp/met-bench/metds/`.
2. Join + stratified sample → embed (resumable /tmp cache) → brute-force score:
   the exact scripts are inlined in `photo-locate.json`'s provenance fields and
   follow the Setup section above verbatim (server-identical embedding call and
   cosine math).
3. Live pass: prod server boot per CLAUDE.md, then POST each sampled photo to
   `/api/v1/locate/photo`.

## History

- **2026-06-10 (planning bench, superseded)**: 40 real guest photos vs a
  158-image gallery — 90% top-1, 95% top-5, embed p50 843 ms
  (`data/evals/planning-bench/results/real-guest-photos.json`). Retained as the
  small-gallery upper bound; the full-scale numbers above are the production
  measurement.
