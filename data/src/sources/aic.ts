/**
 * Art Institute of Chicago source adapter — the cleanest source in the fleet:
 * one public search API (no key), an explicit machine-readable CC0 license on
 * every response (only `description` is CC-BY; we don't ship it), boolean
 * `is_on_view`, and `gallery_title`/`gallery_id` 100% filled for on-view rows
 * (measured 2026-07-05: 3,516 on-view of ~120k records).
 *
 * Enumeration: per-gallery partition — the search endpoint hard-403s past
 * result 1,000 (Elasticsearch window cap, measured 2026-07-05: pages 1-10 of
 * the flat on-view query work, page 11 is a persistent 403), so we list the
 * 179 galleries (/api/v1/galleries, which also gives titles + is_closed) and
 * run one on-view search per gallery (~190 requests total). Delta = full
 * re-pull (cheap enough every night).
 * Images: IIIF derivatives; imageLicense gates on is_public_domain.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://api.artic.edu/api/v1/artworks/search";
const FIELDS = [
  "id",
  "title",
  "artist_title",
  "artist_display",
  "date_display",
  "place_of_origin",
  "classification_title",
  "medium_display",
  "term_titles",
  "gallery_title",
  "gallery_id",
  "is_on_view",
  "is_public_domain",
  "is_boosted",
  "image_id",
  "main_reference_number",
  "timestamp",
].join(",");
const PAGE_SIZE = 100;
const SITE = "aic"; // single building; globally-unique site id = museum id

/** IIIF Image API 2.0 URL the AIC documents for public-domain derivatives. */
const iiifUrl = (imageId: string): string =>
  `https://www.artic.edu/iiif/2/${imageId}/full/843,/0/default.jpg`;

/** "Gallery 241" → room code "241"; anything unparseable keeps the full string. */
const roomCode = (galleryTitle: string): string => {
  const m = galleryTitle.match(/^Gall?ery\s+(.+)$/i);
  return (m ? m[1] : galleryTitle).trim();
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(a: any): ObjectRow | null {
  const galleryTitle = String(a.gallery_title ?? "").trim();
  if (!a.is_on_view || !galleryTitle) return null; // location is the product
  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: String(a.id),
    accession: a.main_reference_number ?? "",
    title: a.title ?? "",
    artist: a.artist_title ?? a.artist_display ?? "",
    culture: a.place_of_origin ?? "",
    period: a.date_display ?? "",
    classification: a.classification_title ?? "",
    medium: a.medium_display ?? "",
    tags: Array.isArray(a.term_titles) ? [...new Set(a.term_titles)].join("|") : "",
    galleryNumber: roomCode(galleryTitle),
    site: SITE,
    rotation: "permanent",
    isHighlight: Boolean(a.is_boosted),
    imageUrl: a.image_id ? iiifUrl(String(a.image_id)) : "",
    metadataDate: a.timestamp ?? "",
    license: "CC0-1.0",
    imageLicense: a.is_public_domain && a.image_id ? "CC0-1.0" : "",
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = createPoliteClient({ reqsPerSec: 4, concurrency: 2, maxAttempts: 8, label: "aic" });
  const t0 = Date.now();

  // 1. Gallery list: titles + closed flags, and the partition keys that keep
  //    every search under the ES window cap.
  interface AicGallery {
    id: number;
    title: string;
    is_closed: boolean;
  }
  const galleries: AicGallery[] = [];
  for (let page = 1; ; page++) {
    const res = await c.fetchJson(
      `https://api.artic.edu/api/v1/galleries?limit=100&page=${page}&fields=id,title,is_closed`,
    );
    galleries.push(...res.data);
    if (page >= res.pagination.total_pages) break;
  }
  const galleryLabels = new Map<string, GalleryLabelRow>();
  for (const g of galleries) {
    const code = roomCode(String(g.title ?? "").trim());
    if (!code) continue;
    // Keep the museum's own display name; floor is left NULL — AIC gallery
    // numbering encodes floor loosely (2xx ≈ level 2) but the museum
    // publishes no authoritative mapping, so we don't guess.
    galleryLabels.set(code, {
      galleryNumber: code,
      site: SITE,
      title: String(g.title).trim(),
      ...(g.is_closed ? { closed: true } : null),
    });
  }
  console.log(`aic: ${galleries.length} galleries listed`);

  // 2. One on-view search per gallery.
  const rows: ObjectRow[] = [];
  let skippedNoGallery = 0;
  let searched = 0;
  for (const g of galleries) {
    if (rows.length >= limit) break;
    searched++;
    for (let page = 1; ; page++) {
      // Two term filters need the bool/must form — a second query[term] key
      // is a 400 (measured).
      const res = await c.fetchJson(
        `${API}?query%5Bbool%5D%5Bmust%5D%5B0%5D%5Bterm%5D%5Bis_on_view%5D=true` +
          `&query%5Bbool%5D%5Bmust%5D%5B1%5D%5Bterm%5D%5Bgallery_id%5D=${g.id}` +
          `&limit=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`,
      );
      for (const a of res.data) {
        const row = toRow(a);
        if (!row) skippedNoGallery++;
        else rows.push(row);
      }
      if (page >= res.pagination.total_pages) break;
    }
    if (searched % 50 === 0) console.log(`aic: ${searched}/${galleries.length} galleries, ${rows.length} rows`);
  }
  // Dedupe by sourceId (search pagination can shift under writes) and sort.
  const bySource = new Map(rows.map((r) => [r.sourceId!, r]));
  const finalRows = [...bySource.values()].sort((a, b) =>
    a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }),
  );

  const meta = {
    fetchedAt: new Date().toISOString(),
    galleriesListed: galleries.length,
    rows: finalRows.length,
    skipped: { noGallery: skippedNoGallery },
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
  console.log("aic meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const aicSource: MuseumSource = {
  id: "aic",
  fullFetch,
  // The whole on-view set is ~36 requests — delta IS a full re-pull.
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
