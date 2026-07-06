# Museums data-quality audit

- Status: **WARN**
- Generated: 2026-07-05T23:26:16.556Z by `data/src/museums-audit.ts`
- Data version: 2026-07-05-730060e0 (built 2026-07-05T23:14:54.895Z)
- Museums audited: met, aic, cleveland, nga, smk, louvre, vanda
- Previous artifact for churn: none provided (PREV_DB unset, no data/met.sqlite.prev) — churn sections unavailable this run

Per Kui's standing rule, this report is a north-star dashboard: only the
structural invariants below can fail the process (exit 1); everything else
is a WARN with numbers attached, never a guess.

> Hard gate: **PASS** — 0 structural FAILs, 1 thresholded WARNs (join-rate tails) across 31 checks.

## Hard-gate summary

| Check | Status | Detail |
|---|---|---|
| objectID collisions | PASS | 0 colliding ids |
| galleries.site ⊆ registry sites | PASS | all galleries.site values are registered |
| TTL museums declare meta.ttlDays | PASS | every TTL-marked license has ttlDays set (and vice versa) |
| sourceId unique per museum (met) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (met) | PASS | all objects.site values are registered |
| license non-empty (met) | PASS | 0/44842 objects with license='' |
| every object joins a gallery row, site-scoped (met) | WARN | 44321/44842 (98.84%) |
| sourceId unique per museum (aic) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (aic) | PASS | all objects.site values are registered |
| license non-empty (aic) | PASS | 0/3510 objects with license='' |
| every object joins a gallery row, site-scoped (aic) | PASS | 3510/3510 (100.00%) |
| sourceId unique per museum (cleveland) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (cleveland) | PASS | all objects.site values are registered |
| license non-empty (cleveland) | PASS | 0/6899 objects with license='' |
| every object joins a gallery row, site-scoped (cleveland) | PASS | 6899/6899 (100.00%) |
| sourceId unique per museum (nga) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (nga) | PASS | all objects.site values are registered |
| license non-empty (nga) | PASS | 0/2808 objects with license='' |
| every object joins a gallery row, site-scoped (nga) | PASS | 2808/2808 (100.00%) |
| sourceId unique per museum (smk) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (smk) | PASS | all objects.site values are registered |
| license non-empty (smk) | PASS | 0/1481 objects with license='' |
| every object joins a gallery row, site-scoped (smk) | PASS | 1481/1481 (100.00%) |
| sourceId unique per museum (louvre) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (louvre) | PASS | all objects.site values are registered |
| license non-empty (louvre) | PASS | 0/500 objects with license='' |
| every object joins a gallery row, site-scoped (louvre) | PASS | 500/500 (100.00%) |
| sourceId unique per museum (vanda) | PASS | 0 duplicate (museum, sourceId) groups |
| objects.site ⊆ registry sites (vanda) | PASS | all objects.site values are registered |
| license non-empty (vanda) | PASS | 0/58092 objects with license='' |
| every object joins a gallery row, site-scoped (vanda) | PASS | 58092/58092 (100.00%) |

## Cross-museum summary

| Museum | objects | fidelity | join% | artist% | period% | classif% | medium% | tags% | image% | img-licensed% | room title%/floor% | gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| The Met | 44842 | routed | 98.8% | 22% | 64% | 48% | 100% | 36% | 68% | 68% | 100%/100% | WARN |
| Art Institute | 3510 | room-labels | 100.0% | 100% | 100% | 98% | 100% | 99% | 93% | 66% | 100%/0% | PASS |
| Cleveland Museum | 6899 | room-labels | 100.0% | 49% | 100% | 100% | 100% | 100% | 93% | 93% | 100%/100% | PASS |
| National Gallery | 2808 | room-labels | 100.0% | 100% | 98% | 100% | 100% | 36% | 0% | 0% | 100%/100% | PASS |
| SMK | 1481 | room-labels | 100.0% | 100% | 99% | 100% | 99% | 100% | 91% | 59% | 0%/0% | PASS |
| Louvre | 500 | routed | 100.0% | 64% | 96% | 60% | 100% | 100% | 100% | 0% | 100%/100% | PASS |
| V&A | 58092 | room-labels | 100.0% | 91% | 97% | 100% | 0% | 0% | 0% | 0% | 100%/0% | PASS |

## Per-museum detail

### The Metropolitan Museum of Art (`met`)

Fidelity **routed** · sites: fifthAve, cloisters · license `CC0-1.0`

#### Fill rates (measured %, n=44842)

| field | filled | % |
|---|---|---|
| artist | 9955 | 22.2% |
| period/date | 28774 | 64.2% |
| classification | 21417 | 47.8% |
| medium | 44822 | 100.0% |
| tags | 16293 | 36.3% |
| image (imageUrl set) | 30696 | 68.5% |
| image, license-allowed | 30696 | 68.5% |
| locationNote | 0 | 0.0% |

Room-label coverage (galleries table, 463 rows for this museum's sites): **463/463 titled (100.0%)**, **463/463 floored (100.0%)**.

#### Structural invariants

- object→gallery join: **44321/44842 (98.84%)** — WARN (known tail: alias-only exhibition codes not present in the galleries table directly — see docs/DATA.md coverage section for the alias-resolved 99.8%)
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.06%**
- Rows per gallery: p50 **29**, p95 **275**, max **4544** (415 distinct galleries)
- License histogram: `CC0-1.0`/`CC0-1.0` ×44842

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 118):

| title | artist | rows |
|---|---|---|
| Scarab | (none) | 1219 |
| Jar Label | (none) | 907 |
| Relief fragment, tomb of Meketre | (none) | 756 |
| Worker Shabti of Henettawy (C), Daughter of Isetemkheb | (none) | 357 |
| Tile | (none) | 313 |

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### Art Institute of Chicago (`aic`)

Fidelity **room-labels** · sites: aic · license `CC0-1.0`

#### Fill rates (measured %, n=3510)

| field | filled | % |
|---|---|---|
| artist | 3510 | 100.0% |
| period/date | 3510 | 100.0% |
| classification | 3435 | 97.9% |
| medium | 3505 | 99.9% |
| tags | 3466 | 98.7% |
| image (imageUrl set) | 3256 | 92.8% |
| image, license-allowed | 2307 | 65.7% |
| locationNote | 0 | 0.0% |

Room-label coverage (galleries table, 123 rows for this museum's sites): **123/123 titled (100.0%)**, **0/123 floored (0.0%)**.

#### Structural invariants

- object→gallery join: **3510/3510 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **17**, p95 **111**, max **270** (123 distinct galleries)
- License histogram: `CC0-1.0`/`CC0-1.0` ×2307, `CC0-1.0`/`(none)` ×1203

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 0):

None.

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### The Cleveland Museum of Art (`cleveland`)

Fidelity **room-labels** · sites: cleveland · license `CC0-1.0`

#### Fill rates (measured %, n=6899)

| field | filled | % |
|---|---|---|
| artist | 3374 | 48.9% |
| period/date | 6899 | 100.0% |
| classification | 6899 | 100.0% |
| medium | 6899 | 100.0% |
| tags | 6899 | 100.0% |
| image (imageUrl set) | 6387 | 92.6% |
| image, license-allowed | 6387 | 92.6% |
| locationNote | 0 | 0.0% |

Room-label coverage (galleries table, 104 rows for this museum's sites): **104/104 titled (100.0%)**, **104/104 floored (100.0%)**.

#### Structural invariants

- object→gallery join: **6899/6899 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **29**, p95 **261**, max **918** (104 distinct galleries)
- License histogram: `CC0-1.0`/`CC0-1.0` ×6387, `Copyrighted`/`(none)` ×342, `CC0-1.0`/`(none)` ×170

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 3):

| title | artist | rows |
|---|---|---|
| Shawabty of Ditamenpaankh | (none) | 48 |
| From the Los Ebanos Crossing | Zoe Leonard (American, b. 1961) | 35 |
| Petal-Shaped Bead | (none) | 22 |

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### National Gallery of Art (`nga`)

Fidelity **room-labels** · sites: nga-west, nga-east · license `CC0-1.0`

#### Fill rates (measured %, n=2808)

| field | filled | % |
|---|---|---|
| artist | 2808 | 100.0% |
| period/date | 2757 | 98.2% |
| classification | 2808 | 100.0% |
| medium | 2803 | 99.8% |
| tags | 1011 | 36.0% |
| image (imageUrl set) | 0 | 0.0% |
| image, license-allowed | 0 | 0.0% |
| locationNote | 0 | 0.0% |

Room-label coverage (galleries table, 207 rows for this museum's sites): **207/207 titled (100.0%)**, **207/207 floored (100.0%)**.

#### Structural invariants

- object→gallery join: **2808/2808 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **11**, p95 **30**, max **389** (207 distinct galleries)
- License histogram: `CC0-1.0`/`(none)` ×2808

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 0):

None.

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### SMK — National Gallery of Denmark (`smk`)

Fidelity **room-labels** · sites: smk · license `CC0-1.0`

#### Fill rates (measured %, n=1481)

| field | filled | % |
|---|---|---|
| artist | 1481 | 100.0% |
| period/date | 1463 | 98.8% |
| classification | 1481 | 100.0% |
| medium | 1462 | 98.7% |
| tags | 1481 | 100.0% |
| image (imageUrl set) | 1345 | 90.8% |
| image, license-allowed | 876 | 59.1% |
| locationNote | 0 | 0.0% |

Room-label coverage (galleries table, 73 rows for this museum's sites): **0/73 titled (0.0%)**, **0/73 floored (0.0%)**.

#### Structural invariants

- object→gallery join: **1481/1481 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **18**, p95 **56**, max **75** (73 distinct galleries)
- License histogram: `CC0-1.0`/`CC0-1.0` ×876, `CC0-1.0`/`(none)` ×605

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 0):

None.

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### Musée du Louvre (`louvre`)

Fidelity **routed** · sites: louvre · license `etalab-2.0` · translateFrom `fr`

#### Fill rates (measured %, n=500)

| field | filled | % |
|---|---|---|
| artist | 320 | 64.0% |
| period/date | 481 | 96.2% |
| classification | 298 | 59.6% |
| medium | 499 | 99.8% |
| tags | 500 | 100.0% |
| image (imageUrl set) | 499 | 99.8% |
| image, license-allowed | 0 | 0.0% |
| locationNote | 500 | 100.0% |

Room-label coverage (galleries table, 389 rows for this museum's sites): **389/389 titled (100.0%)**, **389/389 floored (100.0%)**.

#### Structural invariants

- object→gallery join: **500/500 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **16**, p95 **108**, max **108** (15 distinct galleries)
- titleAlt coverage (translateFrom fr): **95.0%**
- License histogram: `etalab-2.0`/`(none)` ×500

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 1):

| title | artist | rows |
|---|---|---|
| serviteur funéraire momiforme | (none) | 26 |

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

### Victoria and Albert Museum (`vanda`)

Fidelity **room-labels** · sites: vanda · license `vanda-nc-ttl28` (TTL 28d)

#### Fill rates (measured %, n=58092)

| field | filled | % |
|---|---|---|
| artist | 52582 | 90.5% |
| period/date | 56258 | 96.8% |
| classification | 58091 | 100.0% |
| medium | 0 | 0.0% |
| tags | 0 | 0.0% |
| image (imageUrl set) | 0 | 0.0% |
| image, license-allowed | 0 | 0.0% |
| locationNote | 56638 | 97.5% |

Room-label coverage (galleries table, 164 rows for this museum's sites): **164/164 titled (100.0%)**, **0/164 floored (0.0%)**.

#### Structural invariants

- object→gallery join: **58092/58092 (100.00%)** — PASS
- sourceId duplicate groups: **0**
- objects.site values outside the registry: **0**
- objects with license='': **0**

#### Distribution sanity

- Empty-title rows: **0.00%**
- Rows per gallery: p50 **64**, p95 **913**, max **12580** (164 distinct galleries)
- License histogram: `vanda-nc-ttl28`/`(none)` ×58092

Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of 240):

| title | artist | rows |
|---|---|---|
| Dish | Unknown | 1994 |
| Bowl | Unknown | 1532 |
| Vase | Unknown | 1121 |
| Forlì pavement | Unknown | 1050 |
| Tile | Unknown | 1032 |

#### Churn vs previous artifact

No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run.

