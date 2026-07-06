/**
 * Galleria degli Uffizi (Florence) source adapter (D14) — the fleet's first
 * SPARQL museum: the Italian ministry's ArCo national-catalog LOD at
 * https://dati.beniculturali.it/sparql (Virtuoso, keyless). Access design was
 * measured live 2026-07-06 (Italy/Spain survey + this adapter's probes, same
 * ≤1 req/s research-UA envelope).
 *
 * QUERY SHAPE (the hard-won part): heavy GROUP BY/aggregate queries on this
 * endpoint SILENTLY return empty or partial results — everything here is a
 * simple paged SELECT (ORDER BY ?prop, LIMIT/OFFSET 1000) and all counting/
 * deduping happens client-side. Scope: `a-loc:hasTimeIndexedTypedLocation`
 * → TITL with `a-loc:hasLocationType a-loc:CurrentPhysicalLocation` +
 * `a-loc:hasCulturalInstituteOrSite` whose CIS `rdfs:label` is EXACTLY
 * "Galleria degli Uffizi" (label-scoped, as measured — this excludes the
 * "Gabinetto Disegni e Stampe degli Uffizi" CIS, 4,358 never-displayed
 * drawings, plus the Contini Bonacossi / "Gallerie degli Uffizi" umbrella
 * variants). The room string lives in `core:specifications` on the TITL —
 * beware: the intuitive `a-loc:specifications` guess returns NOTHING, the
 * predicate is in the `core:` namespace. Measured corpus: 3,614 objects
 * under this CIS, 3,448 (95.4%) with a specification; the spec-bearing set
 * defines the harvest (no spec = no room = not shippable at this fidelity).
 *
 * Six field queries share the same scope (verified live: each shape returns
 * full pages; no OPTIONALs — a wide OPTIONAL query duplicates rows per
 * author-label variant, so fields are pulled as separate (?prop, ?v) pairs
 * and merged client-side):
 *   spec   <- core:specifications (on the TITL)         — required, corpus
 *   label  <- rdfs:label FILTER lang="it" (the composite ICCD title; the
 *             "en" twin is pseudo-English — "… by Caliari Paolo …" with the
 *             rest untranslated — and is deliberately ignored)
 *   date   <- dc:date        ("ca 1570-ca 1575")        -> period
 *   type   <- dc:type        ("dipinto")                -> classification
 *   mt     <- pico:materialAndTechnique ("tela/ pittura a olio") -> medium
 *   author <- a-cd:hasPreferredAuthor / rdfs:label      -> artist fallback
 *
 * COMPOSITE TITLES: the it label is "Base (type) di Author (sec. XVI)" (or
 * "… - ambito lombardo-veneto (sec. XVI)" for school attributions).
 * splitComposite() parses that into title/classification/artist/culture/
 * period ONLY when the shape is unambiguous (first parenthetical is a
 * lowercase, digit-free type word; remainder starts "di "/"- "); anything
 * else keeps the full label as the title — honest fallback over clever
 * guessing. dc:type/dc:date win over the parsed type/century when present.
 *
 * ON-VIEW = measured spec filter (no boolean exists in ArCo), same approach
 * as Cleveland's code ranges. From the full 316-distinct-spec census:
 * storage/off-view keywords (deposito/depositi, G.D.S.U/GDSU/Gabinetto
 * Disegni, soffittone, uffici/Archivio/vecchia posta admin spaces,
 * piano terreno/terzo service shafts, esterno facade works, miniature
 * boxes) EXCLUDE; room patterns INCLUDE: "sala …" (numbered, lettered, and
 * named salas), "tratto …" + corridoio/crociera (the corridors hang works —
 * Vasari corridor sections, east/west corridor bays), scalone/vestibolo/
 * salone d'ingresso/uscita verso Boboli circulation spaces, and the ex
 * chiesa di S. Pier Scheraggio annex. Everything else (neither list) is
 * off-view. fullFetch prints the exact counts per bucket.
 *
 * GALLERY NUMBERS: the post-2021 lettered scheme "primo/secondo piano, sala
 * A16" (1,253 records incl. the "paino" typo + comma-less variants) →
 * galleryNumber "A16" with floor "1"/"2" from the prefix; the letter→floor
 * mapping is fully determined in the census (A* = secondo piano; B/C/D/E* =
 * primo piano) so the one bare "D25. Veronese" spec resolves too. Plain
 * "sala 20" → "20" (older-vintage numbering, floor left NULL — no guessing).
 * Named rooms and corridors keep their first comma segment as the room id
 * ("sala di Gherardo delle Notti", "tratto Ponte Vecchio", "corridoio di
 * levante"), case-folded to one canonical spelling. Residual spec text
 * (campata/soffitto/bacheca positions) goes to locationNote; name-like
 * residues ("Pittori Olandesi XVII secolo …") become the gallery title.
 *
 * License: ICCD LOD reuse requires attribution + share-alike ⇒ CC-BY-SA-4.0
 * on text (registry notes the SA obligation); NO image grant (the catalog's
 * termini-uso page routes photo reproduction through a per-request ministry
 * concession, D.M. 161/2023) — imageUrl/imageLicense stay "" even though
 * foaf:depiction URLs exist. sourceId = the ArCo resource-URI tail
 * ("0900193960", suffixed multi-part ids like "0900189558-2" included);
 * catalogo.beniculturali.it/detail/HistoricOrArtisticProperty/{sourceId}
 * verified 200 for both forms. Titles are Italian → registry translateFrom
 * "it" routes them through translate.ts (DeepSeek IT→EN titleAlt + vocab).
 *
 * Politeness/scale: ≤1 req/s sequential paging; the full harvest is ~25
 * requests (6 field queries × ≤5 pages), cached page-by-page in
 * data/raw/uffizi/sparql-pages.json (gitignored) so an interrupted run
 * resumes without refetching. Delta = full re-pull per run — at ~25 cheap
 * requests there is nothing worth diffing upstream (no per-record
 * datestamps in these literals anyway).
 */
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const SPARQL = "https://dati.beniculturali.it/sparql";
const UA = "MuseWalk-research/0.1 (kuitang@gmail.com)";
const SITE = "uffizi";
const PAGE = 1000;
const REQS_PER_SEC = 1;

const RAW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "raw", "uffizi");
const CACHE_FILE = join(RAW_DIR, "sparql-pages.json");

const PREFIXES = `PREFIX core: <https://w3id.org/arco/ontology/core/>
PREFIX a-loc: <https://w3id.org/arco/ontology/location/>
PREFIX a-cd: <https://w3id.org/arco/ontology/context-description/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX pico: <http://data.cochrane.org/ontologies/pico/>`;

// CIS scoped by exact label — see header (this is what excludes the
// drawings cabinet). core:specifications is REQUIRED even in field queries
// so every query walks the same corpus.
const SCOPE = `?prop a-loc:hasTimeIndexedTypedLocation ?titl .
  ?titl a-loc:hasLocationType a-loc:CurrentPhysicalLocation ;
        a-loc:hasCulturalInstituteOrSite ?cis ;
        core:specifications ?spec .
  ?cis rdfs:label "Galleria degli Uffizi" .`;

/** Each query SELECTs (?prop, ?v); results merge client-side by ?prop. */
const FIELD_QUERIES: Record<string, string> = {
  spec: `SELECT ?prop (?spec AS ?v) WHERE { ${SCOPE} }`,
  label: `SELECT ?prop ?v WHERE { ${SCOPE} ?prop rdfs:label ?v . FILTER(lang(?v) = "it") }`,
  date: `SELECT ?prop ?v WHERE { ${SCOPE} ?prop dc:date ?v . }`,
  type: `SELECT ?prop ?v WHERE { ${SCOPE} ?prop dc:type ?v . }`,
  mt: `SELECT ?prop ?v WHERE { ${SCOPE} ?prop pico:materialAndTechnique ?v . }`,
  author: `SELECT ?prop ?v WHERE { ${SCOPE} ?prop a-cd:hasPreferredAuthor ?agent . ?agent rdfs:label ?v . }`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ *
 * Paged SPARQL harvest with a page-level resume cache.
 * ------------------------------------------------------------------------ */

type PageCache = Record<string, Array<[string, string]>>; // "field:offset" -> [propId, value][]

function loadCache(): PageCache {
  return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
}

function saveCache(cache: PageCache): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(cache));
  renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
}

interface Harvest {
  pairs: Map<string, Array<[string, string]>>; // field -> [propId, value][]
  requests: number;
}

async function harvestAll(): Promise<Harvest> {
  const c = createPoliteClient({ reqsPerSec: REQS_PER_SEC, concurrency: 1, maxAttempts: 8, userAgent: UA, label: "uffizi" });
  const cache = loadCache();
  const pairs = new Map<string, Array<[string, string]>>();
  let requests = 0;

  for (const [field, query] of Object.entries(FIELD_QUERIES)) {
    const rows: Array<[string, string]> = [];
    for (let offset = 0; ; offset += PAGE) {
      const key = `${field}:${offset}`;
      let page = cache[key];
      if (!page) {
        if (requests > 0) await sleep(1000 / REQS_PER_SEC);
        const q = `${PREFIXES}\n${query} ORDER BY ?prop ?v LIMIT ${PAGE} OFFSET ${offset}`;
        const url = `${SPARQL}?${new URLSearchParams({ query: q, format: "application/sparql-results+json" })}`;
        const res = await c.fetchJson(url);
        requests++;
        const bindings: Array<Record<string, { value: string }>> = res?.results?.bindings ?? [];
        // Virtuoso failure mode is a silent empty/short page — a zero-row
        // FIRST page for the required fields is structural drift, fail loud.
        if (offset === 0 && bindings.length === 0 && (field === "spec" || field === "label")) {
          throw new Error(`uffizi: '${field}' query returned zero rows — the ArCo schema/endpoint may have changed`);
        }
        page = bindings.map((b) => [b.prop.value.split("/").pop()!, b.v.value]);
        // Cache only complete pages and the final short page of a completed
        // field — i.e. everything, but only once the fetch succeeded.
        cache[key] = page;
        saveCache(cache);
      }
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    pairs.set(field, rows);
    console.log(`uffizi: ${field} — ${rows.length} rows`);
  }
  return { pairs, requests };
}

/* ------------------------------------------------------------------------ *
 * Spec parsing: on-view filter + room-code normalization (see header).
 * ------------------------------------------------------------------------ */

// Storage & non-public keywords — checked FIRST ("Depositi. Sala 3" must not
// pass the sala pattern). From the measured 316-spec census.
const STORAGE_RE = /deposit|g\.?\s?d\.?\s?s\.?\s?u|gabinetto disegni|soffittone|\buffici\b|archivio storico|vecchia posta|piano terreno|piano terzo|collezione miniature|cassette miniature/i;
// Public room/corridor/circulation patterns; bare lettered codes ("D25. …") included.
const ROOM_RE = /\bsala\b|\btratto\b|corridoi|crociera|scalone|vestibolo|salone d.ingresso|uscita verso boboli|ex chiesa|^[A-E]\d{1,2}\b/i;

export function isOnView(spec: string): boolean {
  return !STORAGE_RE.test(spec) && ROOM_RE.test(spec);
}

// Residues that are wall/ceiling positions, not room names.
const POSITION_RE = /campat|soffitt|cupola|paret|volta|bacheca|centro|braccio|testata|pianerottolo|rampa|sguanci|monofora|porta|colonna/i;

export interface ParsedSpec {
  gallery: string;
  floor: string | null;
  title?: string;
  note: string;
}

const FLOOR: Record<string, string> = { primo: "1", secondo: "2" };
/** Measured: every "secondo piano" sala is A*, every "primo piano" sala is B/C/D/E*. */
const floorForLetter = (letter: string): string => (letter.toUpperCase() === "A" ? "2" : "1");

/** "(sala del Settecento)" -> "sala del Settecento"; positions -> no title. */
function roomTitleFrom(residual: string): string | undefined {
  let t = residual.trim().replace(/^[,.]\s*/, "");
  const paren = /^\(([^()]+)\)$/.exec(t);
  if (paren) t = paren[1].trim();
  if (!t || POSITION_RE.test(t)) return undefined;
  return t;
}

export function parseSpec(spec: string): ParsedSpec {
  const s = spec.trim().replace(/\s+/g, " ");
  // 1. Lettered scheme with floor prefix (tolerates the census's "paino"
  //    typo and a missing comma): "secondo piano, sala A16[, residual]".
  let m = /^(primo|secondo)\s+p(?:ia|ai)no,?\s+sala\s+([A-E]\d{1,2})\b[.,]?\s*(.*)$/i.exec(s);
  if (m) {
    return { gallery: m[2].toUpperCase(), floor: FLOOR[m[1].toLowerCase()], title: roomTitleFrom(m[3]), note: m[3].replace(/^[,.]\s*/, "").trim() };
  }
  // 1b. Bare lettered code: "D25. Veronese".
  m = /^([A-E]\d{1,2})\b[.,]?\s*(.*)$/.exec(s);
  if (m) {
    return { gallery: m[1].toUpperCase(), floor: floorForLetter(m[1][0]), title: roomTitleFrom(m[2]), note: m[2].trim() };
  }
  // 2. Numbered sala (older vintage; floor unknown — never guessed):
  //    "sala 20", "Sala 41 di Rubens", "sala 10-14", "sala 18 (tribuna), cupola".
  m = /^sala\s+(\d+(?:-\d+)?)\b[.,]?\s*(.*)$/i.exec(s);
  if (m) {
    return { gallery: m[1], floor: null, title: roomTitleFrom(m[2]), note: m[2].replace(/^[,.]\s*/, "").trim() };
  }
  // 3. Named salas / corridors / circulation spaces: room id = first comma
  //    segment ("tratto Boboli, seconda bacheca" -> room "tratto Boboli").
  const [head, ...rest] = s.split(",");
  return { gallery: head.trim(), floor: null, note: rest.join(",").trim() };
}

/* ------------------------------------------------------------------------ *
 * Composite-title splitting (see header for the pattern and the fallback).
 * ------------------------------------------------------------------------ */

export interface SplitTitle {
  title: string;
  classification?: string;
  artist?: string;
  culture?: string;
  period?: string;
}

export function splitComposite(label: string): SplitTitle {
  const m = /^([^()]+?)\s*\(([^()]+)\)\s*(.*)$/.exec(label.trim());
  if (!m) return { title: label.trim() };
  const [, base, typePart, tail] = m;
  // The first parenthetical must look like an ICCD type ("dipinto",
  // "dipinto, pendant") — lowercase start, no digits, short.
  if (!/^[a-zà-ù]/.test(typePart) || /\d/.test(typePart) || typePart.length > 40) {
    return { title: label.trim() };
  }
  let rest = tail.trim();
  let period: string | undefined;
  const dateM = /\(([^()]*(?:sec\.|secolo|\d{3,4})[^()]*)\)$/.exec(rest);
  if (dateM) {
    period = dateM[1].trim();
    rest = rest.slice(0, dateM.index).trim();
  }
  if (rest.startsWith("di ")) return { title: base.trim(), classification: typePart, artist: rest.slice(3).trim(), period };
  if (rest.startsWith("- ")) return { title: base.trim(), classification: typePart, culture: rest.slice(2).trim(), period };
  if (rest === "") return { title: base.trim(), classification: typePart, period };
  return { title: label.trim(), period }; // unparseable residue — keep the composite
}

/** "Vasari Giorgio - 1511/ 1574" / "Vasari Giorgio (1511/ 1574)" -> "Vasari Giorgio" (keeps "(attribuito)" etc.). */
export function cleanAuthor(name: string): string {
  return name
    .replace(/\s*\(([^()]*\d{3,4}[^()]*|notizie[^()]*)\)\s*$/i, "")
    .replace(/\s*-\s*(ca\.?\s*)?\d{3,4}.*$/, "")
    .trim();
}

/** "1621-1621" -> "1621". */
const collapseRange = (d: string): string => {
  const m = /^(.+?)-(.+)$/.exec(d);
  return m && m[1].trim() === m[2].trim() ? m[1].trim() : d;
};

/* ------------------------------------------------------------------------ *
 * MuseumSource
 * ------------------------------------------------------------------------ */

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const t0 = Date.now();
  const { pairs, requests } = await harvestAll();

  const firstBy = (field: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const [id, v] of pairs.get(field) ?? []) if (!m.has(id)) m.set(id, v);
    return m;
  };
  const specs = firstBy("spec");
  const labels = firstBy("label");
  const dates = firstBy("date");
  const types = firstBy("type");
  const mts = firstBy("mt");
  const authors = new Map<string, string[]>();
  for (const [id, v] of pairs.get("author") ?? []) {
    const cleaned = cleanAuthor(v);
    const list = authors.get(id) ?? [];
    if (cleaned && !list.includes(cleaned)) list.push(cleaned);
    authors.set(id, list);
  }

  // On-view split, counted per bucket (documented filter — see header).
  let storage = 0;
  let otherOffView = 0;
  const onViewIds: string[] = [];
  for (const [id, spec] of specs) {
    if (STORAGE_RE.test(spec)) storage++;
    else if (!ROOM_RE.test(spec)) otherOffView++;
    else onViewIds.push(id);
  }
  onViewIds.sort();

  // Canonical gallery spelling: first-seen form per case-folded key, so
  // "Corridoio Vasariano"/"corridoio vasariano" land in ONE galleries row.
  const canonical = new Map<string, string>();
  const galleryLabels = new Map<string, GalleryLabelRow>();
  const rows: ObjectRow[] = [];
  for (const id of onViewIds) {
    const spec = specs.get(id)!;
    const parsed = parseSpec(spec);
    const key = parsed.gallery.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, parsed.gallery);
    const gallery = canonical.get(key)!;
    const existing = galleryLabels.get(key);
    if (!existing) {
      galleryLabels.set(key, { galleryNumber: gallery, site: SITE, title: parsed.title, floor: parsed.floor ?? undefined });
    } else {
      if (!existing.title && parsed.title) existing.title = parsed.title;
      if (!existing.floor && parsed.floor) existing.floor = parsed.floor;
    }

    const label = labels.get(id) ?? "";
    const split = splitComposite(label);
    const classification = types.get(id) ?? split.classification ?? "";
    rows.push({
      objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
      sourceId: id,
      accession: id, // ArCo uniqueIdentifier == the URI tail; no separate accession at this tier
      title: split.title || classification,
      artist: split.artist ?? (authors.get(id) ?? []).join("; "),
      culture: split.culture ?? "",
      period: dates.has(id) ? collapseRange(dates.get(id)!) : (split.period ?? ""),
      classification,
      medium: mts.get(id) ?? "",
      tags: "",
      galleryNumber: gallery,
      site: SITE,
      rotation: "permanent",
      isHighlight: false, // no curated-highlight signal in ArCo
      imageUrl: "", // no image grant (ministry per-request concession only) — see header
      metadataDate: "", // ArCo exposes no per-record datestamp at this tier
      locationNote: parsed.note,
      imageLicense: "",
    });
  }

  let finalRows = rows.sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));
  if (finalRows.length > limit) finalRows = finalRows.slice(0, limit);

  const meta = {
    fetchedAt: new Date().toISOString(),
    propsWithSpec: specs.size,
    onView: onViewIds.length,
    storageFiltered: storage,
    otherOffView,
    rows: finalRows.length,
    titleFill: finalRows.filter((r) => labels.has(r.sourceId!)).length,
    splitTitles: finalRows.filter((r) => r.title && labels.get(r.sourceId!) !== r.title).length,
    distinctGalleryNumbers: galleryLabels.size,
    flooredGalleries: [...galleryLabels.values()].filter((g) => g.floor).length,
    requests,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleryLabels.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("uffizi meta:", JSON.stringify(meta, null, 2));
  return meta;
}

export const uffiziSource: MuseumSource = {
  id: "uffizi",
  fullFetch,
  // Delta IS a full re-pull (~25 requests; no upstream datestamps to window
  // on) — clear the page cache first so the pull is genuinely fresh.
  delta: async (snapDir) => {
    if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, "{}");
    const meta = await fullFetch({ snapDir });
    return meta.rows as number;
  },
};
