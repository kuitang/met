# Coverage: on-view objects ↔ gallery polygons

- Status: **WARN**
- Generated: 2026-06-10T03:29:34.442Z by `data/src/evals.ts`
- Data version: 2026-06-10-a5015024

> **Partial snapshot**: objects.json.gz holds 120 of 45502 on-view objects (full hydration pending — the Met API WAF throttles well below the published 80 req/s). Percentages below are over the partial set; rerun after the objects pipeline completes.

## Result

- Objects with a resolvable gallery polygon: **120/120 (100.0%)**
- Resolution: 120 exact, 0 via `src/gallery-aliases.json`, 0 via the Cloisters zero-pad rule
- Distinct orphan gallery numbers (objects with no polygon): 0
- Gallery polygons with zero objects in this snapshot: 411/463 (expected high while the snapshot is partial)
- met.sqlite counts: {"objects":120,"galleries":463,"amenities":125,"graphNodes":2125,"graphEdges":8096} — consistent with snapshots

## Orphan gallery numbers (objects → no polygon)

None — every object's GalleryNumber resolves to a polygon.

## Mechanism

Resolution order: exact `(site, galleryNumber)` match → manual alias from
`data/src/gallery-aliases.json` (covers Living Map's named exhibition polygons,
the 746 North/South split, and the Petrie Court Café) → zero-pad rule
(`010` → Cloisters `10`; also corrects the site, since the merged department is
named 'Medieval Art and The Cloisters'). New orphans found here should be added
to the aliases file.

## Empty gallery polygons (no objects in snapshot)

fifthAve:963, fifthAve:Exhibition Galleries 964 & 965, fifthAve:957, fifthAve:960, fifthAve:954, fifthAve:520, fifthAve:958, fifthAve:959, fifthAve:955, fifthAve:521, fifthAve:956, fifthAve:962, fifthAve:953, fifthAve:961, fifthAve:525, fifthAve:522, fifthAve:523, fifthAve:619, fifthAve:620, fifthAve:617, fifthAve:618, fifthAve:904, fifthAve:555, fifthAve:549, fifthAve:905, fifthAve:901, fifthAve:524, fifthAve:913, fifthAve:528, fifthAve:900, fifthAve:911, fifthAve:912, fifthAve:903, fifthAve:527, fifthAve:907, fifthAve:902, fifthAve:399, fifthAve:910, fifthAve:908, fifthAve:906, fifthAve:909, fifthAve:916, fifthAve:914, fifthAve:915, fifthAve:922, fifthAve:920, fifthAve:823, fifthAve:921, fifthAve:917, fifthAve:825, fifthAve:924, fifthAve:824, fifthAve:800, fifthAve:612, fifthAve:614, fifthAve:919, fifthAve:925, fifthAve:923, fifthAve:821, fifthAve:615, …
