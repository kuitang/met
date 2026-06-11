/**
 * Client-side search core for MuseWalk. Platform-neutral: no expo/node
 * imports. Callers pass a minimal DB handle; on native/web that is expo-sqlite
 * (`getAllAsync`), on the server and in tests it is better-sqlite3.
 *
 * Expected met.sqlite schema (the B4 build-db contract this module queries):
 *   objects(objectID INTEGER PRIMARY KEY, accession, title, artist, culture,
 *           period, classification, medium, tags, galleryNumber, site,
 *           rotation, isHighlight INTEGER 0/1, imageUrl, metadataDate,
 *           synonyms)
 *   objects_fts — FTS5(title, artist, culture, classification, medium, tags,
 *           synonyms, content='objects', content_rowid='objectID',
 *           tokenize='porter unicode61', prefix='2 3 4')
 *   galleries(galleryNumber, site, floor, ...) — PK (galleryNumber, site)
 *   amenities(..., type IN ('restroom','dining','elevator','water','info'), ...)
 *
 * bm25 column weights (title, artist, culture, classification, medium, tags,
 * synonyms) = (10, 8, 3, 5, 2, 4, 1). synonyms is the LLM-generated
 * index-time expansion column (data/src/synonyms.ts → build-db) — weighted
 * minimally (1) so it adds recall without outranking literal matches
 * (weights 2-3 measurably regressed "blue ming vases": period-synonym noise
 * outranked literal "vase" titles; weight 1 keeps all 50 goldens green).
 * SQLite bm25() returns NEGATIVE numbers where more negative = better match,
 * so `score` is ordered ASC and highlights get a constant subtracted as a
 * boost.
 */

export interface DbHandle {
  all(
    sql: string,
    params: ReadonlyArray<string | number>,
  ): SearchRow[] | Promise<SearchRow[]>;
}

export interface SearchRow {
  objectID: number;
  title: string;
  artist: string;
  galleryNumber: string;
  site: string;
  floor: string | null;
  isHighlight: number;
  imageUrl: string;
  score: number;
}

export interface SearchFilters {
  site?: "fifthAve" | "cloisters";
  floor?: string;
  rotation?: "permanent" | "exhibition";
  hasImage?: boolean;
}

export interface BuiltQuery {
  sql: string;
  params: Array<string | number>;
}

const BM25 = "bm25(objects_fts, 10, 8, 3, 5, 2, 4, 1)";
const HIGHLIGHT_BOOST = 2.0;

/** Lowercase, strip everything but letters/digits to spaces, collapse runs. */
export function normalizeQuery(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(input: string): string[] {
  const n = normalizeQuery(input);
  return n ? n.split(" ") : [];
}

/** Every token double-quoted (FTS5-safe) and prefix-starred, implicit AND. */
export function toPrefixMatch(input: string): string | null {
  const toks = tokens(input);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"*`).join(" ");
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "by", "for", "with", "to",
  "and", "or", "is", "are", "was", "were", "that", "this", "it", "its",
  "from", "as", "i", "me", "my", "some", "any", "show", "find",
]);

/**
 * AND→OR relaxation for LLM-rewritten queries: stopwords dropped, remaining
 * tokens quoted and OR-joined (no prefix star — porter stemming covers
 * morphology, and OR-of-prefixes over-matches). bm25 naturally ranks rows
 * matching more OR terms first. Returns null if nothing survives.
 */
export function relaxQuery(ftsQuery: string): string | null {
  let toks = tokens(ftsQuery).filter((t) => !STOPWORDS.has(t));
  if (toks.length === 0) toks = tokens(ftsQuery);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"`).join(" OR ");
}

const SELECT_CORE = `SELECT o.objectID, o.title, o.artist, o.galleryNumber, o.site,
       g.floor AS floor, o.isHighlight, o.imageUrl,
       ${BM25} - (o.isHighlight * ${HIGHLIGHT_BOOST}) AS score
FROM objects_fts
JOIN objects o ON o.objectID = objects_fts.rowid
LEFT JOIN galleries g ON g.galleryNumber = o.galleryNumber AND g.site = o.site
WHERE objects_fts MATCH ?`;

/**
 * Autocomplete (every keystroke): every-token-prefixed AND match, weighted
 * bm25 + highlight boost, gallery floor joined inline, top 8.
 */
export function buildAutocompleteQuery(input: string): BuiltQuery | null {
  const match = toPrefixMatch(input);
  if (match === null) return null;
  return { sql: `${SELECT_CORE}\nORDER BY score\nLIMIT 8`, params: [match] };
}

export interface FullQueryOpts {
  /** Use relaxQuery (OR semantics) instead of prefixed AND. */
  relaxed?: boolean;
  /** Optional LIMIT; the All Results page passes none. */
  limit?: number;
}

/**
 * All Results page / server interpret execution: same ranked query plus plain
 * WHERE filters (site, floor, rotation, hasImage) and no LIMIT by default.
 * With `relaxed: true`, `input` may be a raw user query or an LLM ftsQuery.
 */
export function buildFullQuery(
  input: string,
  filters: SearchFilters = {},
  opts: FullQueryOpts = {},
): BuiltQuery | null {
  const match = opts.relaxed ? relaxQuery(input) : toPrefixMatch(input);
  if (match === null) return null;
  let sql = SELECT_CORE;
  const params: Array<string | number> = [match];
  if (filters.site) {
    sql += `\n  AND o.site = ?`;
    params.push(filters.site);
  }
  if (filters.floor) {
    sql += `\n  AND g.floor = ?`;
    params.push(filters.floor);
  }
  if (filters.rotation) {
    sql += `\n  AND o.rotation = ?`;
    params.push(filters.rotation);
  }
  if (filters.hasImage) {
    sql += `\n  AND o.imageUrl <> ''`;
  }
  sql += `\nORDER BY score`;
  if (opts.limit !== undefined) {
    sql += `\nLIMIT ?`;
    params.push(opts.limit);
  }
  return { sql, params };
}

// ---------------------------------------------------------- gallery browsing

/**
 * Canonical in-gallery ordering: highlights first, then objectID — objectID
 * is unique, so the ordering is fully deterministic. objectsInGallery (the
 * capped display list), the position counter and the neighbor queries below
 * MUST all agree on this tuple; the keyed comparisons in the builders are
 * this ordering spelled out as predicates.
 */
export const GALLERY_ORDER = "isHighlight DESC, objectID";

/** Predicate: row `before` strictly precedes row `current` in GALLERY_ORDER. */
const precedes = (before: string, current: string) =>
  `(${before}.isHighlight > ${current}.isHighlight
     OR (${before}.isHighlight = ${current}.isHighlight AND ${before}.objectID < ${current}.objectID))`;

/**
 * True position of an object within its gallery, computed in SQL over the
 * FULL gallery ordering (galleries hold up to ~4.5k objects; the capped
 * display list must never define the counter). Returns one row
 * `{ position, total }` — `position` 1-based in GALLERY_ORDER, `total` the
 * true gallery count — or no rows when the object is unknown or not on view.
 * Index range scans on objects(galleryNumber); no row materialization.
 */
export function buildGalleryPositionQuery(objectID: number): BuiltQuery {
  return {
    sql: `SELECT
  (SELECT COUNT(*) FROM objects p
    WHERE p.galleryNumber = o.galleryNumber AND ${precedes("p", "o")}) + 1 AS position,
  (SELECT COUNT(*) FROM objects t WHERE t.galleryNumber = o.galleryNumber) AS total
FROM objects o
WHERE o.objectID = ? AND o.galleryNumber <> ''`,
    params: [objectID],
  };
}

/**
 * Previous/next object in the FULL gallery ordering, with wraparound at the
 * true ends (prev of the first object = the last object and vice versa —
 * the J15 browse loop, honest over the whole gallery). Returns one row
 * `{ prevObjectID, nextObjectID }` (both equal the input in a single-object
 * gallery), or no rows when the object is unknown or not on view.
 * Keyed comparisons + LIMIT 1 — no row materialization.
 */
export function buildGalleryNeighborsQuery(objectID: number): BuiltQuery {
  return {
    sql: `SELECT
  COALESCE(
    (SELECT p.objectID FROM objects p
      WHERE p.galleryNumber = o.galleryNumber AND ${precedes("p", "o")}
      ORDER BY p.isHighlight ASC, p.objectID DESC LIMIT 1),
    (SELECT l.objectID FROM objects l WHERE l.galleryNumber = o.galleryNumber
      ORDER BY l.isHighlight ASC, l.objectID DESC LIMIT 1)
  ) AS prevObjectID,
  COALESCE(
    (SELECT n.objectID FROM objects n
      WHERE n.galleryNumber = o.galleryNumber AND ${precedes("o", "n")}
      ORDER BY n.isHighlight DESC, n.objectID ASC LIMIT 1),
    (SELECT f.objectID FROM objects f WHERE f.galleryNumber = o.galleryNumber
      ORDER BY f.isHighlight DESC, f.objectID ASC LIMIT 1)
  ) AS nextObjectID
FROM objects o
WHERE o.objectID = ? AND o.galleryNumber <> ''`,
    params: [objectID],
  };
}

// ----------------------------------------------------------- gallery search
//
// Galleries are a separate, tiny table (~460 rows) that objects_fts never
// covers — this is why digit queries used to "show nothing": the only search
// surface was objects_fts, where digits live almost exclusively in the
// UNINDEXED accession column. Gallery matching is a pure in-memory function
// (callers hold the gallery list anyway) instead of another FTS index.

export interface GalleryHit {
  galleryNumber: string;
  title: string | null;
}

/**
 * Gallery rows for the omnibar. Two regimes (user ranking mandate):
 *  - digit query: exact gallery number first, then number-prefix matches
 *    (e.g. "13" → 130, 131, …), numerically ordered, capped.
 *  - query with letters: every token must prefix-match a word of the gallery
 *    title or number ("dendur" → The Temple of Dendur; "746 south" →
 *    746 South), input order preserved, capped.
 */
export function matchGalleries<T extends GalleryHit>(
  galleries: readonly T[],
  query: string,
  cap = 4,
): T[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  if (/^\d+$/.test(q)) {
    const exact = galleries.filter((g) => g.galleryNumber === q);
    const prefix = galleries
      .filter((g) => g.galleryNumber !== q && g.galleryNumber.startsWith(q))
      .sort((a, b) =>
        a.galleryNumber.localeCompare(b.galleryNumber, undefined, { numeric: true }),
      );
    return [...exact, ...prefix].slice(0, cap);
  }
  const toks = q.split(" ");
  return galleries
    .filter((g) => {
      const hay = tokens(`${g.galleryNumber} ${g.title ?? ""}`);
      return toks.every((t) => hay.some((h) => h.startsWith(t)));
    })
    .slice(0, cap);
}

/**
 * Accession-number matches for digit-bearing queries. The accession column is
 * NOT in objects_fts (root cause of empty digit autocomplete: digits live in
 * accessions like "21.131", titles rarely carry them), so this is a LIKE
 * containment scan over objects — measured 0.6 ms per query on the full 44.8k
 * catalog (better-sqlite3), well inside keystroke budget even at wasm speed.
 * Tokens are joined with '%' so "21.131" (normalized "21 131") still matches
 * the dotted accession. Returns null when the query carries no digit.
 */
export function buildAccessionSearchQuery(input: string, limit = 8): BuiltQuery | null {
  const toks = tokens(input);
  if (toks.length === 0 || !toks.some((t) => /\d/.test(t))) return null;
  const esc = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${toks.map(esc).join("%")}%`;
  return {
    sql: `SELECT o.objectID, o.title, o.artist, o.galleryNumber, o.site,
       g.floor AS floor, o.isHighlight, o.imageUrl, 0 AS score
FROM objects o
LEFT JOIN galleries g ON g.galleryNumber = o.galleryNumber AND g.site = o.site
WHERE o.accession LIKE ? ESCAPE '\\'
ORDER BY o.isHighlight DESC, o.objectID
LIMIT ?`,
    params: [pattern, limit],
  };
}

export type AmenityType = "restroom" | "dining" | "elevator" | "water" | "info";

const AMENITY_TOKENS: Array<[AmenityType, string[]]> = [
  ["restroom", ["restroom", "bathroom", "toilet", "washroom", "lavatory", "wc", "loo"]],
  ["dining", ["cafe", "cafeteria", "coffee", "food", "restaurant", "dining", "eat", "eating", "lunch", "dinner", "snack", "bar"]],
  ["elevator", ["elevator", "lift"]],
  ["info", ["info", "information"]],
];

/**
 * Detects amenity intent so the search box can route to the `amenities`
 * table instead of objects_fts. Token-level (with plural folding) so e.g.
 * "water lilies" does NOT trigger; water needs an explicit fountain bigram.
 */
export function amenityIntent(query: string): AmenityType | null {
  const toks = tokens(query).map((t) => t.replace(/s$/, ""));
  const has = (w: string) => toks.includes(w);
  for (const [type, words] of AMENITY_TOKENS) {
    if (words.some((w) => has(w.replace(/s$/, "")))) return type;
  }
  if (has("fountain") && (has("water") || has("drinking"))) return "water";
  return null;
}

/** Run autocomplete against a DB handle; empty input → empty result. */
export async function autocomplete(db: DbHandle, input: string): Promise<SearchRow[]> {
  const q = buildAutocompleteQuery(input);
  if (q === null) return [];
  return await db.all(q.sql, q.params);
}

/** Run the full (filtered, optionally relaxed) search against a DB handle. */
export async function fullSearch(
  db: DbHandle,
  input: string,
  filters: SearchFilters = {},
  opts: FullQueryOpts = {},
): Promise<SearchRow[]> {
  const q = buildFullQuery(input, filters, opts);
  if (q === null) return [];
  return await db.all(q.sql, q.params);
}
