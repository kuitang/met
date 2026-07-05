/**
 * Harvard Art Museums (Cambridge, MA) source adapter — public `/object`
 * search API (api.harvardartmuseums.org, key required, free registration).
 * Terms (github.com/harvardartmuseums/api-docs): NON-COMMERCIAL use, capped
 * at 2,500 calls/day, and — per the D5b plan this adapter implements —
 * fetched content must not be cached/served for more than 2 weeks. The
 * license-TTL mechanism (registry `license.ttlDays`; see vanda.ts + the
 * "Provenance & the license-TTL mechanism" ARCHITECTURE.md section) reuses
 * its V&A-authored WHERE-clause wiring unchanged — this adapter only needs
 * to declare `ttlDays: 14` in the registry.
 *
 * On-view enumeration: `q=gallery.gallerynumber:*` (any record with a
 * gallery assignment) — measured 2026-07-06: 1,817 on-view objects, 19
 * pages at size=100 (the docs' own examples use size<=100; larger sizes
 * were not tested since 19 requests is already trivial against the 2,500/day
 * cap). Gallery info is NOT in the default field set — it (and every other
 * field this adapter reads) must be requested explicitly via `fields=`, or
 * the API silently omits it (measured: the bare query returns records with
 * no `gallery` key at all, not even null).
 *
 * Row shape (search results alone, no extra per-object hydration needed —
 * `fields=` already returns everything used here):
 *   id -> sourceId; objectnumber -> accession (a handful are loan numbers
 *     like "TL42821.11", still a valid on-record identifier); title;
 *   people[] carries a `role` field ("Artist", "Artist after", …) — first
 *     entry with role "Artist" wins, falling back to people[0] when no
 *     "Artist"-role entry exists (rare) and "" when the object has no
 *     recorded maker;
 *   culture; period (frequently null); classification;
 *   medium = technique || medium (per the plan's convention: the more
 *     specific process field wins when present, else the material);
 *   gallery.gallerynumber -> galleryNumber (string); gallery.floor is ALSO
 *     a string ("0".."4" measured — the docs' sample shows an int, but every
 *     live record returns a string) -> galleries.json floor; gallery.name
 *     -> galleries.json title (e.g. "European Art, 19th-20th century" — a
 *     wing/department label, shared by several adjacent gallery numbers,
 *     same convention as Cleveland/SMK's location-string labels);
 *   lastupdate -> metadataDate.
 * Images: this museum's terms are conservative and unclear on redistribution
 * of image derivatives at this non-commercial tier — imageUrl/imageLicense
 * stay "" for every row (same treatment as V&A/NGA), even though the API
 * does expose `primaryimageurl` (deliberately not requested).
 * Floors measured across the full on-view set: 0 (2 objects, Lower Level
 * Lobby), 1 (512), 2 (603), 3 (688), 4 (12, reception area) — no floor "5"
 * objects exist, so the registry floorOrder is ["0","1","2","3","4"], not
 * the plan's guessed ["1","2","3","4","5"].
 * Delta = full re-pull (19 requests nightly, far under the 2,500/day cap).
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://api.harvardartmuseums.org/object";
const PAGE_SIZE = 100;
const SITE = "harvard";
const LICENSE = "harvard-nc-ttl14"; // -ttl14: the license-TTL mechanism's day count
const FIELDS = [
  "id",
  "objectnumber",
  "title",
  "people",
  "culture",
  "period",
  "classification",
  "medium",
  "technique",
  "gallery",
  "lastupdate",
].join(",");

/**
 * Resolves the Harvard API key at CALL time (not module load) so importing
 * this adapter — e.g. via the registry's static SOURCES map — never throws
 * for museums that don't need it. HARVARD_API_KEY env wins; else falls back
 * to ~/.harvard_key (never logged, never hardcoded).
 */
function apiKey(): string {
  const fromEnv = process.env.HARVARD_API_KEY;
  if (fromEnv) return fromEnv.trim();
  try {
    const fromFile = readFileSync(join(homedir(), ".harvard_key"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "harvard: no API key found — set HARVARD_API_KEY or put your key in ~/.harvard_key " +
      "(register free at https://harvardartmuseums.org/collections/api)",
  );
}

interface HarvardPerson {
  displayname?: string;
  name?: string;
  role?: string;
}

interface HarvardGallery {
  gallerynumber?: string;
  floor?: string;
  name?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** null when the record isn't a placeable on-view Harvard row. */
function toRow(a: any, galleryLabels: Map<string, GalleryLabelRow>): ObjectRow | null {
  const gallery: HarvardGallery = a.gallery ?? {};
  const galleryNumber = String(gallery.gallerynumber ?? "").trim();
  if (!galleryNumber) return null; // location is the product; defensive (q= already filters this)
  if (!galleryLabels.has(galleryNumber)) {
    galleryLabels.set(galleryNumber, {
      galleryNumber,
      site: SITE,
      title: gallery.name ?? undefined,
      floor: gallery.floor != null ? String(gallery.floor) : undefined,
    });
  }

  const people: HarvardPerson[] = Array.isArray(a.people) ? a.people : [];
  const artistEntry = people.find((p) => p.role === "Artist") ?? people[0];
  const artist = artistEntry?.displayname ?? artistEntry?.name ?? "";

  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: String(a.id),
    accession: a.objectnumber ?? "",
    title: String(a.title ?? "").trim(),
    artist,
    culture: a.culture ?? "",
    period: a.period ?? "",
    classification: a.classification ?? "",
    medium: a.technique || a.medium || "",
    tags: "",
    galleryNumber,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal at this tier
    imageUrl: "", // conservative under non-commercial terms — no image derivatives shipped
    metadataDate: a.lastupdate ?? "",
    license: LICENSE,
    imageLicense: "",
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const key = apiKey();
  const c = createPoliteClient({ reqsPerSec: 2, concurrency: 2, maxAttempts: 8, label: "harvard" });
  const t0 = Date.now();

  const q = (page: number): string =>
    `${API}?apikey=${key}&q=${encodeURIComponent("gallery.gallerynumber:*")}&size=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`;

  const first = await c.fetchJson(q(1));
  const total: number = first.info.totalrecords;
  const pages: number = first.info.pages;
  console.log(`harvard: ${total} on-view records, ${pages} pages`);

  const rows: ObjectRow[] = [];
  const galleryLabels = new Map<string, GalleryLabelRow>();
  const seen = new Set<string>();
  let requests = 1;
  const consume = (records: any[]): void => {
    for (const a of records) {
      const row = toRow(a, galleryLabels);
      if (!row) continue;
      if (seen.has(row.sourceId!)) continue;
      seen.add(row.sourceId!);
      rows.push(row);
    }
  };
  consume(first.records ?? []);

  const remainingPages = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  await c.pooledMap(remainingPages, async (page) => {
    const res = await c.fetchJson(q(page));
    requests++;
    consume(res.records ?? []);
  });

  let finalRows = [...rows].sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));
  if (finalRows.length > limit) finalRows = finalRows.slice(0, limit);

  const meta = {
    fetchedAt: new Date().toISOString(),
    onViewTotal: total,
    rows: finalRows.length,
    distinctGalleryNumbers: galleryLabels.size,
    requests,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("harvard meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const harvardSource: MuseumSource = {
  id: "harvard",
  fullFetch,
  // The whole on-view set is ~19 requests — delta IS a full re-pull, same
  // convention as every other non-Met source (well under the 2,500/day cap).
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
