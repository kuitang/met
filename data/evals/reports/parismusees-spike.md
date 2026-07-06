# Paris Musées collections API — fill-rate spike

**Date:** 2026-07-06
**Endpoint:** `https://apicollections.parismusees.paris.fr/graphql` (Drupal GraphQL, `auth-token` header)
**Method:** Schema introspection + random-offset sampling of the `oeuvre` (artwork) node bundle, ≤2 req/s. Total catalog: **416,787** `oeuvre` nodes across 14 museums (single taxonomy `field_musee`, vid `musee`, 14 terms — see "Site model" below).

## Verdict: EXCLUDE room/gallery-level for the Paris Musées collection as a whole — fails the 60% kill criterion by two orders of magnitude

Across the entire 416,787-record catalog, only **1,656 records (0.40%)** carry any structured on-display/room-location value. Even restricted to the four museums that have *any* such data at all, the best case (Petit Palais) is 2.75% of its own catalog. There is no independent "on view: yes/no" boolean in the schema — presence of the location field is the only signal — so 0.40% is the ceiling estimate for "room-field fill among on-view works," not a floor. This is far below the plan's 60% kill threshold.

**10 of the 14 museums — including Musée Carnavalet, the flagship site and by far the largest single museum in the system (235,087 of the 416,787 total oeuvre records, 56%) — have zero room-level location data anywhere in the schema.**

## What the room/location fields actually are

Introspection of `NodeOeuvre` turned up two candidate fields; only one is real display-location data:

| Field | What it actually is | Fill (of 416,787) |
|---|---|---|
| `field_oeuvre_expose` | Reference to a taxonomy term whose **name is the physical location string itself** (e.g. `"Petit Palais Rez-de-Chaussée Salle 32 vitrine 14"`, `"Musée Cognacq-Jay, Niveau 3, Salle 11"`, `"Galerie nord"`). Presence = on display; there is no separate boolean. This is the only genuine room/gallery-location field. | **1,656 (0.40%)** |
| `field_oeuvre_commentaire_lieu` | **Archaeological/historical findspot**, not display location — free text like `"4e arrondissement : ancien Hôtel-de-Ville"`, `"Provenance inconnue"`, `"Localisation non renseignée"`, arrondissement/street/dig-site notes. 88% of its 6,108 filled records belong to Carnavalet (city-history digs) and Cernuschi. **Not usable for indoor wayfinding.** | 6,108 (1.5%) |

## Per-museum breakdown of the 1,656 records with real room location (`field_oeuvre_expose`)

| Museum (code) | Records w/ room location | % of that museum's own oeuvre catalog | Notes |
|---|---:|---:|---|
| Petit Palais (PPA) | 1,274 (77% of the 1,656) | 2.75% of 46,255 | Spans ~38 distinct room numbers (Salle 1–42) + named galleries ("Galerie nord/Sud", "Salon réception du directeur"). Petit Palais's actual permanent-display collection is small (~1,300 works) relative to its 46k-object catalog, so this could be *near-complete for that museum specifically* — but there's no way to verify against an independent "on view" count via this API. |
| Musée Cognacq-Jay (COG) | 230 | 20.9% of 1,100 | Room-level ("Niveau N, Salle M") granularity, plausible partial coverage of a small period-rooms museum. |
| Musée de la Vie Romantique (MVR) | 143 | 6.0% of 2,394 | Room+wall granularity ("Pavillon, rez-de-chaussée, salle 3, mur 4"). |
| Musée Cernuschi (CER) | 9 | 0.12% of 7,665 | Most of these 9 are explicitly stale: labelled `"Ancienne localisation n'existant plus depuis la rénovation du musée en 2019"` (old location, invalid since the 2019 renovation) or point at storage (`"Réserve Cernuschi"`). Effectively **zero current, usable room data**. |
| Carnavalet (CAR) | 0 | 0% of 235,087 | **Flagship museum, largest catalog by far — zero room-level data of any kind.** |
| Bourdelle, Galliera, Musée d'Art Moderne, Musée de la Libération, Maison de Victor Hugo, Musée Zadkine, Maison de Balzac | 0 each | 0% | No room-level data. |
| Crypte archéologique de l'Île de la Cité, Catacombes de Paris | 0 (no `oeuvre` nodes at all) | — | These two sites have 0 `oeuvre`-bundle records in the API; they aren't modeled as object collections here. |

## Site model

One umbrella GraphQL API models all 14 museums via a single `field_musee` taxonomy reference on each artwork node (vid `musee`, terms 10–21 plus two archaeological-site terms with non-numeric handling). This confirms the **single "paris-musees" registry-entry model**, not 14 separate site registries — each museum term carries its own short code (`field_musee_code`: BAL, BOU, CAR, CER, COG, GAL, MAM, LEC, MVH, MVR, PPA, ZDK; the two archaeological sites have no code), address (`field_adresse`), geolocation (`field_geolocation`), logo, and URL, reusable as museum-level metadata if this source were ever included.

## Other findings (bibliographic / images / license / language)

- **Titles & object numbers:** `title` and `field_numero_objet` are 100% filled in a 300-record general sample.
- **Structured author/date/material fields** (`field_oeuvre_auteurs`, `field_date_production`, `field_materiaux_technique`) exist on the schema but the flattened "cartel" display-text fields (`field_cartel_auteur`, `field_cartel_datation`, `field_cartel_materiaux`) were 0% filled in-sample — the structured entity-reference fields would need to be queried with their correct sub-field names (not fully resolved in this spike; deprioritized since it doesn't affect the room-fill kill decision).
- **Images:** 96.3% of sampled oeuvre records have at least one linked `MediaImage` (475 images across 289/300 records).
- **License, confirmed mixed as expected:** `MediaImage.fieldImageLibre` (boolean "free to use") was true for 70.5% of sampled images; `fieldCopyright` text present on 94%, `fieldImageDroits` (rights text) present on 99%. This is a genuine mixed CC0/rights-reserved model, unlike the Met's blanket CC0 — any inclusion would need per-image license gating, not a blanket assumption.
- **Language:** all sampled text (titles, location strings, rights text) is French-only; no English fields on `NodeOeuvre`. The existing FR→EN DeepSeek/OpenRouter pipeline is directly reusable if any of this data were ever ingested.

## Bottom line

Do not add Paris Musées (as a 14-museum umbrella) to MuseWalk at room- or gallery-level — the data isn't there for all but a sliver of one museum. Museum-level metadata (address/geolocation/logo) is well-populated and could support a bare "museum info" listing, but that's below the value bar the plan sets for inclusion given the room-level kill criterion is meant to be the primary gate. The one narrow follow-up worth flagging: Petit Palais alone has plausible (unverified) near-complete room-level data across ~38 rooms and could be evaluated as a standalone single-museum candidate later — but that's a different, much smaller scope than "add Paris Musées."
