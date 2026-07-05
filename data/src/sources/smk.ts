/**
 * SMK (Statens Museum for Kunst, Copenhagen) source adapter — public search
 * API (no key): `on_display:true` filter (measured 2026-07-05: found=1,481,
 * matching the plan's ~1.5k estimate) returns the whole on-view set in a
 * handful of `rows=500` pages.
 *
 * `current_location_name` is "Sal <room>" (Danish for "Room"), e.g. "Sal
 * 217", "Sal 263A" — parsed the same way as Cleveland's leading-token code.
 * No authoritative gallery->floor mapping is published, so floors stay null
 * per gallery (site floorOrder is a single placeholder floor, same
 * non-guessing convention AIC uses).
 *
 * Titles: `titles[]` carries a `language` tag (mostly "dansk", sometimes a
 * foreign original like "fransk"/"italiensk", rarely "engelsk"). Danish (or
 * the first title when none is tagged dansk) goes in `title`; an "engelsk"
 * entry, when present, goes in `titleAlt`.
 * Dating: `production_date[].period` (NOT the top-level `dating` field,
 * which is null in every measured record).
 * Images: `image_thumbnail`; imageLicense gates on `public_domain` (rights
 * URL is the Public Domain Mark, not CC0, but the fleet's per-record
 * imageLicense column is a binary "derivatives OK" signal — same treatment
 * AIC gives `is_public_domain`).
 * Delta = full re-pull (the whole on-view set is ~3 requests).
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://api.smk.dk/api/v1/art/search/";
const PAGE_SIZE = 500;
const SITE = "smk"; // single building; globally-unique site id = museum id

/** "Sal 217" -> "217"; anything unparseable keeps the full string. */
const roomCode = (locationName: string): string => {
  const m = locationName.trim().match(/^Sal\s+(.+)$/i);
  return (m ? m[1] : locationName).trim();
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(a: any, galleryLabels: Map<string, GalleryLabelRow>): ObjectRow | null {
  const locationName = String(a.current_location_name ?? "").trim();
  if (!locationName) return null; // location is the product
  const code = roomCode(locationName);
  if (!galleryLabels.has(code)) {
    galleryLabels.set(code, { galleryNumber: code, site: SITE });
  }

  const titles: Array<{ title: string; language?: string }> = Array.isArray(a.titles) ? a.titles : [];
  const danish = titles.find((t) => t.language === "dansk") ?? titles[0];
  const english = titles.find((t) => t.language === "engelsk");
  const objectNames: Array<{ name: string }> = Array.isArray(a.object_names) ? a.object_names : [];
  const production: Array<{ creator_nationality?: string }> = Array.isArray(a.production) ? a.production : [];
  const medium =
    (Array.isArray(a.techniques) && a.techniques.length ? a.techniques : a.materials) ?? [];

  const imageUrl = a.image_thumbnail ?? "";
  const isPublicDomain = Boolean(a.public_domain);

  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: a.object_number,
    accession: a.object_number ?? "",
    title: danish?.title ?? "",
    artist: Array.isArray(a.artist) ? a.artist.join("; ") : "",
    culture: production[0]?.creator_nationality ?? "",
    period: a.production_date?.[0]?.period ?? "",
    classification: objectNames[0]?.name ?? "",
    medium: medium.join("; "),
    tags: objectNames.map((n) => n.name).join("|"),
    galleryNumber: code,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // SMK's API exposes no curated-highlight signal
    imageUrl,
    metadataDate: a.modified ?? "",
    titleAlt: english?.title ?? "",
    license: "CC0-1.0",
    imageLicense: isPublicDomain && imageUrl ? "CC0-1.0" : "",
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = createPoliteClient({ reqsPerSec: 4, concurrency: 2, maxAttempts: 8, label: "smk" });
  const t0 = Date.now();

  const filter = encodeURIComponent("[on_display:true]");
  const first = await c.fetchJson(`${API}?keys=*&filters=${filter}&rows=1&offset=0`);
  const total: number = first.found;
  console.log(`smk: ${total} on-view records`);

  const offsets: number[] = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE) offsets.push(offset);

  const rows: ObjectRow[] = [];
  const galleryLabels = new Map<string, GalleryLabelRow>();
  let skippedNoLocation = 0;
  let pagesDone = 0;
  await c.pooledMap(offsets, async (offset) => {
    const res = await c.fetchJson(`${API}?keys=*&filters=${filter}&rows=${PAGE_SIZE}&offset=${offset}`);
    for (const a of res.items) {
      const row = toRow(a, galleryLabels);
      if (!row) skippedNoLocation++;
      else rows.push(row);
    }
    pagesDone++;
    console.log(`smk: page ${pagesDone}/${offsets.length} (offset=${offset}), ${rows.length} rows so far`);
  });

  const bySource = new Map(rows.map((r) => [r.sourceId!, r]));
  let finalRows = [...bySource.values()].sort((a, b) => a.sourceId!.localeCompare(b.sourceId!));
  if (finalRows.length > limit) finalRows = finalRows.slice(0, limit);

  const meta = {
    fetchedAt: new Date().toISOString(),
    onViewTotal: total,
    rows: finalRows.length,
    skipped: { noLocation: skippedNoLocation },
    distinctGalleryNumbers: galleryLabels.size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("smk meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const smkSource: MuseumSource = {
  id: "smk",
  fullFetch,
  // The whole on-view set is ~3 requests — delta IS a full re-pull.
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
