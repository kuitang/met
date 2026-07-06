# Graph connectivity & routing sanity

- Status: **WARN**
- Generated: 2026-07-06T15:39:53.660Z by `data/src/evals.ts`
- Data version: 2026-07-06-71ac79b9

## Inventory

- Nodes: 2125 (463 galleries), edges: 8096 (2584 door, 5452 walk, 37 stairs, 23 elevator)

## Connected components

- fifthAve: 1 component(s); cloisters: 1 component(s)

## Random-pair routing (500 seeded same-site gallery pairs)

- Success: **500/500**
- Path length: p50 170 m · p95 306 m · max 382 m

## Landmark route

- Great Hall (node r4054f1, 2 m from the section center) -> gallery 131 (Temple of Dendur): **167 m walked / 142 m straight-line** (ratio 1.17, 12 hops, ≈ 2.1 min at 80 m/min)
- Sanity bound: walked ∈ [0.95×, max(3.5×, +150 m)] of straight-line → OK

## Door edges per gallery

- Galleries with ≥1 door edge: 460/463
- Galleries with NO door edge (connected via repair walk edges only): 3
  - fifthAve:738 (f1)
  - fifthAve:741 (f1)
  - fifthAve:739 (f1)
- Galleries with no edges at all: 0
