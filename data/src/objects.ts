/**
 * Objects pipeline: Met Open Access API isOnView search → hydrate every ID
 * (~35 req/s, concurrency pool, retry w/ backoff on 429/5xx) → lean rows →
 * data/snapshots/objects.json.gz + vocab.json + objects-meta.json.
 *
 * Usage: tsx src/objects.ts [--limit N]
 */
import { gzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://collectionapi.metmuseum.org/public/collection/v1";
// Measured 2026-06-10: the API sits behind Imperva/Incapsula which 403-blocks this IP at
// sustained >~10-15 req/s (the published 80 req/s cap is NOT what the WAF enforces).
// 10 req/s with few sockets + session cookies is sustainable; 403 bursts lift in ~1 min.
const REQS_PER_SEC = 10;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 10;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// Resume cache: one JSON line per processed objectID, so an interrupted run (WAF block,
// crash) restarts where it left off instead of re-fetching 45k objects.
const RESUME_FILE = "/tmp/met-objects-cache.ndjson";
const EXHIBITION_GALLERIES = new Set(["099", "199", "899", "964", "965", "999"]);

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshots");

interface ObjectRow {
  objectID: number;
  accession: string;
  title: string;
  artist: string;
  culture: string;
  period: string;
  classification: string;
  medium: string;
  tags: string; // '|'-joined terms
  galleryNumber: string;
  site: "fifthAve" | "cloisters";
  rotation: "permanent" | "exhibition";
  isHighlight: boolean;
  imageUrl: string;
  metadataDate: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = ""; // Incapsula session cookies — reusing them keeps us one "visitor"

async function fetchJson(url: string): Promise<any> {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { "user-agent": UA, ...(cookie ? { cookie } : {}) },
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
      continue;
    }
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (res.ok) return res.json();
    if (res.status === 404) return null; // invalid/removed ID
    // 403 = Imperva bot-block (transient, lifts in ~1 min) — wait it out like 429/5xx
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const wait = res.status === 403 ? Math.max(delay, 60_000) : delay;
      if (attempt >= 2) {
        console.log(`${res.status} on ${url}, retry ${attempt}/${MAX_ATTEMPTS} in ${wait / 1000}s`);
      }
      await sleep(wait);
      delay = Math.min(delay * 2, 120_000);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
}

/** Hydrate ids with a concurrency pool, pacing request starts at REQS_PER_SEC. */
async function pooledHydrate(
  ids: number[],
  onResult: (id: number, obj: any) => void,
): Promise<void> {
  const interval = 1000 / REQS_PER_SEC;
  let nextStart = Date.now();
  let i = 0;
  let done = 0;
  const t0 = Date.now();

  async function worker(): Promise<void> {
    while (i < ids.length) {
      const id = ids[i++];
      const wait = nextStart - Date.now();
      nextStart = Math.max(nextStart, Date.now()) + interval;
      if (wait > 0) await sleep(wait);
      const obj = await fetchJson(`${API}/objects/${id}`);
      onResult(id, obj);
      done++;
      if (done % 1000 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        const etaMin = Math.round((ids.length - done) / rate / 60);
        console.log(`hydrated ${done}/${ids.length} (${rate.toFixed(1)} req/s, eta ${etaMin} min)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// galleryNumber → site from Living Map geometry (authoritative; the API's merged
// "Medieval Art and The Cloisters" department cannot distinguish the two sites).
let gallerySiteMap: Map<string, "fifthAve" | "cloisters"> | null = null;
function siteForGallery(gallery: string): "fifthAve" | "cloisters" {
  if (!gallerySiteMap) {
    gallerySiteMap = new Map();
    try {
      const gj = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "galleries.geojson"), "utf8"));
      for (const f of gj.features) {
        const n = String(f.properties.galleryNumber ?? "").trim();
        if (n && (f.properties.site === "fifthAve" || f.properties.site === "cloisters")) {
          gallerySiteMap.set(n, f.properties.site);
          gallerySiteMap.set(n.replace(/^0+/, ""), f.properties.site);
        }
      }
    } catch {
      console.warn("galleries.geojson unavailable — defaulting site to fifthAve");
    }
  }
  return gallerySiteMap.get(gallery) ?? gallerySiteMap.get(gallery.replace(/^0+/, "")) ?? "fifthAve";
}

function toRow(obj: any): ObjectRow {
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
    site: siteForGallery(gallery),
    rotation: EXHIBITION_GALLERIES.has(gallery) ? "exhibition" : "permanent",
    isHighlight: Boolean(obj.isHighlight),
    imageUrl: obj.primaryImageSmall ?? "",
    metadataDate: obj.metadataDate ?? "",
  };
}

async function main(): Promise<void> {
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;

  const t0 = Date.now();
  const onView = await fetchJson(`${API}/search?isOnView=true&q=*`);
  const withImages = await fetchJson(`${API}/search?isOnView=true&hasImages=true&q=*`);
  console.log(`search: ${onView.total} on view, ${withImages.total} with images`);

  let ids: number[] = onView.objectIDs ?? [];
  if (limit < ids.length) ids = ids.slice(0, limit);

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
  const todo = ids.filter((id) => !seen.has(id));

  await pooledHydrate(todo, (id, obj) => {
    let rec: { objectID: number; skip?: string; row?: ObjectRow };
    if (obj === null) {
      notFound++;
      rec = { objectID: id, skip: "notFound" };
    } else if (!String(obj.GalleryNumber ?? "").trim()) {
      skippedNoGallery++; // drifted off-view since the search snapshot
      rec = { objectID: id, skip: "noGallery" };
    } else {
      const row = toRow(obj);
      rows.push(row);
      rec = { objectID: id, row };
    }
    appendFileSync(RESUME_FILE, JSON.stringify(rec) + "\n");
  });
  rows.sort((a, b) => a.objectID - b.objectID);

  // vocab: distinct classifications + cultures with counts (descending)
  const count = (key: "classification" | "culture") => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = r[key];
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  const vocab = { classifications: count("classification"), cultures: count("culture") };

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

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOT_DIR, "objects.json.gz"), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(SNAPSHOT_DIR, "vocab.json"), JSON.stringify(vocab, null, 2));
  writeFileSync(join(SNAPSHOT_DIR, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("meta:", JSON.stringify(meta, null, 2));
}

main();
