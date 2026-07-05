/**
 * Victoria and Albert Museum (London) source adapter — public Collections API
 * v2 (api.vam.ac.uk, no key). Terms of use (§9, developers.vam.ac.uk/guide/v2/
 * quick-start.html): NON-COMMERCIAL use only, capped at 3,000 calls/day at
 * <=1 req/s, and fetched content must not be cached/served for more than 4
 * weeks — the license-TTL mechanism in shared/search.ts + SqliteDataProvider
 * (see ARCHITECTURE.md "Provenance & the license-TTL mechanism") is what
 * enforces that 28-day cap in the shipped artifact, not this adapter.
 *
 * On-view enumeration (measured 2026-07-05 — the plan's ~25.8k/259-page
 * estimate was stale; re-verify before trusting either number again):
 *   `on_display_at` accepts `southken|dundee|moc|yva|wed|es|em|all` (the enum
 *   comes back in a 422 body — it is undocumented past the original 3 sites in
 *   the prose guide). We use `southken` (V&A South Kensington only, site
 *   "VA") because the registry models exactly one V&A site with one entrance
 *   (Cromwell Road) — `all` also pulls in Young V&A (Bethnal Green) and V&A
 *   East (Stratford), different buildings this artifact doesn't place.
 *   `on_display_at=southken` measured 58,102 on-view records, ALL with
 *   `_currentLocation.onDisplay === true` and a "…, Room N…"-shaped
 *   displayName (0 counterexamples in a multi-hundred-record sample).
 *
 * Deep-pagination cap (measured): `page`/`page_size` cannot reach past
 * page*page_size = 10,000 for ANY filter combination — page 101 (or any
 * offset beyond 10k) 500s, and `page_offset` is silently ignored (same
 * response as page_offset=0). This is the same class of ES max-result-window
 * cap AIC hits. 58,102 >> 10,000, so unlike AIC (one query per gallery was
 * enough) we need a two-level partition:
 *   1. `/v2/objects/clusters/gallery/search?cluster_size=100` (100 is the
 *      documented cluster_size max) returns the on-view set partitioned by
 *      gallery, nested one level under a single "VA" node. One query per
 *      listed gallery (`id_gallery=<THES id>`) fetches that room's rows.
 *   2. Two galleries (Ceramics Room 139: 12,580; Room 137: 10,857 at
 *      measurement time) exceed 10,000 themselves — sub-partitioned by
 *      `/v2/objects/clusters/object_type/search` (flat list, id=value=the
 *      plain objectType string) scoped with the same `id_gallery`, filtered
 *      with `kw_object_type=<value>` (verified: `id_object_type` is silently
 *      ignored, `kw_object_type` genuinely filters).
 *   3. Negation (`id_gallery=-X` / `kw_object_type=-X`, repeated per value,
 *      verified to AND-combine: excluding two galleries dropped the record
 *      count by exactly their two individual counts) recovers whatever a
 *      cluster's top-100 terms didn't enumerate — both at the top level
 *      (galleries beyond the top 100) and inside the two split galleries
 *      (object types beyond their top 100).
 * Every partition is paginated by walking pages until a short page (< page
 * size) comes back, rather than trusting the cluster's `count` (measured
 * marginally stale under concurrent edits) — self-terminating and cheap to
 * verify. If a partition's page 100 STILL comes back full, that partition
 * truly exceeds 10,000 and needs a third split level; we throw rather than
 * silently drop rows (no such case existed at measurement time).
 *
 * Row shape from search results alone (NO per-object hydration — verified
 * every field below is present on the search/list endpoint, matching the
 * plan's "verify with 2 live calls" gate):
 *   systemNumber ("O9138") -> sourceId; accessionNumber -> accession;
 *   _primaryTitle -> title, EMPTY on ~97% of records (measured) -> falls back
 *     to objectType (the V&A's own site does the same for untitled pieces);
 *   _primaryMaker.name -> artist (maker is sometimes {} with no `name`);
 *   _primaryDate -> period; _primaryPlace -> culture; objectType ->
 *     classification; _currentLocation.displayName -> gallery label (full
 *     string) + room code (parsed); _currentLocation.detail
 *     {case,shelf,box,free} -> locationNote. No materialsAndTechniques,
 *     term/keyword, or last-modified field exists at this tier — medium,
 *     tags and metadataDate stay "" (a documented limitation of skipping
 *     hydration, same tradeoff SMK/NGA make elsewhere in the fleet).
 * Images: V&A's terms do not grant redistribution of image derivatives —
 * imageUrl and imageLicense are BOTH "" for every row (same treatment as NGA:
 * see sources/nga.ts). `license` is "vanda-nc-ttl28" per record (the -ttlNN
 * suffix is what the TTL mechanism keys off, see shared/search.ts).
 * Delta = full re-pull (an on-view snapshot this size is still cheap at the
 * mandated <=1 req/s: ~15 minutes, well under the 3,000 calls/day cap).
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const API = "https://api.vam.ac.uk/v2/objects/search";
const CLUSTER_API = "https://api.vam.ac.uk/v2/objects/clusters";
const PAGE_SIZE = 100;
const CAP = 10_000; // measured hard window: page(<=100) * page_size(100)
const SITE = "vanda";
const LICENSE = "vanda-nc-ttl28"; // -ttl28: the license-TTL mechanism's day count
const MIN_INTERVAL_MS = 1000; // V&A terms §9: <=1 req/s

/**
 * "Ceramics, Room 139, The Curtain Foundation Gallery" -> "139". Measured
 * label shapes the compact-code regex must survive (all real, 2026-07-05):
 * "Room 125c" (letter suffix), "Rooms 91 to 93  mezzanine" (plural + range —
 * first number wins, merging the mezzanine location into the same room-91
 * gallery row as "Rooms 91"), "Room 118; The Wolfson Gallery" (semicolon),
 * "Room 5 (La Tournerie)" (parenthetical). Non-room locations ("Stair D",
 * "Cromwell Road Entrance", "The Blavatnik Hall", exhibition titles) keep
 * the full label as their code — same fallback convention as SMK/AIC.
 */
const roomCode = (displayName: string): string => {
  const m = displayName.match(/\bRooms?\s+(\d+[A-Za-z]?)\b/i);
  return (m ? m[1] : displayName).trim();
};

interface LocationDetail {
  free?: string;
  case?: string;
  shelf?: string;
  box?: string;
}

/** Sub-room detail free text — case/shelf/box within a room's display cases. */
function locationNote(detail: LocationDetail | undefined): string {
  if (!detail) return "";
  const parts: string[] = [];
  if (detail.case) parts.push(`Case ${detail.case}`);
  if (detail.shelf) parts.push(`Shelf ${detail.shelf}`);
  if (detail.box) parts.push(`Box ${detail.box}`);
  if (detail.free) parts.push(detail.free);
  return parts.join(", ");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** null when the record isn't a placeable on-view V&A South Kensington row. */
function toRow(a: any, galleryLabels: Map<string, GalleryLabelRow>): ObjectRow | null {
  const loc = a._currentLocation ?? {};
  if (loc.site !== "VA" || !loc.onDisplay) return null; // defensive; on_display_at=southken already guarantees this
  const displayName = String(loc.displayName ?? "").trim();
  if (!displayName) return null; // location is the product
  // Measured: a handful of records carry onDisplay=true with an "In store"
  // location (upstream data glitch) — not a visitable room, drop them.
  if (/^in stor/i.test(displayName)) return null;
  const code = roomCode(displayName);
  if (!galleryLabels.has(code)) {
    galleryLabels.set(code, { galleryNumber: code, site: SITE, title: displayName });
  }

  const objectType = String(a.objectType ?? "").trim();
  const title = String(a._primaryTitle ?? "").trim() || objectType;

  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: a.systemNumber,
    accession: a.accessionNumber ?? "",
    title,
    artist: a._primaryMaker?.name ?? "",
    culture: a._primaryPlace ?? "",
    period: a._primaryDate ?? "",
    classification: objectType,
    medium: "", // materialsAndTechniques is not present at the search tier (verified)
    tags: "",
    galleryNumber: code,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal at this tier
    imageUrl: "", // V&A images are not redistributable — never populated
    metadataDate: "", // no modification timestamp at the search tier
    locationNote: locationNote(loc.detail),
    license: LICENSE,
    imageLicense: "",
  };
}

interface FacetTerm {
  id: string;
  count: number;
}

/** Query-string builder that supports repeated keys (needed for negation: N x `id_gallery=-X`). */
function qs(pairs: Array<[string, string]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of pairs) p.append(k, v);
  return p.toString();
}

const positive = (param: string, value: string): [string, string] => [param, value];
const negative = (param: string, value: string): [string, string] => [param, `-${value}`];

class Pacer {
  private nextAt = 0;
  /** Blocks until >=MIN_INTERVAL_MS has passed since the previous call started. */
  async wait(): Promise<void> {
    const now = Date.now();
    const delay = this.nextAt - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.nextAt = Math.max(now, this.nextAt) + MIN_INTERVAL_MS;
  }
}

interface FetchStats {
  requests: number;
  rows: number;
}

/**
 * Paginate one filter set (page 1..100) until a short page signals the end
 * (or `shouldStop()` says the caller has enough — the `--limit` spike/test
 * knob). A full page 100 means the true count exceeds CAP — the caller must
 * split further (we never silently truncate).
 */
async function paginate(
  client: ReturnType<typeof createPoliteClient>,
  pacer: Pacer,
  extra: Array<[string, string]>,
  sink: (rec: any) => void,
  stats: FetchStats,
  shouldStop: () => boolean,
): Promise<{ hitCap: boolean }> {
  for (let page = 1; page <= CAP / PAGE_SIZE; page++) {
    if (shouldStop()) return { hitCap: false };
    await pacer.wait();
    const url = `${API}?${qs([["page_size", String(PAGE_SIZE)], ["page", String(page)], ["on_display_at", "southken"], ...extra])}`;
    const res = await client.fetchJson(url);
    stats.requests++;
    const records: any[] = res.records ?? [];
    for (const r of records) sink(r);
    stats.rows += records.length;
    if (records.length < PAGE_SIZE) return { hitCap: false };
  }
  return { hitCap: true };
}

/** clusters/{field}/search: gallery is nested one level under a site node; every other field is flat. */
async function clusterTerms(
  client: ReturnType<typeof createPoliteClient>,
  pacer: Pacer,
  field: "gallery" | "object_type",
  extra: Array<[string, string]>,
  stats: FetchStats,
): Promise<FacetTerm[]> {
  await pacer.wait();
  const url = `${CLUSTER_API}/${field}/search?${qs([["cluster_size", "100"], ["on_display_at", "southken"], ...extra])}`;
  const res = await client.fetchJson(url);
  stats.requests++;
  const terms = field === "gallery" ? (res[0]?.childTerms ?? []) : res;
  return (terms as any[]).map((t) => ({ id: t.id, count: t.count as number }));
}

/** Sub-partition an oversized gallery by object_type; throws if even that isn't enough. */
async function fetchOversizedGallery(
  client: ReturnType<typeof createPoliteClient>,
  pacer: Pacer,
  galleryId: string,
  sink: (rec: any) => void,
  stats: FetchStats,
  shouldStop: () => boolean,
): Promise<void> {
  if (shouldStop()) return;
  const galleryFilter: Array<[string, string]> = [positive("id_gallery", galleryId)];
  const types = await clusterTerms(client, pacer, "object_type", galleryFilter, stats);
  const used: string[] = [];
  for (const t of types) {
    if (shouldStop()) return;
    if (t.count === 0) continue;
    const { hitCap } = await paginate(
      client,
      pacer,
      [...galleryFilter, positive("kw_object_type", t.id)],
      sink,
      stats,
      shouldStop,
    );
    if (hitCap) {
      throw new Error(
        `vanda: gallery ${galleryId} object_type ${t.id} still exceeds the ${CAP}-row window — needs a third partition level`,
      );
    }
    used.push(t.id);
  }
  if (shouldStop()) return;
  const remainderFilter: Array<[string, string]> = [
    ...galleryFilter,
    ...used.map((id) => negative("kw_object_type", id)),
  ];
  const { hitCap } = await paginate(client, pacer, remainderFilter, sink, stats, shouldStop);
  if (hitCap) {
    throw new Error(
      `vanda: gallery ${galleryId} object_type remainder still exceeds the ${CAP}-row window — needs a third partition level`,
    );
  }
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const client = createPoliteClient({ reqsPerSec: 1, concurrency: 1, maxAttempts: 8, label: "vanda" });
  const pacer = new Pacer(); // manual <=1 req/s pacing (this adapter issues sequential, not pooled, requests)
  const stats: FetchStats = { requests: 0, rows: 0 };
  const t0 = Date.now();

  const rows: ObjectRow[] = [];
  const galleryLabels = new Map<string, GalleryLabelRow>();
  const seen = new Set<string>();
  const shouldStop = () => rows.length >= limit;
  const sink = (rec: any) => {
    if (shouldStop()) return;
    const row = toRow(rec, galleryLabels);
    if (!row) return;
    if (seen.has(row.sourceId!)) return;
    seen.add(row.sourceId!);
    rows.push(row);
  };

  const galleries = await clusterTerms(client, pacer, "gallery", [], stats);
  console.log(`vanda: ${galleries.length} galleries listed (top cluster page)`);

  const usedGalleries: string[] = [];
  let oversizedCount = 0;
  for (const g of galleries) {
    if (shouldStop()) break;
    if (g.count === 0) continue;
    const galleryFilter: Array<[string, string]> = [positive("id_gallery", g.id)];
    const { hitCap } = await paginate(client, pacer, galleryFilter, sink, stats, shouldStop);
    if (hitCap) {
      oversizedCount++;
      await fetchOversizedGallery(client, pacer, g.id, sink, stats, shouldStop);
    }
    usedGalleries.push(g.id);
    if (usedGalleries.length % 25 === 0) {
      console.log(`vanda: ${usedGalleries.length}/${galleries.length} galleries, ${rows.length} rows so far`);
    }
  }

  // Long-tail galleries beyond the top-100 cluster page.
  const tailFilter = usedGalleries.map((id) => negative("id_gallery", id));
  const { hitCap: tailHitCap } = await paginate(client, pacer, tailFilter, sink, stats, shouldStop);
  if (tailHitCap) {
    throw new Error(
      `vanda: long-tail (beyond top ${galleries.length} galleries) remainder still exceeds the ${CAP}-row window — the gallery cluster page needs raising or a second cluster page`,
    );
  }

  const finalRows = [...rows].sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));

  const meta = {
    fetchedAt: new Date().toISOString(),
    rows: finalRows.length,
    galleriesListed: galleries.length,
    oversizedGalleriesSplit: oversizedCount,
    distinctGalleryNumbers: galleryLabels.size,
    requests: stats.requests,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("vanda meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const vandaSource: MuseumSource = {
  id: "vanda",
  fullFetch,
  // Terms cap cached content at 4 weeks and the whole on-view set is cheap
  // at <=1 req/s (~15 min, well under the 3,000 calls/day budget) — delta IS
  // a full re-pull, same convention as every other non-Met source.
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
