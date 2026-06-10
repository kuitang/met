# Regenerating the image sets (not committed — too big)

The scripts in this directory reference five image directories that are deliberately
NOT committed. This file explains how each is regenerated, relative to this directory.

## `images/` (~2.2 MB — 16 catalog originals + 16 degraded "visitor photos")
1. Originals: for each of the 16 objects in `objects.json`, download
   `primaryImageSmall` from the Met Open Access API
   (`https://collectionapi.metmuseum.org/public/collection/v1/objects/{objectID}`)
   and save as `images/{objectID}_orig.jpg`.
2. Degraded copies: `python degrade.py` (needs Pillow; seeded `random.seed(42)`)
   turns each `_orig.jpg` into `images/{objectID}_photo.jpg` — perspective warp,
   rotation, dim warm lighting, glare blob, blur, JPEG q68.
   The 16 `_photo.jpg` outputs are committed at `e2e/fixtures/` for journey tests.

## `labels/` (~212 KB — 8 synthesized Met-style wall labels)
Also produced by `python degrade.py`: renders artist/title/date/medium/credit/accession
from `objects.json` in Met wall-label layout (Liberation fonts at
`/usr/share/fonts/truetype/liberation/`), then photograph-degrades (angle, shadow
gradient, dim, blur). Label object IDs: 436535, 11417, 544442, 24423, 40681,
250684, 325329, 74832. The 8 outputs are committed at `e2e/fixtures/`.

## `gallery/` (~5.9 MB — 60 distractor catalog images, synthetic retrieval bench)
For each object in `gallery.json`, download `primaryImageSmall` from the Met API
to `gallery/{objectID}.jpg`. Used by `embed-retrieval.mjs` (76-image gallery =
16 corpus + 60 distractors).

## `metds/` (~93 MB — the published Met benchmark: REAL guest photos + ground truth)
Source: The Met dataset, http://cmp.felk.cvut.cz/met/ ("The Met Dataset:
Instance-level Recognition for Artworks", NeurIPS 2021).
```
mkdir -p metds && cd metds
curl -LO http://ptak.felk.cvut.cz/met/dataset/test_met.tar.gz       # real visitor query photos
curl -LO http://ptak.felk.cvut.cz/met/dataset/ground_truth.tar.gz   # testset.json/valset.json with MET_id labels
tar xzf test_met.tar.gz && tar xzf ground_truth.tar.gz
```
`eval-real.mjs` reads query photos at `metds/{q.path}` (paths come from
`real-eval.json`, derived from `metds/testset.json`).

## `realgallery/` (~14 MB — 158-image catalog gallery for the real-photo eval)
`node eval-real-fetch.mjs` rebuilds it: samples 40 ground-truthed queries +
~260 distractor candidates from `metds/testset.json`, hydrates each `MET_id`
via the Met API, downloads `primaryImageSmall` to `realgallery/{id}.jpg`,
and rewrites `real-eval.json` (the committed copy already pins the exact
query/gallery selection used for the numbers in RESULTS.md).

## Run order (full reproduction)
1. Fetch `images/` originals + `gallery/` per above → `python degrade.py`
2. `GEMINI_API_KEY=... OPENAI_API_KEY=... node bench.mjs` → `results/llm-bench.json` (+ `llm-bench-openai.json` rerun for the GPT json_object quirk)
3. `GEMINI_API_KEY=... node embed-retrieval.mjs` → `results/embed-retrieval.json`
4. Download `metds/` → `node eval-real-fetch.mjs` → `realgallery/` + `real-eval.json`
5. `GEMINI_API_KEY=... OPENAI_API_KEY=... node eval-real.mjs` → `results/real-guest-photos.json`
