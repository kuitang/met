/**
 * The museum registry — single source of truth for which museums exist, their
 * display identity, sites (buildings), licensing/attribution, and source
 * adapters. The data pipelines merge every registry museum's snapshots into
 * the one artifact; build-db copies each entry into `meta.museums` so the
 * server manifest endpoint and the client read the same facts offline.
 *
 * New museums land as sources/{id}.ts + one entry here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MuseumSource } from "./types.ts";
import { metSource } from "./met.ts";
import { aicSource } from "./aic.ts";
import { clevelandSource } from "./cleveland.ts";
import { ngaSource } from "./nga.ts";
import { smkSource } from "./smk.ts";
import { louvreSource } from "./louvre.ts";
import { vandaSource } from "./vanda.ts";
import { harvardSource } from "./harvard.ts";
import { rijksmuseumSource } from "./rijksmuseum.ts";
import { breraSource } from "./brera.ts";
import { egizioSource } from "./egizio.ts";
import { uffiziSource } from "./uffizi.ts";

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface SiteMeta {
  siteId: string; // globally unique across ALL museums (objects.site / galleries.site values)
  name: string;
  /** Main entrance — GPS museum/venue resolution + "near entrance" anchors. */
  entrance: { lat: number; lon: number; floor?: string };
  /** Floor labels in display order (bottom → top). */
  floorOrder: string[];
}

export interface MuseumInfo {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  sites: SiteMeta[];
  /** What the shipped data supports: full routing, room labels only, or museum-level. */
  fidelity: "routed" | "room-labels" | "museum-only";
  license: {
    /** Default per-record text license (sources may override per row). */
    text: string;
    /** Default per-record image-derivative license; "" = no derivatives allowed. */
    images: string;
    attribution: string;
    termsUrl: string;
    /**
     * Non-commercial-use TTL in days for sources whose terms cap how long
     * fetched content may be cached/served (V&A: 4 weeks). When set, the
     * license-TTL mechanism (shared/search.ts SearchFilters.expiredMuseums +
     * SqliteDataProvider) hides this museum's rows once the shipped
     * artifact's builtAt is older than ttlDays - 1 (see ARCHITECTURE.md
     * "Provenance & the license-TTL mechanism"). license.text conventionally
     * carries a matching "-ttlNN" suffix so the two stay in lockstep.
     */
    ttlDays?: number;
  };
  /** Object deep-link template; "{sourceId}" is replaced per record. */
  objectUrlTemplate: string;
  /** Source language needing index-time translation (data/src/translate.ts). */
  translateFrom?: string;
}

export const MUSEUMS: MuseumInfo[] = [
  {
    id: "met",
    name: "The Metropolitan Museum of Art",
    shortName: "The Met",
    city: "New York",
    country: "US",
    sites: [
      {
        siteId: "fifthAve",
        name: "Fifth Avenue",
        entrance: { lat: 40.7794, lon: -73.9632, floor: "1" },
        floorOrder: ["G", "1", "1M", "2", "3", "4", "5"],
      },
      {
        siteId: "cloisters",
        name: "The Cloisters",
        entrance: { lat: 40.8649, lon: -73.9317 },
        floorOrder: ["G", "1"],
      },
    ],
    fidelity: "routed",
    license: {
      text: "CC0-1.0",
      images: "CC0-1.0",
      attribution: "The Metropolitan Museum of Art Open Access (CC0)",
      termsUrl: "https://www.metmuseum.org/policies/open-access",
    },
    objectUrlTemplate: "https://www.metmuseum.org/art/collection/search/{sourceId}",
  },
  {
    id: "aic",
    name: "Art Institute of Chicago",
    shortName: "Art Institute",
    city: "Chicago",
    country: "US",
    sites: [
      {
        siteId: "aic",
        name: "Art Institute of Chicago",
        // Michigan Avenue entrance (the lions).
        entrance: { lat: 41.8796, lon: -87.6237, floor: "1" },
        // AIC labels floors LL/1/2/3; gallery rows ship without floors until
        // an authoritative gallery→floor mapping is sourced (see sources/aic.ts).
        floorOrder: ["LL", "1", "2", "3"],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "CC0-1.0",
      images: "CC0-1.0", // per-record: rows without is_public_domain get imageLicense=''
      attribution: "Art Institute of Chicago public API (CC0)",
      termsUrl: "https://www.artic.edu/terms",
    },
    objectUrlTemplate: "https://www.artic.edu/artworks/{sourceId}",
  },
  {
    id: "cleveland",
    name: "The Cleveland Museum of Art",
    shortName: "Cleveland Museum",
    city: "Cleveland",
    country: "US",
    sites: [
      {
        siteId: "cleveland",
        name: "The Cleveland Museum of Art",
        entrance: { lat: 41.5085, lon: -81.6118, floor: "1" },
        // Room codes are 3-digit(+letter); on-view set spans 004-118 (floor 1)
        // and 200-244 (floor 2) — see sources/cleveland.ts floorForCode.
        floorOrder: ["1", "2"],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "CC0-1.0", // per-record: Copyrighted-status rows override (share_license_status)
      images: "CC0-1.0", // per-record: rows without CC0 status or without an image get imageLicense=''
      attribution: "Cleveland Museum of Art Open Access API (CC0)",
      termsUrl: "https://www.clevelandart.org/open-access",
    },
    objectUrlTemplate: "https://clevelandart.org/art/{sourceId}",
  },
  {
    id: "nga",
    name: "National Gallery of Art",
    shortName: "National Gallery",
    city: "Washington, D.C.",
    country: "US",
    sites: [
      {
        siteId: "nga-west",
        name: "West Building",
        entrance: { lat: 38.8913, lon: -77.0199, floor: "Main" },
        floorOrder: ["Ground", "Main", "Garden"],
      },
      {
        siteId: "nga-east",
        name: "East Building",
        entrance: { lat: 38.8915, lon: -77.0167, floor: "Concourse" },
        floorOrder: ["Concourse", "Ground", "Mezzanine", "Tower"],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "CC0-1.0",
      images: "", // open-data grant excludes images entirely (see sources/nga.ts)
      attribution: "National Gallery of Art Open Data Program (CC0)",
      termsUrl: "https://github.com/NationalGalleryOfArt/opendata",
    },
    objectUrlTemplate: "https://www.nga.gov/collection/art-object-page.{sourceId}.html",
  },
  {
    id: "smk",
    name: "SMK — National Gallery of Denmark",
    shortName: "SMK",
    city: "Copenhagen",
    country: "DK",
    sites: [
      {
        siteId: "smk",
        name: "SMK — Statens Museum for Kunst",
        entrance: { lat: 55.6889, lon: 12.5786 },
        // No authoritative gallery->floor mapping is published (see
        // sources/smk.ts) — one placeholder floor, same non-guessing
        // convention as AIC's floorOrder.
        floorOrder: ["1"],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "CC0-1.0",
      images: "", // per-record: public_domain rows get imageLicense='CC0-1.0'
      attribution: "SMK (Statens Museum for Kunst) open data API",
      termsUrl: "https://www.smk.dk/en/article/smk-api/",
    },
    objectUrlTemplate: "https://open.smk.dk/artwork/image/{sourceId}",
  },
  {
    id: "louvre",
    name: "Musée du Louvre",
    shortName: "Louvre",
    city: "Paris",
    country: "FR",
    sites: [
      {
        siteId: "louvre",
        name: "Musée du Louvre",
        // Pyramide (main entrance).
        entrance: { lat: 48.8611, lon: 2.3364 },
        // Measured 2026-07-05: the plan tool serves salles_{-1,0,1,2}.json;
        // a "-2" level exists only as free text inside some rooms' `etage`
        // label (rooms spanning two levels) — no separate floor file 404s
        // otherwise, so floorOrder stops at -1.
        floorOrder: ["-1", "0", "1", "2"],
      },
    ],
    // D7: geometry + routing graph from OpenStreetMap indoor mapping
    // (data/src/geometry-osm.ts). The routed-fidelity gate (evals-louvre.ts)
    // passed: 500/500 random salle pairs routable, 1 gallery-bearing
    // component, no stranded on-view salle.
    fidelity: "routed",
    license: {
      text: "etalab-2.0",
      images: "", // restricted license — no image derivatives shipped
      attribution: "Musée du Louvre — collections.louvre.fr (Licence Ouverte / Open Licence)",
      termsUrl: "https://collections.louvre.fr/en/page/cgu",
    },
    objectUrlTemplate: "https://collections.louvre.fr/en/ark:/53355/{sourceId}",
    translateFrom: "fr",
  },
  {
    id: "vanda",
    name: "Victoria and Albert Museum",
    shortName: "V&A",
    city: "London",
    country: "GB",
    sites: [
      {
        siteId: "vanda",
        name: "Victoria and Albert Museum",
        // Cromwell Road (main entrance).
        entrance: { lat: 51.4966, lon: -0.1722 },
        // No authoritative gallery->floor mapping is published at the
        // search tier (see sources/vanda.ts) — floors stay null per gallery,
        // same non-guessing convention as AIC/SMK.
        floorOrder: [],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "vanda-nc-ttl28",
      images: "", // V&A images are not redistributable — no derivatives shipped
      attribution:
        "Victoria and Albert Museum collections API (non-commercial terms; data expires after 28 days)",
      termsUrl: "https://developers.vam.ac.uk/guide/v2/quick-start.html",
      ttlDays: 28,
    },
    objectUrlTemplate: "https://collections.vam.ac.uk/item/{sourceId}",
  },
  {
    id: "harvard",
    name: "Harvard Art Museums",
    shortName: "Harvard",
    city: "Cambridge",
    country: "US",
    sites: [
      {
        siteId: "harvard",
        name: "Harvard Art Museums",
        // 32 Quincy Street entrance.
        entrance: { lat: 42.3743, lon: -71.1144, floor: "1" },
        // Measured 2026-07-06 across the 1,817-object on-view set: floor "0"
        // (Lower Level Lobby, 2 objects), "1" (Modern/Contemporary + the
        // Calderwood Courtyard, 512), "2" (European/American 17th-19th c,
        // 603), "3" (Ancient Mediterranean/Asian/Islamic, 688), "4"
        // (Hoffman reception area, 12) — no floor "5" objects exist, so this
        // deviates from the plan's guessed ["1","2","3","4","5"].
        floorOrder: ["0", "1", "2", "3", "4"],
      },
    ],
    fidelity: "room-labels",
    license: {
      text: "harvard-nc-ttl14",
      images: "", // conservative under non-commercial terms — no image derivatives shipped
      attribution: "Harvard Art Museums API (non-commercial terms; data expires after 14 days)",
      termsUrl: "https://github.com/harvardartmuseums/api-docs",
      ttlDays: 14,
    },
    objectUrlTemplate: "https://harvardartmuseums.org/collections/object/{sourceId}",
  },
  {
    id: "rijksmuseum",
    name: "Rijksmuseum",
    shortName: "Rijksmuseum",
    city: "Amsterdam",
    country: "NL",
    sites: [
      {
        siteId: "rijksmuseum",
        name: "Rijksmuseum",
        entrance: { lat: 52.36, lon: 4.8852, floor: "0" },
        // Measured 2026-07-06: on-view room codes are "{floor}.{room}" (e.g.
        // "2.16", "1.17", "0.10", "1.4") across every building sampled (HG
        // main building, TV KPN wing) — floor is always the code's leading
        // segment. Floor "3" reflects the museum's own numbering (top-floor
        // print-room/study galleries) though not hit in the live sample —
        // revisit if the full harvest never populates it.
        floorOrder: ["0", "1", "2", "3"],
      },
    ],
    // D9: gallery-label fidelity per the spike (rijksmuseum-spike.md) — room
    // codes come from the Linked Art current_location, no floorplan/routing
    // graph source exists publicly, same tier as AIC/Cleveland/NGA/SMK/V&A.
    fidelity: "room-labels",
    license: {
      // Verified live 2026-07-06 (no dedicated prose terms page found; the
      // machine-readable signal is stronger anyway): every sampled Linked Art
      // record's own `subject_of` metadata node carries a CC0 `subject_to`
      // rights statement, matching the spike's "CC0-leaning" call.
      text: "CC0-1.0",
      images: "", // per-record: sources/rijksmuseum.ts classifyRights() gates imageLicense to CC0-1.0/PDM-1.0 or "" from edm:rights
      attribution: "Rijksmuseum (Amsterdam) open data — data.rijksmuseum.nl (OAI-PMH + Linked Art)",
      termsUrl: "https://data.rijksmuseum.nl/docs",
    },
    // Verified live 2026-07-06: /en/collection/{accession} 301-redirects to
    // the canonical slugged object page and resolves 200 (the numeric
    // id.rijksmuseum.nl id 404s there instead — accession is the right key).
    objectUrlTemplate: "https://www.rijksmuseum.nl/en/collection/{sourceId}",
    translateFrom: "nl",
  },
  {
    id: "brera",
    name: "Pinacoteca di Brera",
    shortName: "Brera",
    city: "Milan",
    country: "IT",
    sites: [
      {
        siteId: "brera",
        name: "Pinacoteca di Brera",
        entrance: { lat: 45.472, lon: 9.188, floor: "1" },
        // Measured 2026-07-06: Palazzo Brera's picture galleries occupy one
        // piano nobile — no authoritative multi-floor mapping exists (nor is
        // one needed), same single-floor convention as SMK/Harvard's floor 0.
        floorOrder: ["1"],
      },
    ],
    // D13: smallest adapter of the fleet — keyless WordPress REST
    // (wp-json/wp/v2/opera), 91.3% opere-sala room fill among the 393
    // exhibited records (see sources/brera.ts header for the full census).
    fidelity: "room-labels",
    license: {
      // No explicit reuse statement found anywhere on the site (legal-notices
      // page is privacy-only) — conservative "-unstated" marker. A written
      // confirmation email to the museum is a tracked follow-up, not a gate.
      text: "brera-unstated",
      images: "", // Italian MiC non-profit-only rule — no image derivatives shipped
      attribution: "Pinacoteca di Brera collection API",
      termsUrl: "https://pinacotecabrera.org/",
    },
    // The WP shortlink form every opera record's own `guid` carries; 301-
    // redirects to the canonical slugged page (verified live 2026-07-06).
    objectUrlTemplate: "https://pinacotecabrera.org/?post_type=opera&p={sourceId}",
    translateFrom: "it",
  },
  {
    id: "egizio",
    name: "Museo Egizio",
    shortName: "Museo Egizio",
    city: "Turin",
    country: "IT",
    sites: [
      {
        siteId: "egizio",
        name: "Museo Egizio",
        // Via Accademia delle Scienze 6 (main entrance).
        entrance: { lat: 45.0678, lon: 7.777, floor: "G" },
        // Measured 2026-07-06 across the 40-page location sample + the
        // 500-page smoke harvest: floors in "Museum location:" strings are
        // Floor -1 / Ground floor / Floor 1 / Floor 2 / Floor 2A (the
        // mezzanine) / Floor 3 (the Writing Gallery, absent from the smaller
        // sample) — see sources/egizio.ts.
        floorOrder: ["-1", "G", "1", "2", "2A", "3"],
      },
    ],
    fidelity: "room-labels",
    license: {
      // The site explicitly grants CC0 on IMAGES ("freely downloadable and
      // reusable under a Creative Commons CC0 Public Domain licence" — every
      // object page, verified 2026-07-06) but states no separate license for
      // the metadata TEXT — "egizio-unstated" is the conservative marker; we
      // ship short factual fields only (see sources/egizio.ts header).
      text: "egizio-unstated",
      images: "CC0-1.0", // per-record: pages without an image get imageLicense=''
      attribution: "Museo Egizio (Turin) — collezioni.museoegizio.it (images CC0)",
      termsUrl: "https://collezioni.museoegizio.it/",
    },
    objectUrlTemplate: "https://collezioni.museoegizio.it/en-GB/material/{sourceId}",
    // en-GB pages are native English — no translateFrom.
  },
  {
    id: "uffizi",
    name: "Galleria degli Uffizi",
    shortName: "Uffizi",
    city: "Florence",
    country: "IT",
    sites: [
      {
        siteId: "uffizi",
        name: "Galleria degli Uffizi",
        // Piazzale degli Uffizi (Door 1 visitor entrance).
        entrance: { lat: 43.7678, lon: 11.2553 },
        // Measured 2026-07-06 in the ArCo location specs: the current
        // lettered room scheme is "primo piano" (B/C/D/E rooms) and
        // "secondo piano" (A rooms) — floors "1"/"2". Older-vintage
        // "sala N" specs carry no floor and stay NULL per gallery (same
        // non-guessing convention as AIC/SMK).
        floorOrder: ["1", "2"],
      },
    ],
    fidelity: "room-labels",
    license: {
      // ICCD national-catalog LOD (dati.beniculturali.it): reuse requires
      // attribution AND share-alike ("citarne la fonte e di condividerli con
      // lo stesso tipo di licenza") — CC-BY-SA-4.0 is the conservative
      // reading; the SA obligation travels in the attribution string.
      text: "CC-BY-SA-4.0",
      images: "", // no image grant — ministry per-request concession only (D.M. 161/2023)
      attribution:
        "ICCD — Catalogo generale dei Beni Culturali linked open data (dati.beniculturali.it), CC BY-SA: attribution required, derivatives share-alike",
      termsUrl: "https://catalogo.beniculturali.it/termini-uso",
    },
    objectUrlTemplate: "https://catalogo.beniculturali.it/detail/HistoricOrArtisticProperty/{sourceId}",
    translateFrom: "it",
  },
];

export function museumInfo(id: string): MuseumInfo {
  const m = MUSEUMS.find((m) => m.id === id);
  if (!m) throw new Error(`unknown museum: ${id}`);
  return m;
}

/** Snapshot dir for a museum. The Met predates the registry and keeps data/snapshots. */
export function snapDirFor(id: string): string {
  return id === "met"
    ? path.join(DATA_ROOT, "snapshots")
    : path.join(DATA_ROOT, "museums", id, "snapshots");
}

const SOURCES: Record<string, MuseumSource> = {
  met: metSource,
  aic: aicSource,
  cleveland: clevelandSource,
  nga: ngaSource,
  smk: smkSource,
  louvre: louvreSource,
  vanda: vandaSource,
  harvard: harvardSource,
  rijksmuseum: rijksmuseumSource,
  brera: breraSource,
  egizio: egizioSource,
  uffizi: uffiziSource,
};

export function sourceFor(id: string): MuseumSource {
  const s = SOURCES[id];
  if (!s) throw new Error(`unknown museum source: ${id} (known: ${Object.keys(SOURCES).join(", ")})`);
  return s;
}
