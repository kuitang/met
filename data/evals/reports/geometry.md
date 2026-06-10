# Geometry sanity: polygons, overlaps, centroids, floors

- Status: **PASS**
- Generated: 2026-06-10T12:55:44.755Z by `data/src/evals.ts`
- Data version: 2026-06-10-2e5aaf37

## Polygon validity

- Room polygons checked: 828 (463 galleries)
- Invalid: **0**

## Per-floor overlaps (> 1 m², 0 clipping errors)

- Overlapping pairs: **0**

## Polygon centroid vs features-API center

- Matched (site, gallery, floor): 458/463 polygons (features API lists 460 galleries)
- Distance: p50 0.0 m · p90 2.8 m · max 20.0 m
- Pairs > 25 m: 0

Centroids and the API's label points measure different things (label points are
placed for cartographic readability, often off-center in L-shaped rooms), so a
few-meter spread is expected; large distances would indicate a stitching or
centroid bug.

## Floor inventory

- Fifth Ave: Floor 1, Floor 1M, Floor 2, Floor 3, Floor 4, Floor 5, Floor G (expect 7: G, 1, 1M, 2, 3, 4, 5)
- Cloisters: Floor 1, Floor G (expect 2)
