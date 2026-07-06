/**
 * Museo Egizio (Turin) source adapter (D12) — the fleet's first
 * sitemap-enumerated HTML adapter: no REST API exists, but robots.txt
 * publishes sitemap.xml (verified 2026-07-06: only /xml/, /js/, /libs/ and
 * /Error.aspx are disallowed — /material/ pages are expressly crawlable) and
 * every object page is server-rendered ASP.NET with a stable label/value
 * markup (<label>Field:</label> … <span class="value">…</span>), verified
 * identical across 40 random cached pages + live re-probes of Cat_1410/S_26
 * on 2026-07-06. No WAF observed (all 200s with the research UA).
 *
 * Enumeration: https://collezioni.museoegizio.it/sitemap.xml (5.1 MB).
 * MEASURED CORRECTION to the survey report's "10,966 object pages": the
 * sitemap carries 10,966 en-GB/material <loc> entries but every URL appears
 * EXACTLY twice (the it-IT twin's <url> entry repeats the en-GB loc; both
 * carry the same hreflang alternates) — the true catalog is 5,483 unique
 * objects (full crawl ≈ 1.6 h at 1 req/s, not 3 h), and 65% on-view of
 * 5,483 ≈ 3,560 reconciles with the museum's public "~3,300 exhibited"
 * figure that the report flagged as unexplained. The en-GB pages are NATIVE
 * ENGLISH, so unlike Louvre/Rijksmuseum there is no translateFrom. The URL
 * slug (e.g. "Cat_1410") is the sourceId — it is exactly what
 * objectUrlTemplate needs; the page's "Inv. no." display form ("Cat. 1410")
 * becomes accession. The sitemap carries NO <lastmod> (measured: 0 across
 * all <url> entries) — see delta() for what that honestly limits.
 *
 * On-view signal (measured n=40: 26 on display / 14 off): the "Museum
 * location:" field is present on every page; exactly "Not on display" =
 * off-view (skipped); otherwise a " / "-separated path:
 *   "Museum / Floor 2 / Room 04 / Showcase 01"
 *   "Museum / Ground floor / Room 14"                      (no sub-room part)
 *   "Museum / Floor -1 / Room 01 / Showcase 03"
 *   "Museum / Floor 1 / Room 11 RET / Cabinet 49 Mummies / Shelf 03"
 *   "Museum / Floor 2A / Mezzanine / Cabinet 12 Wooden Sculpture / Shelf 03"
 *   "Museum / Floor 1 / Room 07 / Showcase 10 / cassetto 01"     (drawer)
 *   "Museum / Floor 2 / Room 04 / Wall" (also "Frame", "Base")
 * Segment 2 is the floor ("Floor 2" → "2", "Ground floor" → "G", "Floor -1"
 * → "-1", "Floor 2A" → "2A"; the smoke harvest also surfaced "Floor 3" —
 * floorOrder ["-1","G","1","2","2A","3"]); segment 3 is the room ("Room 04"
 * → "04", suffixed rooms like "Room 11 RET" keep the suffix — RET/DEM/IeN
 * are the museum's own room designations and merging "Room 11" with
 * "Room 11 RET" would be a guess; NAMED areas with no Room prefix are kept
 * verbatim: "Mezzanine" (2A), "Writing Gallery" (3), "Roman Wall Storage"
 * (-1, the museum's visitable open-storage display — its location path
 * still starts "Museum /", unlike a true depot which is "Not on display").
 * galleryNumber = "{floor}-{room}" ("2-04", "G-14", "1-11 RET",
 * "2A-Mezzanine") — floor-qualified because bare room numbers repeat across
 * floors. Everything after the room (showcase/cabinet/shelf/wall/frame/
 * base/drawer) joins into locationNote, the V&A/Rijksmuseum sub-room
 * convention. Gallery title = the original floor+room path ("Floor 2 /
 * Room 04") so label-only UI stays self-describing.
 *
 * Fields (label census across the 40-page sample: Inv. no./Period/
 * Provenance/Acquisition/location 40, Material 39, Date 37, Dynasty 9,
 * Reign 4, CGT 1): Material → medium ("Stone / Granite"); Period → period
 * ("Roman Period"), Date ("30 BCE – 395 CE") as fallback; Provenance →
 * culture — it is a find-place ("Egypt, Luxor / Thebes, Deir el-Medina,
 * Tomb of Kha (TT8)"), the same place-of-origin semantics Rijksmuseum maps
 * to culture; the literal "Unknown" (14/40) is dropped to "". Dynasty +
 * Reign → tags. NO object-type field exists on the pages (the lone "CGT:"
 * is a Turin papyrus-corpus number, an identifier) → classification stays
 * "" — same documented-gap convention as V&A's missing medium. artist stays
 * "" (ancient artifacts, no maker field). metadataDate stays "" (no
 * modified date anywhere: not in the sitemap, not on the page).
 *
 * Images: the site's own description (every page, verbatim) — "The images
 * are freely downloadable and reusable under a Creative Commons CC0 Public
 * Domain licence." og:image carries the primary derivative
 * (/public/objects/images/…_big.jpg, absolute-ized here); pages without
 * photography ship og:image="" (4/40 measured) → imageUrl/imageLicense both
 * "". The metadata TEXT license is NOT separately stated anywhere on the
 * site — registry license.text is the conservative marker "egizio-unstated"
 * and we ship short factual fields only (titles are the museum's own,
 * sometimes upstream-truncated — e.g. Cat. 2289's h1 ends mid-word; taken
 * as-is).
 *
 * Etiquette: ≤1 req/s sequential (site's scale makes concurrency pointless:
 * ~10,966 pages ≈ 3 h one-time), shared politeFetch client (cookie reuse,
 * 403 ≥60 s wait, backoff). Resumable via data/raw/egizio/
 * objects-cache.ndjson (gitignored, re-fetchable) — one line per slug, so a
 * crash/WAF interruption resumes where it left off; a --limit N smoke run
 * stops after N ON-VIEW rows and a later unlimited run continues past it.
 * Markup-drift guard: among the first 50 freshly-fetched pages, >10%
 * missing the "Museum location:" field throws instead of shipping a
 * silently-empty snapshot.
 *
 * delta() limitation (honest): with no lastmod and no API, a sitemap
 * re-crawl can only diff the URL SET — new slugs are hydrated, vanished
 * slugs are tombstoned, but an EXISTING page whose location changed (moved
 * room / rotated off view) is invisible to delta. Location churn is only
 * picked up by a periodic full re-crawl (delete the ndjson cache, rerun
 * fullFetch) — acceptable for a museum whose permanent galleries move
 * slowly, and the same honesty bar as V&A's "delta = full re-pull" note.
 */
import { gzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const BASE = "https://collezioni.museoegizio.it";
const SITEMAP = `${BASE}/sitemap.xml`;
const UA = "MuseWalk-research/0.1 (kuitang@gmail.com)";
const SITE = "egizio";
const REQS_PER_SEC = 1; // hard etiquette rule for museoegizio.it
const MATERIAL_URL_RE = /^https:\/\/collezioni\.museoegizio\.it\/en-GB\/material\/([^/?#]+)\/?$/;

const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_DIR = join(REPO_DATA, "raw", "egizio");
const CACHE_FILE = join(RAW_DIR, "objects-cache.ndjson");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client() {
  return createPoliteClient({
    reqsPerSec: REQS_PER_SEC,
    concurrency: 1, // sequential — see the etiquette note in the header
    maxAttempts: 8,
    userAgent: UA,
    label: "egizio",
  });
}

/** The handful of entities these server-rendered pages actually emit (typographic quotes arrive as raw UTF-8, not entities). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const clean = (s: string): string => decodeEntities(s).replace(/\s+/g, " ").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Label/value row extractor. Real markup (verified live 2026-07-06):
 *   <label for="" class="icon location">Museum location:</label> …
 *   <div class="col-lg-9"><span class="value">Museum / Floor 1 / …</span>
 * Labels vary in trailing colon spacing ("Inv. no. :" vs "Material:") and
 * Dimensions uses <div class="value"> — both shapes accepted.
 */
function fieldValue(html: string, label: string): string {
  const re = new RegExp(
    `<label[^>]*>\\s*${escapeRe(label)}\\s*:?\\s*</label>[\\s\\S]{0,200}?<(?:span|div) class="value">([\\s\\S]*?)</(?:span|div)>`,
  );
  const m = re.exec(html);
  return m ? clean(m[1]) : "";
}

export interface EgizioLocation {
  floor: string; // normalized: "-1" | "G" | "1" | "2" | "2A"
  room: string; // "04", "11 RET", "Mezzanine"
  galleryNumber: string; // "2-04", "G-14", "2A-Mezzanine"
  galleryTitle: string; // "Floor 2 / Room 04" — the original path, self-describing
  locationNote: string; // "Showcase 01", "Cabinet 49 Mummies / Shelf 03", "Wall", ""
}

/**
 * "Museum / Floor 2 / Room 04 / Showcase 01" → structured location.
 * Returns null for "Not on display" AND for any unparseable/roomless string
 * (callers count the two cases separately via isNotOnDisplay()).
 */
export function parseLocation(value: string): EgizioLocation | null {
  const segments = value.split(" / ").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 3 || segments[0] !== "Museum") return null;
  const floorSeg = segments[1];
  const floorM = /^Floor\s+(\S+)$/i.exec(floorSeg);
  const floor = floorM ? floorM[1] : /ground/i.test(floorSeg) ? "G" : floorSeg;
  const roomSeg = segments[2];
  const room = roomSeg.replace(/^Rooms?\s+/i, "").trim();
  if (!room) return null;
  return {
    floor,
    room,
    galleryNumber: `${floor}-${room}`,
    galleryTitle: `${floorSeg} / ${roomSeg}`,
    locationNote: segments.slice(3).join(" / "),
  };
}

const isNotOnDisplay = (value: string): boolean => /^not on display$/i.test(value);

interface ParsedPage {
  hasLocationField: boolean;
  notOnDisplay: boolean;
  row: ObjectRow | null;
  galleryTitle: string;
  galleryFloor: string;
}

export function parsePage(slug: string, html: string): ParsedPage {
  const locationValue = fieldValue(html, "Museum location");
  const none: ParsedPage = {
    hasLocationField: locationValue !== "",
    notOnDisplay: isNotOnDisplay(locationValue),
    row: null,
    galleryTitle: "",
    galleryFloor: "",
  };
  if (!locationValue || isNotOnDisplay(locationValue)) return none;
  const loc = parseLocation(locationValue);
  if (!loc) return none; // roomless/unparseable on-view string — counted by the caller

  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  const title = h1 ? clean(h1[1]) : "";
  const accession = fieldValue(html, "Inv. no.") || slug;
  const provenance = fieldValue(html, "Provenance");
  const og = /property="og:image" content="([^"]*)"/.exec(html);
  const imageUrl = og?.[1] ? new URL(og[1], BASE).href : "";
  const tags = [fieldValue(html, "Dynasty"), fieldValue(html, "Reign")].filter(Boolean).join("|");

  const row: ObjectRow = {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: slug,
    accession,
    title: title || accession,
    artist: "", // no maker field on these pages (ancient artifacts)
    culture: /^unknown$/i.test(provenance) ? "" : provenance,
    period: fieldValue(html, "Period") || fieldValue(html, "Date"),
    classification: "", // no object-type field exists (see header)
    medium: fieldValue(html, "Material"),
    tags,
    galleryNumber: loc.galleryNumber,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal on the site
    imageUrl,
    metadataDate: "", // no modified date anywhere (sitemap has no lastmod)
    locationNote: loc.locationNote,
    imageLicense: imageUrl ? "CC0-1.0" : "", // site-wide explicit CC0 image grant
  };
  return { hasLocationField: true, notOnDisplay: false, row, galleryTitle: loc.galleryTitle, galleryFloor: loc.floor };
}

/** Sitemap → ordered unique en-GB slugs. Throws on structural surprise (zero matches). */
export function parseSitemap(xml: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml))) {
    const u = MATERIAL_URL_RE.exec(m[1]);
    if (u && !seen.has(u[1])) {
      seen.add(u[1]);
      slugs.push(u[1]);
    }
  }
  if (!slugs.length) {
    throw new Error("egizio: sitemap.xml yielded zero en-GB/material URLs — sitemap shape may have changed");
  }
  return slugs;
}

interface CacheRec {
  sourceId: string;
  skip: boolean; // off-view / roomless
  notOnDisplay?: boolean;
  row?: ObjectRow;
  galleryTitle?: string;
  galleryFloor?: string;
}

function loadCache(): Map<string, CacheRec> {
  const known = new Map<string, CacheRec>();
  if (existsSync(CACHE_FILE)) {
    for (const line of readFileSync(CACHE_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec: CacheRec = JSON.parse(line);
      known.set(rec.sourceId, rec);
    }
  }
  return known;
}

/**
 * Hydrate `slugs` (sequential, paced), appending to the ndjson cache.
 * Stops early once the whole cache holds `limit` on-view rows.
 */
async function hydrate(
  slugs: string[],
  known: Map<string, CacheRec>,
  limit: number,
): Promise<{ fetched: number }> {
  mkdirSync(RAW_DIR, { recursive: true });
  const c = client();
  const todo = slugs.filter((s) => !known.has(s));
  let onView = [...known.values()].filter((r) => !r.skip).length;
  let fetched = 0;
  let freshChecked = 0;
  let freshMissingLocation = 0;
  // Pace request STARTS at 1/s (vanda's Pacer convention) — sleeping a full
  // interval BETWEEN requests would add fetch latency on top and underrun
  // the budget by ~2-3x (measured on the first smoke run: ~0.35 req/s).
  let nextStart = Date.now();

  for (const slug of todo) {
    if (onView >= limit) break;
    const wait = nextStart - Date.now();
    nextStart = Math.max(nextStart, Date.now()) + 1000 / REQS_PER_SEC;
    if (wait > 0) await sleep(wait);
    const html = await c.fetchText(`${BASE}/en-GB/material/${slug}`);
    fetched++;
    let rec: CacheRec;
    if (html === null) {
      rec = { sourceId: slug, skip: true }; // 404 — sitemap-listed but gone
    } else {
      const page = parsePage(slug, html);
      // Markup-drift guard over the first 50 freshly-fetched pages: the
      // location field was 40/40 in the sample — >10% missing means the
      // label/value markup moved and we must not ship a silently-empty set.
      if (freshChecked < 50) {
        freshChecked++;
        if (!page.hasLocationField) freshMissingLocation++;
        if (freshChecked === 50 && freshMissingLocation > 5) {
          throw new Error(
            `egizio: ${freshMissingLocation}/50 pages missing the "Museum location:" field — ` +
              "the label/value markup may have changed; aborting rather than shipping a degraded snapshot",
          );
        }
      }
      rec = page.row
        ? {
            sourceId: slug,
            skip: false,
            row: page.row,
            galleryTitle: page.galleryTitle,
            galleryFloor: page.galleryFloor,
          }
        : { sourceId: slug, skip: true, notOnDisplay: page.notOnDisplay };
    }
    appendFileSync(CACHE_FILE, JSON.stringify(rec) + "\n");
    known.set(slug, rec);
    if (!rec.skip) onView++;
    if (fetched % 200 === 0) {
      console.log(`egizio: ${fetched}/${todo.length} pages fetched this run, ${onView} on-view rows total`);
    }
  }
  return { fetched };
}

/** Assemble snapshot rows/galleries from the cache, scoped to the CURRENT sitemap slug set. */
function assemble(
  slugs: string[],
  known: Map<string, CacheRec>,
): { rows: ObjectRow[]; galleries: GalleryLabelRow[]; notOnDisplay: number; roomless: number } {
  const rows: ObjectRow[] = [];
  const galleries = new Map<string, GalleryLabelRow>();
  let notOnDisplay = 0;
  let roomless = 0;
  for (const slug of slugs) {
    const rec = known.get(slug);
    if (!rec) continue; // not hydrated yet (limit run)
    if (rec.skip || !rec.row) {
      if (rec.notOnDisplay) notOnDisplay++;
      else roomless++;
      continue;
    }
    rows.push(rec.row);
    if (!galleries.has(rec.row.galleryNumber)) {
      galleries.set(rec.row.galleryNumber, {
        galleryNumber: rec.row.galleryNumber,
        site: SITE,
        title: rec.galleryTitle || rec.row.galleryNumber,
        floor: rec.galleryFloor || undefined,
      });
    }
  }
  rows.sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));
  return { rows, galleries: [...galleries.values()], notOnDisplay, roomless };
}

function writeSnapshots(
  snapDir: string,
  rows: ObjectRow[],
  galleries: GalleryLabelRow[],
  meta: Record<string, unknown>,
): void {
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(rows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify(galleries, null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const t0 = Date.now();
  const c = client();

  const sitemapXml = await c.fetchText(SITEMAP);
  if (sitemapXml === null) throw new Error(`egizio: unexpected 404 for ${SITEMAP}`);
  const slugs = parseSitemap(sitemapXml);
  console.log(`egizio: sitemap lists ${slugs.length} en-GB object pages`);

  const known = loadCache();
  if (known.size) console.log(`egizio: resuming — ${known.size} pages already cached in ${CACHE_FILE}`);
  const { fetched } = await hydrate(slugs, known, limit);

  const { rows, galleries, notOnDisplay, roomless } = assemble(slugs, known);
  const meta = {
    fetchedAt: new Date().toISOString(),
    sitemapUrls: slugs.length,
    pagesFetchedThisRun: fetched,
    pagesCached: known.size,
    rows: rows.length,
    notOnDisplay,
    roomlessOnView: roomless,
    distinctGalleryNumbers: galleries.length,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    ...(limit < Infinity ? { partial: true, limit } : null),
  };
  writeSnapshots(snapDir, rows, galleries, meta);
  console.log("egizio meta:", JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Nightly incremental — URL-set diff ONLY (the sitemap has no lastmod; see
 * the header's delta() limitation note): hydrates slugs new to the cache,
 * tombstones rows whose slugs left the sitemap. Existing pages' location
 * changes are NOT visible here — refresh those with a periodic full
 * re-crawl (delete data/raw/egizio/objects-cache.ndjson, rerun fullFetch).
 */
async function delta(snapDir: string): Promise<number> {
  const c = client();
  const sitemapXml = await c.fetchText(SITEMAP);
  if (sitemapXml === null) throw new Error(`egizio: unexpected 404 for ${SITEMAP}`);
  const slugs = parseSitemap(sitemapXml);

  const known = loadCache();
  const newSlugs = slugs.filter((s) => !known.has(s));
  const removed = [...known.keys()].filter((s) => !slugs.includes(s)).length;
  console.log(`egizio delta: ${newSlugs.length} new slugs to hydrate, ${removed} slugs left the sitemap`);
  const { fetched } = await hydrate(slugs, known, Infinity);

  const { rows, galleries, notOnDisplay, roomless } = assemble(slugs, known);
  const meta = {
    fetchedAt: new Date().toISOString(),
    refreshedBy: "data/src/sources/egizio.ts#delta",
    sitemapUrls: slugs.length,
    newSlugsHydrated: fetched,
    slugsRemoved: removed,
    rows: rows.length,
    notOnDisplay,
    roomlessOnView: roomless,
    distinctGalleryNumbers: galleries.length,
  };
  writeSnapshots(snapDir, rows, galleries, meta);
  return fetched;
}

export const egizioSource: MuseumSource = {
  id: "egizio",
  fullFetch,
  delta: (snapDir) => delta(snapDir),
};
