/**
 * Client-side search core for Met Navigator. Platform-neutral: no expo/node
 * imports. Callers pass a minimal DB handle; on native/web that is expo-sqlite
 * (`getAllAsync`), on the server and in tests it is better-sqlite3.
 *
 * Expected met.sqlite schema (the B4 build-db contract this module queries):
 *   objects(objectID INTEGER PRIMARY KEY, accession, title, artist, culture,
 *           period, classification, medium, tags, galleryNumber, site,
 *           rotation, isHighlight INTEGER 0/1, imageUrl, metadataDate)
 *   objects_fts — FTS5(title, artist, culture, classification, medium, tags,
 *           content='objects', content_rowid='objectID',
 *           tokenize='porter unicode61', prefix='2 3 4')
 *   galleries(galleryNumber, site, floor, ...) — PK (galleryNumber, site)
 *   amenities(..., type IN ('restroom','dining','elevator','water','info'), ...)
 *
 * bm25 column weights (title, artist, culture, classification, medium, tags)
 * = (10, 8, 3, 5, 2, 4). SQLite bm25() returns NEGATIVE numbers where more
 * negative = better match, so `score` is ordered ASC and highlights get a
 * constant subtracted as a boost.
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

const BM25 = "bm25(objects_fts, 10, 8, 3, 5, 2, 4)";
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
