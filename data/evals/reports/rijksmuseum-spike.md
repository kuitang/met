# Rijksmuseum fill-rate spike — gallery-label fidelity

**Date:** 2026-07-05 · **Method:** read-only HTTP, ≤2 req/s, UA `MuseWalk-research/0.1 (kuitang@gmail.com)` · **Raw data:** session scratchpad `scratchpad/rijks/` (1,591 Linked Art JSON records, OAI XML pages, scripts `collect_ids.py` / `fetch_objects.py` / `analyze.py`)

## Verdict: INCLUDE at gallery-label fidelity

Every sampled on-view object exposes a machine-readable room code (598/598 = **100%**), and most are finer than the Met's gallery numbers — many resolve to the display case (`HG-2.16-01`, `HG-0.12-Z12.11A`). Estimated on-view corpus: **~8,000 objects** (museum's published figure; consistent with our measured 1.0% base rate × 837,654 published records = ~8,050).

## Where the location lives

The current recommended access is **data.rijksmuseum.nl** — no API key for any of it. The room code is only in the **Linked Art JSON-LD** at `https://id.rijksmuseum.nl/{id}` (`Accept: application/ld+json`): a `current_location` Place embedded inline with an `Identifier` like `HG-2.31` (parts classified by AAT: building `aat:300004188` = HG/AK/TV, room `aat:300260522`, case `aat:300240057`) plus EN+NL room names ("Gallery of Honour" / "Eregalerij") — no extra fetch needed for display strings. Prefix distribution in sample: HG 522, AK 23, TV 1; 194 distinct codes.

## How to enumerate the on-view set (measured, 8/8 verified)

The new Search API (`data.rijksmuseum.nl/search/collection`) has **no on-view/location filter**, and the bulk dumps cover only the library domain plus shared vocabularies — no collection-object dump. But OAI-PMH EDM records (`https://data.rijksmuseum.nl/oai`, no key, 50 records/page, non-expiring resumption tokens) carry `edm:currentLocation` **only for on-view objects** (it points at the institution Place `id/2301886`, not the room — presence is the flag). Verified on 8 objects: EDM flag ↔ Linked Art room code matched 8/8.

Pipeline: (1) full OAI `ListRecords` harvest — 837,654 records ≈ 16,760 requests ≈ 4 h at 1.2 req/s, then incremental via `from`/`until` (fits our nightly refresh); (2) resolve the ~8k flagged IDs via `id.rijksmuseum.nl` ≈ 1.5–2 h. One-time ~6 h, deltas cheap.

## Measured fill rates (n = 1,591 objects, fetched 2026-07-05, 0 errors)

| Sample (source) | n | room code | none |
|---|---|---|---|
| Top 100 set (260213) | 133 | **85.7%** | 14.3% |
| Top 1000 set (260214) | 1,040 | **42.8%** | 57.2% |
| `type=painting` (first 250) | 250 | **58.8%** | 41.2% |
| `type=schilderij` (first 250) | 250 | **56.4%** | 43.6% |
| General collection (first 300, no filter) | 300 | 1.0% | 99.0% |
| EDM cross-check (OAI set 26121, 8 objs) | 8 | 8/8 match | — |

Zero objects had a `current_location` without a parseable code. **Bias note:** the first four samples are deliberately on-view-enriched (curated sets, paintings) to measure the *conditional* fill rate; the unfiltered general sample gives the base rate (1.0%), which independently reproduces the museum's "8,000 on display" figure. Search API ordering is by internal ID, not curated relevance, so the 300-record general slice is a reasonable (if not fully random) base-rate probe.

## Classic API: dead — do not sign up

`www.rijksmuseum.nl/api/{lang}/collection` returns **HTTP 410 Gone** (measured today). Its docs pages 404. The archived (2025-04) docs confirm it returned `"location": "HG-2.31"` per object, but its `key=` signup path no longer buys anything the keyless services don't provide. All docs mark it DEPRECATED in favor of the Search API + LOD resolver.

## Caveats

- OAI EDM validation change announced ~2026-06-11 ("valid per Europeana Schematron") — harvester XML parsing may need a re-check.
- `edm:currentLocation` semantics ("on view" vs "held here") are inferred from measurement, not documented; the 8/8 cross-check and the 1.0% base rate both support the on-view reading. Re-verify on a larger slice during pipeline build.
- LDES (`data.rijksmuseum.nl/ldes/collection.json`) is an alternative bulk stream of the same Linked Art records if OAI proves slow.
