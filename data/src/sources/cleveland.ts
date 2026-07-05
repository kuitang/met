/**
 * Cleveland Museum of Art source adapter — public Open Access API (no key),
 * explicit per-record `share_license_status` (CC0 vs Copyrighted; CMA's own
 * vocabulary, not the Met/AIC "is_public_domain" boolean).
 *
 * Enumeration: the API's `currently_on_view=1` filter (measured 2026-07-05:
 * 6,903 of 68,743 records) is the on-view set directly — no separate gallery
 * listing endpoint exists, so gallery labels are collected as a byproduct of
 * paging the on-view records (same trick as a synthesized-galleries museum,
 * just done inside the adapter instead of at build-db time so floors can be
 * derived from the room-code numbering).
 *
 * `current_location` is a single string "<room code> <room label>" (e.g.
 * "204 Colonial American", "106A Migration Period & Coptic", "004 Special
 * Exhibition Gallery"). Room codes are 3-digit + optional trailing letter;
 * codes < 200 are floor 1, >= 200 are floor 2 (measured: the on-view set only
 * spans 004-118 and 200-244 — no 3xx+ galleries currently on view).
 *
 * Images: `images.web.url`; imageLicense gates on share_license_status===CC0
 * AND an image existing (CMA ships Copyrighted-status records with images
 * too — those must not be tagged as derivative-safe).
 * Delta = full re-pull (page-only enumeration, ~14 requests at limit=500).
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://openaccess-api.clevelandart.org/api/artworks/";
const PAGE_SIZE = 500;
const SITE = "cleveland"; // single building; globally-unique site id = museum id

/** "204 Colonial American" -> { code: "204", label: "Colonial American" }. */
function parseLocation(current_location: string): { code: string; label: string } | null {
  const s = current_location.trim();
  if (!s) return null;
  const m = s.match(/^(\S+)\s+(.+)$/);
  return m ? { code: m[1], label: m[2].trim() } : { code: s, label: "" };
}

/** Room-code leading digits -> coarse floor (measured: on-view codes are 0xx-1xx = floor 1, 2xx = floor 2). */
function floorForCode(code: string): string {
  const n = parseInt(code.replace(/\D+$/, ""), 10);
  return Number.isFinite(n) && n >= 200 ? "2" : "1";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(a: any, galleryLabels: Map<string, GalleryLabelRow>): ObjectRow | null {
  const loc = parseLocation(String(a.current_location ?? ""));
  if (!loc) return null; // location is the product
  const { code, label } = loc;
  if (label && !galleryLabels.has(code)) {
    galleryLabels.set(code, {
      galleryNumber: code,
      site: SITE,
      title: label,
      floor: floorForCode(code),
    });
  }
  const isCC0 = a.share_license_status === "CC0";
  const imageUrl = a.images?.web?.url ?? "";
  const artist = Array.isArray(a.creators)
    ? [...new Set(a.creators.map((c: any) => String(c.description ?? "").trim()).filter(Boolean))].join("; ")
    : "";
  const culture = Array.isArray(a.culture) ? a.culture.join("; ") : String(a.culture ?? "");
  const sourceId = String(a.accession_number ?? a.id);
  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId,
    accession: String(a.accession_number ?? ""),
    title: a.title ?? "",
    artist,
    culture,
    period: a.creation_date ?? "",
    classification: a.type ?? "",
    medium: a.technique ?? "",
    tags: [a.department, a.collection].filter(Boolean).join("|"),
    galleryNumber: code,
    site: SITE,
    rotation: /special exhibition/i.test(label) ? "exhibition" : "permanent",
    isHighlight: false, // CMA's API exposes no curated-highlight signal
    imageUrl,
    metadataDate: a.updated_at ?? "",
    license: isCC0 ? "CC0-1.0" : "Copyrighted",
    imageLicense: isCC0 && imageUrl ? "CC0-1.0" : "",
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = createPoliteClient({ reqsPerSec: 4, concurrency: 2, maxAttempts: 8, label: "cleveland" });
  const t0 = Date.now();

  const first = await c.fetchJson(`${API}?limit=1&skip=0&currently_on_view=1`);
  const total: number = first.info.total;
  console.log(`cleveland: ${total} on-view records`);

  const skips: number[] = [];
  for (let skip = 0; skip < total; skip += PAGE_SIZE) skips.push(skip);

  const rows: ObjectRow[] = [];
  const galleryLabels = new Map<string, GalleryLabelRow>();
  let skippedNoLocation = 0;
  let pagesDone = 0;
  await c.pooledMap(skips, async (skip) => {
    const res = await c.fetchJson(`${API}?limit=${PAGE_SIZE}&skip=${skip}&currently_on_view=1`);
    for (const a of res.data) {
      const row = toRow(a, galleryLabels);
      if (!row) skippedNoLocation++;
      else rows.push(row);
    }
    pagesDone++;
    console.log(`cleveland: page ${pagesDone}/${skips.length} (skip=${skip}), ${rows.length} rows so far`);
  });

  // Dedupe by sourceId (pagination can shift under concurrent writes) and sort.
  const bySource = new Map(rows.map((r) => [r.sourceId!, r]));
  let finalRows = [...bySource.values()].sort((a, b) =>
    a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }),
  );
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
  writeFileSync(
    join(snapDir, "galleries.json"),
    JSON.stringify([...galleryLabels.values()], null, 2),
  );
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("cleveland meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const clevelandSource: MuseumSource = {
  id: "cleveland",
  fullFetch,
  // Page-only enumeration (~14 requests) — delta IS a full re-pull.
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
