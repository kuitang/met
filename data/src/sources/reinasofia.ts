/**
 * Museo Nacional Centro de Arte Reina Sofía (Madrid) source adapter (D15) —
 * the museum's public site is a Gatsby app; every page has a static JSON
 * twin at `{BASE}/page-data{path}/page-data.json` (keyless, no bot-block,
 * `robots.txt` only disallows `/busqueda` + `/eu/bilaketa` — the search UI —
 * every page-data route we use is `Allow: /`). There is no bulk on-view API
 * and no working sitemap (`sitemap.xml`/`sitemap-index.xml` both 404 to a
 * Gatsby "Página no encontrada" page, measured 2026-07-06) — enumeration is
 * a BFS crawl of the content graph instead (closest fleet precedent: the
 * Rijksmuseum's "fetch JSON per entity" shape, per the plan's sketch).
 *
 * Structure (measured live 2026-07-06, starting from `/en/collections`):
 *   - "showroom" nodes (rooms) carry `translations[]` (ES "Sala 404" / EN
 *     "Room 404"), `floor.entity[0].{title,showrooms[]}` (sibling rooms in
 *     the same floor/itinerary segment), and `artworks.data[]` — the full
 *     roster of works hung in that room (title/author/year stub + a
 *     self-referential `showroom` back-ref). Rooms discovered: 36 on
 *     Sabatini Floor 2 ("avant-garde-territories" itinerary, codes
 *     201.01-208.05, incl. Room 205.10 = the Guernica room) + 21 on Floor 4
 *     ("collection-contemporary-art-1975-present", 3 itinerary segments x 7
 *     rooms, codes 401-421) + 1 stand-alone room under a different URL
 *     prefix (`/en/sala/nouvel-building-rooftop-terrace`, no numeric code —
 *     the museum's OWN "Collections" hub links exactly these 3 destinations;
 *     other floors/buildings are not on view during the 2024-2028 rehang, per
 *     the hub page's own text). 58 rooms total, 100% on-view by construction
 *     (every artwork we ship is a member of a crawled room's own roster).
 *   - "artwork" nodes (works) self-declare their OWN room via a `showroom`
 *     field wherever they appear (a room's own roster, a hub page's
 *     highlighted-works list, …) — but only the artwork's OWN page-data
 *     (`/en/collections/artwork/{slug}`) carries the full field set this
 *     adapter ships: `technique`, `webDate`/`year` (display date; `entryYear`
 *     is the ACCESSION year, deliberately not used as the artwork date),
 *     `registryID` (accession number), `artworkStatus` ("exposed" = on
 *     view — the authoritative on-view gate), and `translations[]` (BOTH
 *     the ES and EN title, embedded regardless of which language URL was
 *     fetched — the EN page's `translations` array already contains the ES
 *     entry, so a single fetch yields both without a second request). Room
 *     rosters only carry a lighter stub (no technique/registryID/status),
 *     so per-artwork hydration is required for the shipped fields (~1.5-3k
 *     objects estimated from the measured per-room counts — Room 4 alone had
 *     127 — a "large" on-view set per the milestone's own threshold), done
 *     resumably via `data/raw/reinasofia/objects-cache.ndjson` (gitignored,
 *     same convention as Louvre/Met's per-object hydration).
 *
 * BFS mechanics (`loadStructure`): a single recursive walk over each fetched
 * page's JSON collects, generically (no per-paragraph-type special-casing):
 *   (a) any embedded `{bundle:"showroom", url.path, translations}` node —
 *       parses a room's gallery code + floor from its ES translation
 *       ("Sala 205.10" -> code "205.10", floor = code's leading digit; a
 *       non-"Sala N" title, i.e. only the Nouvel terrace, falls back to its
 *       URL slug as the code and floor "Roof" — same non-guessing,
 *       URL-slug-fallback convention as Louvre's non-"Salle N" rooms);
 *   (b) any embedded `{bundle:"artwork", url.path}` node — records the slug
 *       for hydration (dedup'd across every room/hub page it appears on);
 *   (c) any `url.path` matching `/en/(collections|sala)/{single-segment}` —
 *       a candidate further page to crawl (itinerary hub pages, informational
 *       pages harmlessly re-crawled with no new rooms/artworks to add).
 * Seeded from just `/en/collections` — the itinerary hub pages it links to
 * embed their FULL room grid inline (measured: the "avant-garde-territories"
 * itinerary page alone lists all 36 Floor-2 rooms), so no itinerary slug is
 * hardcoded; new itineraries the museum adds as the 2024-2028 rehang
 * progresses are picked up automatically. ~70 requests total for the BFS
 * (rooms + a dozen harmless informational pages), well under a minute at
 * the mandated <=1 req/s.
 *
 * Fields shipped are FACTS ONLY (title, artist, date/period, medium/room) —
 * no descriptions, no images. Museum legal notice (fetched 2026-07-06,
 * `/en/legal-notice`): "texts and audiovisuals whose author, editor or
 * producer is Museo Reina Sofía" are under **CC BY-NC-ND 4.0**
 * (creativecommons.org/licenses/by-nc-nd/4.0/) — the ND clause is exactly
 * why no prose (room/artwork descriptions) is ingested here, only short
 * factual identifiers; images are explicitly NOT covered by this grant
 * ("the intellectual property of the reproduced artworks belong to their
 * authors and heirs... a license should be required") — imageUrl/
 * imageLicense stay "" for every row, same treatment as V&A/Harvard/NGA.
 * Unlike V&A/Harvard's API terms, CC BY-NC-ND 4.0 is a perpetual public
 * license with no stated caching-duration cap, so no `license.ttlDays` is
 * set (confirmed via `museums-audit.ts:ttlMetaViolations` — `license.text`
 * "cc-by-nc-nd-4.0" has no "-ttlNN" suffix, so the check doesn't fire).
 *
 * translateFrom: "es" — `title` ships in Spanish (the museum's authoring
 * language and this adapter's primary `translations[]` source); `titleAlt`
 * is pre-seeded from the SAME payload's native English `translations[]`
 * entry (free, no LLM call) as a safety-net default, then overwritten by
 * `translate.ts --museum reinasofia` (DeepSeek V4 Flash) for consistency
 * with every other translateFrom museum's pipeline — see that file's
 * `LANGUAGE_NAMES.es` (added ahead of this PR by #46).
 *
 * Delta = full re-pull, same convention as vanda/harvard/rijksmuseum: the
 * BFS re-crawl is cheap every run (~70 requests) and the per-artwork
 * resumable cache means only NEWLY discovered slugs actually get
 * hydrated on a rerun — full re-invocation is already a de-facto delta
 * (same remark Louvre's fullFetch makes about itself).
 */
import { gzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const BASE = "https://www.museoreinasofia.es";
const UA = "MuseWalk-research/0.1 (kuitang42@gmail.com)";
const SITE = "reinasofia";
const LICENSE = "cc-by-nc-nd-4.0";

const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESUME_FILE = join(REPO_DATA, "raw", "reinasofia", "objects-cache.ndjson");

/* eslint-disable @typescript-eslint/no-explicit-any */

function pageDataUrl(path: string): string {
  return `${BASE}/page-data${path}/page-data.json`;
}

function contentOf(json: any): any {
  return json?.result?.pageContext?.node?.data?.content ?? null;
}

/** Strips HTML tags + decodes the handful of entities this CMS's rich-text fields use. */
function stripHtml(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface RoomMeta {
  path: string;
  code: string;
  floor: string;
  label: string; // ES "Sala NNN" (or the URL slug fallback) — galleries.json title
}

function findLang(translations: any[] | undefined, lang: string): string {
  const t = (translations ?? []).find((x: any) => x?.language?.id === lang);
  return stripHtml(t?.title);
}

/**
 * "Sala 404" -> code "404" (floor "4"); "Sala 205.10" -> "205.10" (floor
 * "2"); "Sala 205.03.bis" -> "205.03.bis" (floor "2"). Rooms with no
 * "Sala N" title (measured: only the Nouvel Building Rooftop Terrace) fall
 * back to their URL slug as the code, floor "Roof" — same non-guessing,
 * slug-fallback convention as Louvre's non-"Salle N" rooms.
 */
function parseRoom(node: any): RoomMeta {
  const path = String(node.url?.path ?? "");
  const esTitle = findLang(node.translations, "es");
  const enTitle = findLang(node.translations, "en");
  const m = esTitle.match(/^Sala\s+(\d+(?:\.\d+)*(?:\.bis)?)/i);
  if (m) {
    const code = m[1];
    return { path, code, floor: code.charAt(0), label: esTitle };
  }
  const slug = path.split("/").filter(Boolean).pop() ?? path;
  return { path, code: slug, floor: "Roof", label: esTitle || enTitle || slug };
}

interface WalkCtx {
  candidatePaths: Set<string>;
  showrooms: any[];
  artworks: any[];
}

const CANDIDATE_PATH_RE = /^\/en\/(?:collections|sala)\/[a-z0-9-]+$/;

/**
 * One recursive pass over a fetched page's JSON, generic across every
 * Gatsby paragraph/entity shape this site uses (no per-type special-casing
 * — see file header). Collects every embedded showroom/artwork node plus
 * any `url.path` that looks like a further collections/sala page to crawl.
 */
function walkNode(node: any, ctx: WalkCtx): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkNode(item, ctx);
    return;
  }
  const p = node.url?.path;
  if (typeof p === "string" && CANDIDATE_PATH_RE.test(p)) ctx.candidatePaths.add(p);
  if (node.bundle === "showroom") ctx.showrooms.push(node);
  else if (node.bundle === "artwork") ctx.artworks.push(node);
  for (const v of Object.values(node)) walkNode(v, ctx);
}

class Pacer {
  private nextAt = 0;
  async wait(): Promise<void> {
    const now = Date.now();
    const delay = this.nextAt - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.nextAt = Math.max(now, this.nextAt) + 1000; // <=1 req/s
  }
}

interface StructureResult {
  rooms: Map<string, RoomMeta>; // keyed by room path
  artworkSlugs: Set<string>;
  requests: number;
}

/**
 * BFS the content graph from `/en/collections`. Seeds nothing else —
 * itinerary hub pages embed their full room grid inline (measured), so
 * candidate pages are discovered generically (see CANDIDATE_PATH_RE) rather
 * than hardcoding itinerary slugs.
 */
async function loadStructure(
  c: ReturnType<typeof createPoliteClient>,
  pacer: Pacer,
): Promise<StructureResult> {
  const visited = new Set<string>();
  const queued = new Set<string>(["/en/collections"]);
  const queue: string[] = ["/en/collections"];
  const rooms = new Map<string, RoomMeta>();
  const artworkSlugs = new Set<string>();
  let requests = 0;

  while (queue.length) {
    const p = queue.shift()!;
    if (visited.has(p)) continue;
    visited.add(p);
    await pacer.wait();
    const json = await c.fetchJson(pageDataUrl(p));
    requests++;
    const content = contentOf(json);
    if (!content) continue;

    const ctx: WalkCtx = { candidatePaths: new Set(), showrooms: [], artworks: [] };
    walkNode(content, ctx);

    for (const sr of ctx.showrooms) {
      const rp = sr.url?.path;
      if (rp && !rooms.has(rp)) rooms.set(rp, parseRoom(sr));
    }
    for (const aw of ctx.artworks) {
      const ap = aw.url?.path;
      if (typeof ap === "string") artworkSlugs.add(ap.split("/").filter(Boolean).pop()!);
    }
    for (const cp of ctx.candidatePaths) {
      if (!visited.has(cp) && !queued.has(cp)) {
        queued.add(cp);
        queue.push(cp);
      }
    }
  }
  return { rooms, artworkSlugs, requests };
}

interface ArtworkParseResult {
  row?: ObjectRow;
  skip?: "not-exposed" | "no-room";
}

/** Full per-artwork page-data content -> an ObjectRow, or a skip reason. */
function parseArtwork(content: any, slug: string, rooms: Map<string, RoomMeta>): ArtworkParseResult {
  if (content.artworkStatus !== "exposed") return { skip: "not-exposed" };
  const showroomEntity = content.showroom?.entity;
  if (!showroomEntity?.url?.path) return { skip: "no-room" };
  const room = parseRoom(showroomEntity);
  if (!rooms.has(room.path)) rooms.set(room.path, room); // belt-and-suspenders: guarantee a galleries.json row for every used room

  const title = findLang(content.translations, "es") || stripHtml(content.title?.value);
  const enTitle = findLang(content.translations, "en");
  const authors: string[] = Array.isArray(content.author)
    ? content.author.map((a: any) => stripHtml(a?.entity?.name?.value)).filter(Boolean)
    : [];
  const period = stripHtml(content.webDate?.value) || (content.year != null ? String(content.year) : "");

  const row: ObjectRow = {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: slug,
    accession: content.registryID ?? "",
    title,
    artist: authors.join("; "),
    culture: "",
    period,
    classification: "",
    medium: stripHtml(content.technique?.value),
    tags: "",
    galleryNumber: room.code,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal at this tier
    imageUrl: "", // no image-derivative grant (legal notice: images excluded from the CC BY-NC-ND text/AV grant)
    metadataDate: "",
    titleAlt: enTitle && enTitle !== title ? enTitle : "", // free native default; translate.ts overwrites with DeepSeek
    license: LICENSE,
    imageLicense: "",
  };
  return { row };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = createPoliteClient({ reqsPerSec: 1, concurrency: 1, maxAttempts: 8, userAgent: UA, label: "reinasofia" });
  const pacer = new Pacer();
  const t0 = Date.now();

  const { rooms, artworkSlugs, requests: structRequests } = await loadStructure(c, pacer);
  console.log(
    `reinasofia: ${rooms.size} rooms, ${artworkSlugs.size} artworks discovered (${structRequests} structure requests)`,
  );

  let slugs = [...artworkSlugs];
  if (limit < slugs.length) slugs = slugs.slice(0, limit);
  const slugsSet = new Set(slugs);

  mkdirSync(dirname(RESUME_FILE), { recursive: true });
  const rowsMap = new Map<string, ObjectRow>();
  let notExposed = 0;
  let noRoom = 0;
  let notFound = 0;

  const seen = new Set<string>();
  if (existsSync(RESUME_FILE)) {
    for (const line of readFileSync(RESUME_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (seen.has(rec.sourceId)) continue;
      seen.add(rec.sourceId);
      if (rec.row) rowsMap.set(rec.sourceId, rec.row);
      else if (rec.skip === "not-found") notFound++;
      else if (rec.skip === "not-exposed") notExposed++;
      else if (rec.skip === "no-room") noRoom++;
    }
    console.log(`resume: ${seen.size} already processed in ${RESUME_FILE}`);
  }
  const todo = slugs.filter((s) => !seen.has(s));

  await c.pooledMap(
    todo,
    async (slug) => {
      const json = await c.fetchJson(pageDataUrl(`/en/collections/artwork/${slug}`));
      const content = contentOf(json);
      let rec: { sourceId: string; row?: ObjectRow; skip?: string };
      if (!content) {
        notFound++;
        rec = { sourceId: slug, skip: "not-found" };
      } else {
        const parsed = parseArtwork(content, slug, rooms);
        if (parsed.row) {
          rowsMap.set(slug, parsed.row);
          rec = { sourceId: slug, row: parsed.row };
        } else {
          if (parsed.skip === "not-exposed") notExposed++;
          else noRoom++;
          rec = { sourceId: slug, skip: parsed.skip };
        }
      }
      appendFileSync(RESUME_FILE, JSON.stringify(rec) + "\n");
    },
    200,
  );

  // Restrict to slugs actually requested this run (tombstones removed/off-view
  // artworks even though their cache entries persist) — same convention as
  // louvre.ts's finalRows filter.
  const finalRows = [...rowsMap.values()]
    .filter((r) => slugsSet.has(r.sourceId!))
    .sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));

  const galleryLabels = new Map<string, GalleryLabelRow>();
  for (const r of rooms.values()) {
    if (!galleryLabels.has(r.code)) {
      galleryLabels.set(r.code, { galleryNumber: r.code, site: SITE, title: r.label, floor: r.floor });
    }
  }

  const meta = {
    fetchedAt: new Date().toISOString(),
    roomsDiscovered: rooms.size,
    artworksDiscovered: artworkSlugs.size,
    hydrated: slugs.length,
    rows: finalRows.length,
    skipped: { notFound, notExposed, noRoom },
    distinctGalleryNumbers: galleryLabels.size,
    structureRequests: structRequests,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    ...(limit < Infinity ? { partial: true, limit } : null),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("reinasofia meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const reinasofiaSource: MuseumSource = {
  id: "reinasofia",
  fullFetch,
  // The BFS re-crawl is cheap every run and the resumable per-artwork cache
  // means a rerun only hydrates newly-discovered slugs — fullFetch is
  // already a de-facto delta (same remark louvre.ts makes about itself).
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
