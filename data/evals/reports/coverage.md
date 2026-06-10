# Coverage: on-view objects ↔ gallery polygons

- Status: **PASS**
- Generated: 2026-06-10T12:55:44.654Z by `data/src/evals.ts`
- Data version: 2026-06-10-2e5aaf37

Snapshot is complete: 44842 rows vs 45502 on-view search total (202 drifted off-view, 458 dead IDs).

## Result

- Objects with a resolvable gallery polygon: **44768/44842 (99.8%)**
- Resolution: 43118 exact, 505 via `src/gallery-aliases.json`, 1145 via the Cloisters zero-pad rule
- Distinct orphan gallery numbers (objects with no polygon): 20
- Gallery polygons with zero objects in this snapshot: 56/463
- met.sqlite counts: {"objects":44842,"galleries":463,"amenities":125,"graphNodes":2125,"graphEdges":8096} — consistent with snapshots

## Orphan gallery numbers (objects → no polygon)

| GalleryNumber | site (per objects pipeline) | objects |
|---|---|---|
| 307 | cloisters | 12 |
| 305 | cloisters | 12 |
| 304 | cloisters | 9 |
| 021 | cloisters | 9 |
| 457 | cloisters | 5 |
| 692 | cloisters | 5 |
| 624 | cloisters | 3 |
| in Great Hall | fifthAve | 2 |
| 302 | cloisters | 2 |
| 306 | cloisters | 2 |
| 300 | cloisters | 2 |
| 604 | cloisters | 2 |
| 015 | cloisters | 2 |
| 303 | cloisters | 1 |
| 005 | cloisters | 1 |
| 301 | cloisters | 1 |
| 509 | cloisters | 1 |
| 023 | cloisters | 1 |
| 603 | cloisters | 1 |
| on Fifth Avenue | fifthAve | 1 |

## Mechanism

Resolution order: exact `(site, galleryNumber)` match → manual alias from
`data/src/gallery-aliases.json` (covers Living Map's named exhibition polygons,
the 746 North/South split, and the Petrie Court Café) → zero-pad rule
(`010` → Cloisters `10`; also corrects the site, since the merged department is
named 'Medieval Art and The Cloisters'). New orphans found here should be added
to the aliases file.

## Empty gallery polygons (no objects in snapshot)

fifthAve:960, fifthAve:904, fifthAve:905, fifthAve:901, fifthAve:913, fifthAve:900, fifthAve:911, fifthAve:912, fifthAve:903, fifthAve:907, fifthAve:902, fifthAve:399, fifthAve:910, fifthAve:908, fifthAve:906, fifthAve:909, fifthAve:916, fifthAve:914, fifthAve:915, fifthAve:922, fifthAve:920, fifthAve:921, fifthAve:917, fifthAve:924, fifthAve:919, fifthAve:925, fifthAve:923, fifthAve:918, fifthAve:Exhibition Galleries 999, fifthAve:926, fifthAve:746 South, fifthAve:774, fifthAve:773, fifthAve:714, fifthAve:716, fifthAve:774a, fifthAve:406, fifthAve:400, fifthAve:404, fifthAve:402, fifthAve:401, fifthAve:173, fifthAve:174, fifthAve:403, fifthAve:405, fifthAve:340, fifthAve:176, fifthAve:175, fifthAve:980, fifthAve:981, fifthAve:113, fifthAve:136, fifthAve:215, fifthAve:214, fifthAve:217, fifthAve:211
