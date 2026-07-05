/**
 * Met Open Access API source adapter — the one copy of the Met row mapper and
 * hydration/delta logic (previously duplicated across objects.ts, the retired
 * server refresh, and nightly.ts).
 *
 * Etiquette (measured 2026-06-10): the API sits behind Imperva/Incapsula which
 * 403-blocks sustained >~10-15 req/s (the published 80 req/s cap is NOT what
 * the WAF enforces). 10 req/s with few sockets + session cookies is
 * sustainable; 403 bursts lift in ~1 min. politeFetch implements the waits.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import type { FullFetchOptions, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://collectionapi.metmuseum.org/public/collection/v1";
const EXHIBITION_GALLERIES = new Set(["099", "199", "899", "964", "965", "999"]);
const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Resume cache: one JSON line per processed objectID, so an interrupted full
// hydration (WAF block, crash) restarts where it left off. Lives under
// data/raw/met/ (was /tmp) so it survives reboots.
const RESUME_FILE = join(REPO_DATA, "raw", "met", "objects-cache.ndjson");

function client(maxAttempts: number) {
  return createPoliteClient({ reqsPerSec: 10, concurrency: 4, maxAttempts, label: "met" });
}

// galleryNumber → site from Living Map geometry (authoritative; the API's merged
// "Medieval Art and The Cloisters" department cannot distinguish the two sites).
function makeSiteForGallery(snapDir: string): (gallery: string) => "fifthAve" | "cloisters" {
  let map: Map<string, "fifthAve" | "cloisters"> | null = null;
  return (gallery) => {
    if (!map) {
      map = new Map();
      try {
        const gj = JSON.parse(readFileSync(join(snapDir, "galleries.geojson"), "utf8"));
        for (const f of gj.features) {
          const n = String(f.properties.galleryNumber ?? "").trim();
          if (n && (f.properties.site === "fifthAve" || f.properties.site === "cloisters")) {
            map.set(n, f.properties.site);
            map.set(n.replace(/^0+/, ""), f.properties.site);
          }
        }
      } catch {
        console.warn("galleries.geojson unavailable — defaulting site to fifthAve");
      }
    }
    return map.get(gallery) ?? map.get(gallery.replace(/^0+/, "")) ?? "fifthAve";
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(siteFor: (g: string) => "fifthAve" | "cloisters", obj: any): ObjectRow {
  const gallery = String(obj.GalleryNumber ?? "").trim();
  return {
    objectID: obj.objectID,
    accession: obj.accessionNumber ?? "",
    title: obj.title ?? "",
    artist: obj.artistDisplayName ?? "",
    culture: obj.culture ?? "",
    period: obj.period ?? "",
    classification: obj.classification ?? "",
    medium: obj.medium ?? "",
    tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => t.term).join("|") : "",
    galleryNumber: gallery,
    site: siteFor(gallery),
    rotation: EXHIBITION_GALLERIES.has(gallery) ? "exhibition" : "permanent",
    isHighlight: Boolean(obj.isHighlight),
    imageUrl: obj.primaryImageSmall ?? "",
    metadataDate: obj.metadataDate ?? "",
  };
}

/** vocab.json: distinct classifications + cultures with counts (descending). */
function buildVocab(rows: ObjectRow[]) {
  const count = (key: "classification" | "culture") => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = r[key];
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  return { classifications: count("classification"), cultures: count("culture") };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = client(10);
  const t0 = Date.now();

  const onView = await c.fetchJson(`${API}/search?isOnView=true&q=*`);
  const withImages = await c.fetchJson(`${API}/search?isOnView=true&hasImages=true&q=*`);
  console.log(`met search: ${onView.total} on view, ${withImages.total} with images`);

  let ids: number[] = onView.objectIDs ?? [];
  if (limit < ids.length) ids = ids.slice(0, limit);

  const siteFor = makeSiteForGallery(snapDir);
  const rows: ObjectRow[] = [];
  let skippedNoGallery = 0;
  let notFound = 0;

  // Resume: replay previously processed IDs from the cache, hydrate only the rest.
  const seen = new Set<number>();
  if (existsSync(RESUME_FILE)) {
    for (const line of readFileSync(RESUME_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (seen.has(rec.objectID)) continue;
      seen.add(rec.objectID);
      if (rec.skip === "noGallery") skippedNoGallery++;
      else if (rec.skip === "notFound") notFound++;
      else rows.push(rec.row);
    }
    console.log(`resume: ${seen.size} already processed in ${RESUME_FILE}`);
  }
  mkdirSync(dirname(RESUME_FILE), { recursive: true });
  const todo = ids.filter((id) => !seen.has(id));

  await c.pooledMap(todo, async (id) => {
    const obj = await c.fetchJson(`${API}/objects/${id}`);
    let rec: { objectID: number; skip?: string; row?: ObjectRow };
    if (obj === null) {
      notFound++;
      rec = { objectID: id, skip: "notFound" };
    } else if (!String(obj.GalleryNumber ?? "").trim()) {
      skippedNoGallery++; // drifted off-view since the search snapshot
      rec = { objectID: id, skip: "noGallery" };
    } else {
      const row = toRow(siteFor, obj);
      rows.push(row);
      rec = { objectID: id, row };
    }
    appendFileSync(RESUME_FILE, JSON.stringify(rec) + "\n");
  });
  rows.sort((a, b) => a.objectID - b.objectID);

  const bySite: Record<string, number> = {};
  const byRotation: Record<string, number> = {};
  const galleries = new Set<string>();
  for (const r of rows) {
    bySite[r.site] = (bySite[r.site] ?? 0) + 1;
    byRotation[r.rotation] = (byRotation[r.rotation] ?? 0) + 1;
    galleries.add(r.galleryNumber);
  }
  const meta = {
    fetchedAt: new Date().toISOString(),
    searchTotalOnView: onView.total,
    searchTotalWithImages: withImages.total,
    hydrated: ids.length,
    rows: rows.length,
    skipped: { noGallery: skippedNoGallery, notFound },
    bySite,
    byRotation,
    floorUnknown: null, // floor comes from the geometry pipeline; joined at build-db time
    distinctGalleryNumbers: galleries.size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(rows), null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("meta:", JSON.stringify(meta, null, 2));
  return meta;
}

/** Met API delta against the known rows in snapDir/objects.json.gz (in place). */
async function delta(snapDir: string, since: string): Promise<number> {
  const c = client(8);
  const snapPath = join(snapDir, "objects.json.gz");
  const known = new Map<number, ObjectRow>(
    (JSON.parse(gunzipSync(readFileSync(snapPath)).toString("utf8")) as ObjectRow[]).map((r) => [
      r.objectID,
      r,
    ]),
  );

  const onView = (await c.fetchJson(`${API}/search?isOnView=true&q=*`)) as {
    total: number;
    objectIDs: number[] | null;
  };
  const onViewIds = new Set(onView.objectIDs ?? []);
  const changed = (await c.fetchJson(`${API}/objects?metadataDate=${since}`)) as {
    objectIDs: number[] | null;
  } | null;

  // Hydrate: anything on view we don't know yet, plus known-or-on-view objects
  // whose metadata changed since the last build.
  const todo = new Set<number>();
  for (const id of onViewIds) if (!known.has(id)) todo.add(id);
  for (const id of changed?.objectIDs ?? []) {
    if (onViewIds.has(id) || known.has(id)) todo.add(id);
  }
  console.log(
    `met delta: ${onViewIds.size} on view, ${known.size} known, ${todo.size} to hydrate (since ${since})`,
  );

  const siteFor = makeSiteForGallery(snapDir);
  const ids = [...todo];
  await c.pooledMap(ids, async (id) => {
    const obj = await c.fetchJson(`${API}/objects/${id}`);
    if (obj === null || !String((obj as any).GalleryNumber ?? "").trim()) known.delete(id);
    else known.set(id, toRow(siteFor, obj));
  });

  // Tombstone rows that fell off view entirely.
  for (const id of [...known.keys()]) if (!onViewIds.has(id)) known.delete(id);

  const rows = [...known.values()].sort((a, b) => a.objectID - b.objectID);
  writeFileSync(snapPath + ".tmp", gzipSync(JSON.stringify(rows)));
  renameSync(snapPath + ".tmp", snapPath);
  writeFileSync(
    join(snapDir, "objects-meta.json"),
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        refreshedBy: "data/src/sources/met.ts#delta",
        searchTotalOnView: onView.total,
        hydrated: ids.length,
        rows: rows.length,
      },
      null,
      2,
    ),
  );
  return ids.length;
}

export const metSource: MuseumSource = { id: "met", fullFetch, delta };
