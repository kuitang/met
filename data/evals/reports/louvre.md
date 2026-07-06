# Louvre geometry & routing (OSM, D7)

- Status: **PASS** · Routed-fidelity gate: **PASS**
- Generated: 2026-07-06T15:39:54.277Z by `data/src/evals-louvre.ts`
- Source: OpenStreetMap (ODbL, © OpenStreetMap contributors), Overpass extract 2026-07-05 (committed)

## Geometry

- Features: 628 (259 salle-matched, 369 backdrop)
- Invalid polygons: **0**
- Salle match (plan → OSM): **259/389 codes** — **63.8% of 26653 on-view arks** sit in a matched salle
- OSM → plan: 278/643 walkable OSM spaces carry a salle code (123 by explicit code, 155 by title match; 32 ambiguous names dropped, never guessed)

| floor | plan salles | matched | OSM features | salle polygons |
|---|---|---|---|---|
| -1 | 32 | 15 | 119 | 15 |
| 0 | 100 | 53 | 157 | 53 |
| 1 | 139 | 95 | 198 | 95 |
| 2 | 118 | 96 | 154 | 96 |

## Graph

- Nodes: 1618 (278 carry a salle code), edges: 3140 (1442 door, 1623 walk, 44 stairs, 31 elevator)
- Doors: 726/766 OSM door nodes resolved to a two-sided doorway; vertical units: 144 stairs + 46 elevators
- Connected components: 1 total; **1 carry salle codes** — sizes [1618n/278g]

### Random-pair routing (500 seeded matched-salle pairs, production router)

- Routable: **500/500 (100.0%)**
- Path length: p50 407 m · p95 653 m · max 745 m

### On-view salle accounting (362 salles hold arks)

- Routable from the main block: **252**
- Matched but stranded outside the main block: **0**
- No OSM polygon matched (label-only rows, listed): **110**

  200538 (4 arks), 101 (3 arks), 130 (2 arks), 134 (43 arks), 136 (23 arks), 137 (72 arks), 168 (5 arks), 169 (79 arks), 135 (1 arks), 102 (71 arks), 105 (111 arks), 172 (1 arks), 165205 (1 arks), 199370 (6 arks), 200342 (2 arks), 343 (39 arks), 346 (18 arks), 405 (32 arks), 337 (5 arks), 339 (66 arks), 340 (44 arks), 341 (84 arks), 342 (26 arks), 407 (37 arks), 106 (7 arks), 103 (5 arks), 210 (36 arks), 212 (19 arks), 216 (15 arks), 217 (13 arks), 231 (271 arks), 232 (528 arks), 233 (78 arks), 234 (388 arks), 236 (221 arks), 300 (171 arks), 301 (553 arks), 302 (276 arks), 303 (126 arks), 304 (341 arks), 306 (733 arks), 308 (12 arks), 309 (114 arks), 310 (177 arks), 311 (109 arks), 312 (54 arks), 313 (73 arks), 316 (273 arks), 230 (296 arks), 401 (8 arks), 402 (3 arks), 327 (168 arks), 328 (1 arks), 227bis (50 arks), 214 (68 arks), 218 (67 arks), 307 (210 arks), 314 (113 arks), 344 (40 arks), 165624 (3 arks), 165627 (5 arks), 198805 (4 arks), 198807 (3 arks), 232197 (4 arks), 529 (77 arks), 535 (1 arks), 536 (14 arks), 537 (3 arks), 538 (31 arks), 539 (3 arks), 546 (15 arks), 549 (6 arks), 551 (33 arks), 600 (1 arks), 608 (33 arks), 609 (120 arks), 610 (49 arks), 611 (29 arks), 614 (190 arks), 620 (108 arks), 621 (2 arks), 628 (95 arks), 637 (327 arks), 638 (22 arks), 641 (49 arks), 642 (133 arks), 646 (276 arks), 647 (422 arks), 648 (415 arks), 704 (12 arks), 717 (37 arks), 719 (9 arks), 524 (52 arks), 639 (62 arks), 640 (106 arks), 617 (68 arks), 710 (114 arks), 712 (57 arks), 718 (68 arks), 165568 (7 arks), 824 (13 arks), 850 (13 arks), 851 (23 arks), 852 (22 arks), 853 (17 arks), 858 (1 arks), 902 (43 arks), 908 (15 arks), 930 (14 arks), 951 (23 arks)

### Landmark route — Salle 711 (Joconde) → Salle 345 (Vénus de Milo)

- **263 m walked / 144 m straight-line** (1.82×), 18 steps, ≈ 3.3 min
- avoid-stairs: 305 m (elevators)

<details><summary>steps</summary>

1. Start in Gallery 711 (Salle 711 - Salle de la Joconde) — Floor 1
1. Exit Gallery 711 through the south door into the corridor
1. Exit the corridor through the door into Gallery 709 (Salle 709 - Salle des Sept Mètres)
1. Exit Gallery 709 through the northeast door into the corridor
1. Exit the corridor through the south door into the stairs
1. Exit the stairs through the east door into the corridor
1. Exit the corridor through the west door into the stairs
1. Take the stairs to Floor G
1. Exit the stairs through the west door into the corridor
1. Exit the corridor through the south door into the stairs
1. Exit the stairs through the south door into Galerie des Mosaïques
1. Exit Galerie des Mosaïques through the northeast door into the stairs
1. Exit the stairs through the east door into Cour du Sphinx
1. Exit Cour du Sphinx through the northeast door into the corridor
1. Exit the corridor through the southeast door into Salon de la Reine
1. Exit Salon de la Reine through the northeast door into Rotonde d'Apollon
1. Exit Rotonde d'Apollon through the southeast door into Gallery 347 (Salle 347 - Salle de Diane)
1. Exit Gallery 347 through the door — you've arrived at Gallery 345 (Salle 345 - Art grec classique et hellénistique (Vénus de Milo))

</details>

## Routed-fidelity gate

| criterion | value | pass |
|---|---|---|
| random-pair routability ≥95% | 100.0% | ✓ |
| 1 gallery-bearing component | 1 | ✓ |
| no stranded on-view salle | 0 stranded | ✓ |
| landmark route exists | yes | ✓ |

**GATE PASS — registry fidelity may be 'routed'**

## Visual

| File | niveau | rooms | graph edges drawn |
|---|---|---|---|
| [floors/louvre-fm1.svg](floors/louvre-fm1.svg) | -1 | 119 | 897 |
| [floors/louvre-f0.svg](floors/louvre-f0.svg) | 0 | 157 | 764 |
| [floors/louvre-f1.svg](floors/louvre-f1.svg) | 1 | 198 | 757 |
| [floors/louvre-f2.svg](floors/louvre-f2.svg) | 2 | 154 | 627 |
