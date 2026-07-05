# GPS mapping: synthetic fixes vs the wing-level resolver

- Status: **PASS**
- Generated: 2026-07-05T23:17:51.152Z by `data/src/evals.ts`
- Data version: 2026-07-05-1040037f

The resolver under test is the reference implementation of the positioning
design: GPS may only yield `{atMuseum, site, wing}` — its output type has no
room field, so a room-level claim is impossible by construction. The cases
verify the *data* supports this design and quantify why room-level would be
wrong if attempted.

## Case 1 — Fifth Ave entrance fix (40.7794, -73.9632, ±40 m) — OK

- Resolved: atMuseum=true, site=fifthAve, wing="European Sculpture and Decorative Arts"

## Case 2 — Central Park outlier (40.7794, -73.97) — OK

- ±800 m accuracy → atMuseum=false (rejected: accuracy > 300 m)
- ±50 m accuracy, ~300 m from the building → atMuseum=false (rejected: > 200 m outside)

## Case 3 — 200 fixes, Gaussian σ=32.5 m (≈65 m 95% error) around the Great Hall — OK

- Resolved at-museum: 200/200
- Wing votes: "The Great Hall" 101 · "European Sculpture and Decorative Arts" 26 · "Art of Ancient West Asia and the Art of Ancient Cyprus" 26 · "Asian Art" 23 · "Medieval Art" 8 (modal 51%)
- **Why never room-level**: naive smallest-room point-in-polygon over the same fixes
  claims **69 distinct rooms across floors** (GPS has no floor signal);
  the true room (corridor, floor 1) is hit on only 14% of fixes.

Top rooms a naive room-level resolver would have claimed:

- f1:corridor: 30 fixes
- f2:vista: 20 fixes
- f1:floor: 17 fixes
- f0:floor: 15 fixes
- f1:Exhibition Gallery 099: 13 fixes
- f2:204: 9 fixes
- f2:202: 7 fixes
- f1:Thomas J. Watson Library: 7 fixes
- f1:back_of_house: 7 fixes
- f2:206: 6 fixes
- f2:207: 5 fixes
- f2:Great Hall Balcony Cafe: 5 fixes

Assertions: ≥90% of cloud fixes resolve at-museum, modal wing ≥50%, and the
naive room claim set has ≥5 distinct rooms (demonstrating room-level GPS would
be majority-wrong, which is why the resolver caps at wing level).
