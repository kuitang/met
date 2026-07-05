/**
 * National Gallery of Art (Washington DC) source adapter — daily-refreshed
 * CSVs at github.com/NationalGalleryOfArt/opendata (CC0, no key, no API).
 * `objects.csv` (~130k rows, ~82 MB) joins `locations.csv` (~1,191 public
 * locations) via `locationid`; only rows with a non-empty locationid resolve
 * to a room (measured 2026-07-05: on-view fraction is small — location is
 * the product, everything else is skipped).
 *
 * `locations.csv.room` is already a structured code ("G-001-A", "M-052",
 * "EG-101", "ET-501") — no free-text parsing needed, unlike Cleveland/SMK.
 * Room-code prefix -> floor (measured across the 1,191-row locations table):
 *   West Building: "G-" = Ground, "M-" = Main
 *   East Building: "EC-" = Concourse, "EG-" = Ground, "EM-" = Mezzanine,
 *                  "ET-" = Tower; the handful of lawn/terrace codes
 *                  (EBL/ENT/EST) count as Ground (exterior, same level).
 *   Sculpture Garden (WSG) quads (NW/NE/SE/SW-Quad) fold into the West
 *   Building site at a "Garden" floor (physically attached to the West
 *   Building, Constitution Ave side).
 *   "Off-Site Storage" and the one blank-site row have no public room and
 *   are skipped.
 *
 * Images are EXCLUDED per the open-data grant (iiif URLs exist in
 * `published_images.csv` but that file conflates open-access and
 * fair-use-only rights — the plan explicitly excludes NGA images, so that
 * CSV is never fetched); imageUrl is '' for every row, imageLicense stays at
 * the registry default ('').
 * `attribution` (already a display-ready artist string, e.g. "Grifo di
 * Tancredi") is used directly — no need for the objects_constituents join.
 * Delta = full re-pull (the CSVs themselves are refreshed daily upstream).
 */
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync, createWriteStream, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { parseCsv } from "../lib/csv.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const RAW = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type SiteId = "nga-west" | "nga-east";

interface RoomInfo {
  site: SiteId;
  room: string;
  floor: string;
  description: string;
}

/** locations.csv "site" text -> our registry site id; null = not a public on-view site. */
function siteFor(rawSite: string): SiteId | null {
  if (rawSite === "West Building" || rawSite === "Sculpture Garden (WSG)") return "nga-west";
  if (rawSite === "East Building") return "nga-east";
  return null; // "Off-Site Storage", blank -> no public room
}

function floorFor(site: SiteId, room: string): string {
  if (room.startsWith("G-")) return "Ground";
  if (room.startsWith("M-")) return "Main";
  if (room.startsWith("EC-")) return "Concourse";
  if (room.startsWith("EG-")) return "Ground";
  if (room.startsWith("EM-")) return "Mezzanine";
  if (room.startsWith("ET-")) return "Tower";
  if (room.endsWith("-Quad")) return "Garden";
  if (room === "EBL" || room === "ENT" || room === "EST") return "Ground";
  return site === "nga-west" ? "Ground" : "Concourse";
}

async function download(url: string, dest: string, force = false): Promise<void> {
  if (!force && existsSync(dest)) {
    console.log(`nga: using cached ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`nga: downloading ${url}`);
  const res = await fetch(url, { headers: { "user-agent": BROWSER_UA } });
  if (!res.ok || !res.body) throw new Error(`${res.status} fetching ${url}`);
  const tmp = dest + ".tmp";
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, dest);
}

function loadRoomMap(locationsCsv: string): Map<string, RoomInfo> {
  const rows = parseCsv(locationsCsv);
  const byLocationId = new Map<string, RoomInfo>();
  for (const r of rows) {
    const site = siteFor(r.site);
    if (!site) continue;
    const room = r.room.trim();
    if (!room) continue;
    byLocationId.set(r.locationid, {
      site,
      room,
      floor: floorFor(site, room),
      description: r.description.trim(),
    });
  }
  return byLocationId;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(o: Record<string, string>, room: RoomInfo): ObjectRow {
  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: o.objectid,
    accession: o.accessionnum ?? "",
    title: o.title ?? "",
    artist: o.attribution || o.attributioninverted || "",
    culture: "",
    period: o.displaydate ?? "",
    classification: o.classification ?? "",
    medium: o.medium ?? "",
    tags: o.subclassification ?? "",
    galleryNumber: room.room,
    site: room.site,
    rotation: "permanent",
    isHighlight: false,
    imageUrl: "", // images excluded from the open-data grant
    metadataDate: o.lastdetectedmodification ?? "",
  };
}

async function build(snapDir: string, limit: number, forceDownload = false): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const rawDir = join(dirname(new URL(import.meta.url).pathname), "..", "..", "raw", "nga");
  const objectsPath = join(rawDir, "objects.csv");
  const locationsPath = join(rawDir, "locations.csv");
  await download(`${RAW}/locations.csv`, locationsPath, forceDownload);
  await download(`${RAW}/objects.csv`, objectsPath, forceDownload);

  const roomMap = loadRoomMap(readFileSync(locationsPath, "utf8"));
  console.log(`nga: ${roomMap.size} public locations loaded`);

  const objects = parseCsv(readFileSync(objectsPath, "utf8"));
  console.log(`nga: ${objects.length} total object rows`);

  const rows: ObjectRow[] = [];
  const galleryLabels = new Map<string, GalleryLabelRow>();
  let skippedNoLocation = 0;
  for (const o of objects) {
    if (rows.length >= limit) break;
    const room = o.locationid ? roomMap.get(o.locationid) : undefined;
    if (!room) {
      skippedNoLocation++;
      continue;
    }
    rows.push(toRow(o, room));
    const key = `${room.room} ${room.site}`;
    if (!galleryLabels.has(key)) {
      galleryLabels.set(key, {
        galleryNumber: room.room,
        site: room.site,
        title: room.description || undefined,
        floor: room.floor,
      });
    }
  }

  const bySite: Record<string, number> = {};
  for (const r of rows) bySite[r.site] = (bySite[r.site] ?? 0) + 1;

  const meta = {
    fetchedAt: new Date().toISOString(),
    totalObjectRows: objects.length,
    publicLocations: roomMap.size,
    rows: rows.length,
    skipped: { noLocation: skippedNoLocation },
    bySite,
    distinctGalleryNumbers: galleryLabels.size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(rows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("nga meta:", JSON.stringify(meta, null, 2));
  return meta;
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  return build(opts.snapDir, opts.limit ?? Infinity);
}

export const ngaSource: MuseumSource = {
  id: "nga",
  fullFetch,
  // The upstream CSVs are themselves refreshed daily — delta IS a full
  // re-pull, forcing a fresh download past the dev-convenience cache.
  delta: async (snapDir) => {
    const meta = await build(snapDir, Infinity, true);
    return meta.rows as number;
  },
};
