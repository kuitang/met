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
  };
  /** Object deep-link template; "{sourceId}" is replaced per record. */
  objectUrlTemplate: string;
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
    fidelity: "room-labels",
    license: {
      text: "etalab-2.0",
      images: "", // restricted license — no image derivatives shipped
      attribution: "Musée du Louvre — collections.louvre.fr (Licence Ouverte / Open Licence)",
      termsUrl: "https://collections.louvre.fr/en/page/cgu",
    },
    objectUrlTemplate: "https://collections.louvre.fr/en/ark:/53355/{sourceId}",
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
};

export function sourceFor(id: string): MuseumSource {
  const s = SOURCES[id];
  if (!s) throw new Error(`unknown museum source: ${id} (known: ${Object.keys(SOURCES).join(", ")})`);
  return s;
}
