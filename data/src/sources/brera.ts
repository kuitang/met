/**
 * Pinacoteca di Brera (Milan) source adapter (D13) — the smallest adapter in
 * the fleet: a keyless WordPress REST API with no bulk on-view boolean, only
 * custom taxonomies to reconstruct display state and room from.
 *
 * Source: `https://pinacotecabrera.org/wp-json/wp/v2/opera?per_page=100&page=N`
 * (measured 2026-07-06: X-WP-Total 637, 7 pages). Each `opera` record carries
 * five custom taxonomies as id arrays — `opere-autore` (artist), `opere-genere`
 * (genre/administrative category), `opere-periodo` (period), `opere-sala`
 * (room), `opere-tecnica` (technique/medium) — resolved to names via
 * `wp-json/wp/v2/{taxonomy}?per_page=100` term-list lookups (opere-autore
 * alone needs 4 pages for its 364 terms; the other four fit on one page
 * each: opere-sala 40, opere-genere 19, opere-periodo 24, opere-tecnica 27).
 * Full harvest = 7 opera pages + 7 taxonomy-term pages = 14 requests (the
 * plan's ~12-request estimate undercounted opere-autore's page count).
 *
 * On-view signal: `class_list` carries the taxonomy-term slugs verbatim, and
 * `opere-genere-non-esposte` ("not exhibited") is the one that matters — a
 * record without it is exhibited. Measured full census (637 records): 393
 * exhibited (244 not exhibited); of the exhibited, 359 (91.3%) carry an
 * `opere-sala` room id — the other 34 are unplaced (mostly drawings/studies
 * with no room tag at all) and are skipped, same "location is the product"
 * convention as AIC/Harvard/SMK. 36 of the 244 non-exhibited records ALSO
 * carry a room id (deposits with a stale display-history room) — the
 * `non-esposte` filter already excludes these before the room check runs, so
 * they never need special-casing.
 *
 * Off-site rooms: the `opere-sala` vocabulary's 40 terms include 3 entries
 * (ids 126/127/128) that are not physical rooms in the Milan palazzo at all —
 * they are dated sub-tags for a single off-site deposit church, "Paderno
 * Dugnano (MI), Chiesa di Santa Maria Nascente" (a work on loan there is
 * still tagged with the museum's room taxonomy for provenance tracking, not
 * display location). Only id 127 is ever referenced by an exhibited+roomed
 * record (4 hits, measured) — those 4 are excluded from on-view via
 * OFFSITE_ROOM_IDS, the same "location is the product" principle applied to
 * a location that isn't actually inside the museum.
 *
 * galleryNumber = the museum's own roman-numeral room name (I..XXXVIII, plus
 * "Cortile" and "Ingresso" — kept as-is, not converted to arabic, because
 * that IS the museum's wayfinding scheme printed on its own floor plan).
 * Single floor (floorOrder ["1"]) — Palazzo Brera's picture galleries occupy
 * one piano nobile.
 *
 * Field mapping: title <- title.rendered (WP wptexturize-encodes curly
 * quotes/dashes as numeric entities — decodeWpEntities() below undoes the 4
 * entities measured live: &#8211; &#8217; &#8220; &#8221| — plus the
 * standard named ones for the taxonomy term names, which only ever showed
 * &amp;). artist <- opere-autore term name(s) (always 0-1 per exhibited
 * record, measured). period <- opere-periodo term name. medium <-
 * opere-tecnica term name. classification <- opere-genere term name(s),
 * EXCLUDING the two administrative status ids (25 "Opere esposte", 27
 * "Opere non esposte" — these just restate the on-view filter already
 * applied above and would otherwise show up as a near-universal, useless
 * "classification" value on 352/356 on-view rows); the remaining genere
 * values (department/exhibition tags like "Donazioni / Acquisizioni",
 * "Mostra Pinacoteca viaggiante", "Ritratti", ...) are kept when present, so
 * classification is sparse but meaningful rather than dense and useless. No
 * accession/inventory-number field exists anywhere in this API's response
 * shape (verified: the `opera` post type exposes no such field, and `acf` is
 * empty on every one of the 637 records) — accession stays "".
 *
 * sourceId = the WP numeric post id (NOT the slug): slugs get an appended
 * "-2"/"-10" suffix whenever two works share a base title (measured many
 * examples, e.g. "adorazione-dei-magi-10") and can be reminted if an editor
 * renames the title later, whereas the numeric id is WordPress's own stable
 * primary key. objectUrlTemplate uses the WP shortlink form
 * `?post_type=opera&p={sourceId}`, which every `opera` record's own `guid`
 * field already carries and which 301-redirects to the canonical slugged
 * page (verified live 2026-07-06) — this works precisely because sourceId is
 * the numeric id, not the slug.
 *
 * License: no explicit reuse statement found anywhere on the site (the
 * legal-notices page is privacy-only); `license.text` is the conservative
 * "brera-unstated" marker, attributed to "Pinacoteca di Brera collection
 * API" with termsUrl the site root. No image derivatives are shipped
 * (imageLicense always "") — the WP API's `featured_media` ids are not even
 * hydrated here, per the same Italian-MiC-non-profit-only reasoning as
 * Egizio/Uffizi in the survey. A confirmation email to the museum about text
 * reuse is a tracked follow-up, not a gate this adapter waits on.
 *
 * translateFrom: "it" — titles and the genre/period/technique vocabulary are
 * Italian; data/src/translate.ts fills titleAlt + Englishes the facet
 * columns exactly like Louvre/Rijksmuseum.
 *
 * Politeness: <=1 req/s (createPoliteClient), 14 requests total — delta() is
 * a full re-pull (trivially cheap, same convention as every non-Met source).
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const BASE = "https://pinacotecabrera.org/wp-json/wp/v2";
const UA = "MuseWalk-research/0.1 (kuitang42@gmail.com)";
const SITE = "brera";
const LICENSE = "brera-unstated";
const PAGE_SIZE = 100;

// Off-site deposit-church sub-tags inside the opere-sala vocabulary (all
// named "Paderno Dugnano (MI), Chiesa di Santa Maria Nascente[, ...]") — not
// physical rooms in the Milan palazzo. Excluded from on-view wholesale even
// though only 127 is measured to be referenced by an exhibited+roomed row.
const OFFSITE_ROOM_IDS = new Set([126, 127, 128]);

// opere-genere administrative status tags that just restate the on-view
// filter ("Opere esposte" / "Opere non esposte") — excluded from
// classification so the field carries only genuine content when present.
const STATUS_GENERE_IDS = new Set([25, 27]);

/** Undo WordPress's wptexturize numeric-entity encoding (curly quotes, en
 * dash) plus the standard named entities — measured live: titles only ever
 * carry &#8211; &#8217; &#8220; &#8221;, taxonomy term names only ever carry
 * &amp;. A generic numeric-entity fallback covers anything else. */
function decodeWpEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

function client(maxAttempts: number) {
  return createPoliteClient({
    reqsPerSec: 1,
    concurrency: 1,
    maxAttempts,
    userAgent: UA,
    label: "brera",
  });
}

interface WpTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
}

/**
 * Fetch every page of a WP term-list endpoint. WP core 400s a page number
 * past the last one (rather than returning an empty array), so pagination
 * stops as soon as a page comes back shorter than PAGE_SIZE — safe for every
 * taxonomy actually measured here (none has a term count that is an exact
 * multiple of 100).
 */
async function fetchAllTerms(
  c: ReturnType<typeof client>,
  taxonomy: string,
): Promise<Map<number, WpTerm>> {
  const terms = new Map<number, WpTerm>();
  for (let page = 1; ; page++) {
    const res: WpTerm[] = await c.fetchJson(`${BASE}/${taxonomy}?per_page=${PAGE_SIZE}&page=${page}`);
    for (const t of res) terms.set(t.id, { ...t, name: decodeWpEntities(t.name) });
    if (res.length < PAGE_SIZE) break;
  }
  return terms;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface OperaRecord {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  class_list: string[];
  "opere-autore": number[];
  "opere-genere": number[];
  "opere-periodo": number[];
  "opere-sala": number[];
  "opere-tecnica": number[];
  modified?: string;
}

async function fetchAllOpere(c: ReturnType<typeof client>): Promise<OperaRecord[]> {
  const rows: OperaRecord[] = [];
  for (let page = 1; ; page++) {
    const res: OperaRecord[] = await c.fetchJson(`${BASE}/opera?per_page=${PAGE_SIZE}&page=${page}`);
    rows.push(...res);
    if (res.length < PAGE_SIZE) break;
  }
  return rows;
}

function namesFor(ids: number[], terms: Map<number, WpTerm>, exclude?: Set<number>): string {
  return ids
    .filter((id) => !exclude?.has(id))
    .map((id) => terms.get(id)?.name)
    .filter((n): n is string => Boolean(n))
    .join("; ");
}

interface Taxonomies {
  sala: Map<number, WpTerm>;
  autore: Map<number, WpTerm>;
  genere: Map<number, WpTerm>;
  periodo: Map<number, WpTerm>;
  tecnica: Map<number, WpTerm>;
}

/** null when the record isn't a placeable on-view Brera row. */
function toRow(a: OperaRecord, tax: Taxonomies): ObjectRow | null {
  if (a.class_list.includes("opere-genere-non-esposte")) return null; // not exhibited (also covers deposits)
  const roomIds = (a["opere-sala"] ?? []).filter((id) => !OFFSITE_ROOM_IDS.has(id));
  const roomId = roomIds[0];
  if (roomId === undefined) return null; // unplaced or off-site-only — location is the product
  const room = tax.sala.get(roomId);
  if (!room) return null; // defensive: unknown term id

  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: String(a.id),
    accession: "", // no accession/inventory field exists in this API (verified)
    title: decodeWpEntities(a.title.rendered ?? ""),
    artist: namesFor(a["opere-autore"] ?? [], tax.autore),
    culture: "",
    period: namesFor(a["opere-periodo"] ?? [], tax.periodo),
    classification: namesFor(a["opere-genere"] ?? [], tax.genere, STATUS_GENERE_IDS),
    medium: namesFor(a["opere-tecnica"] ?? [], tax.tecnica),
    tags: "",
    galleryNumber: room.name,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal in this API
    imageUrl: "", // no image derivatives shipped (Italian MiC non-profit-only rule)
    metadataDate: a.modified ?? "",
    license: LICENSE,
    imageLicense: "",
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = client(8);
  const t0 = Date.now();

  const [sala, autore, genere, periodo, tecnica] = await Promise.all([
    fetchAllTerms(c, "opere-sala"),
    fetchAllTerms(c, "opere-autore"),
    fetchAllTerms(c, "opere-genere"),
    fetchAllTerms(c, "opere-periodo"),
    fetchAllTerms(c, "opere-tecnica"),
  ]);
  const tax: Taxonomies = { sala, autore, genere, periodo, tecnica };
  console.log(
    `brera: taxonomies loaded — sala ${sala.size}, autore ${autore.size}, genere ${genere.size}, periodo ${periodo.size}, tecnica ${tecnica.size}`,
  );

  const opere = await fetchAllOpere(c);
  console.log(`brera: ${opere.length} opera records fetched`);

  let rows: ObjectRow[] = [];
  let skippedNotExhibited = 0;
  let skippedNoRoom = 0;
  const galleryLabels = new Map<string, GalleryLabelRow>();
  for (const a of opere) {
    if (a.class_list.includes("opere-genere-non-esposte")) {
      skippedNotExhibited++;
      continue;
    }
    const row = toRow(a, tax);
    if (!row) {
      skippedNoRoom++;
      continue;
    }
    rows.push(row);
    if (!galleryLabels.has(row.galleryNumber)) {
      galleryLabels.set(row.galleryNumber, { galleryNumber: row.galleryNumber, site: SITE, floor: "1" });
    }
  }
  rows.sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));
  if (rows.length > limit) rows = rows.slice(0, limit);

  const meta = {
    fetchedAt: new Date().toISOString(),
    totalRecords: opere.length,
    skipped: { notExhibited: skippedNotExhibited, noRoom: skippedNoRoom },
    rows: rows.length,
    distinctGalleryNumbers: galleryLabels.size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    ...(limit < Infinity ? { partial: true, limit } : null),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(rows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("brera meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const breraSource: MuseumSource = {
  id: "brera",
  fullFetch,
  // The whole catalog is 14 requests — delta IS a full re-pull, same
  // convention as every other non-Met source.
  delta: async (snapDir) => {
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
