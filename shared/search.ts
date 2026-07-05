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
 *   vocab(id, term UNIQUE, df) + vocab_trigram — FTS5(term, content=vocab,
 *           tokenize='trigram', detail=column) — typo-correction vocabulary
 *           (see the fuzzy correction section below)
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
  /** Museum registry id ("met" | "aic" | …; schema v2 meta.museums). */
  museum?: string;
  /** Globally-unique site id ("fifthAve" | "cloisters" for the Met; schema v2 opens the set). */
  site?: string;
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
 * bm25 + highlight boost, gallery floor joined inline, top 8. `museum` scopes
 * to one museum registry id (schema v2 multi-museum artifacts; the ScopeChips
 * "AT {museum}" selection) — same WHERE-clause shape as the site filter in
 * buildFullQuery. Callers must feature-detect the column first (see
 * SqliteDataProvider) — this builder does not.
 */
export function buildAutocompleteQuery(input: string, museum?: string): BuiltQuery | null {
  const match = toPrefixMatch(input);
  if (match === null) return null;
  let sql = SELECT_CORE;
  const params: Array<string | number> = [match];
  if (museum) {
    sql += `\n  AND o.museum = ?`;
    params.push(museum);
  }
  sql += `\nORDER BY score\nLIMIT 8`;
  return { sql, params };
}

// ------------------------------------------------------------ fuzzy correction
//
// Two-stage vocabulary correction (standard search-as-you-type pattern), used
// ONLY when the exact prefix query returns zero rows — correct spellings never
// touch this code, so the fast path is byte-identical to before. Requires the
// vocab/vocab_trigram tables (build-db.ts):
//   vocab(id INTEGER PK, term TEXT UNIQUE, df INTEGER) — distinct searchable
//     tokens + multi-word artist names, diacritics folded
//   vocab_trigram — FTS5(term, content=vocab, tokenize='trigram', detail=column)
//
//   1. candidates: OR-of-trigrams query against vocab_trigram, using trigrams
//      of the misspelled token PLUS its adjacent-swap variants — a
//      transposition ("mnoet") shares zero trigrams with its target, but one
//      of its swap variants IS the target. bm25 over the OR ranks vocab terms
//      sharing more trigrams first; top FUZZY_CANDIDATES survive.
//   2. rerank: length-normalized Damerau-Levenshtein, taking the better of
//      whole-term distance and distance to the candidate's prefix of the
//      token's length (+0.05 so completed terms win ties) — "harlw" is 5 edits
//      from "harlequin" but 1 from its prefix "harle". Accept <=
//      FUZZY_MAX_NORM, order by distance then document frequency, keep
//      FUZZY_MAX_CORRECTIONS, OR them into the original prefix-AND query.
//
// A token with no acceptable correction gets one last chance as a missing-space
// compound ("eyeidol" -> "eye"* "idol"*: both halves must prefix-match the real
// index). If any token stays uncorrectable the whole query confidently returns
// nothing — that property bounds the false-positive rate on gibberish.
//
// All shipped runtimes are synchronous (better-sqlite3, sqlite-wasm oo1,
// expo-sqlite allSync), so the pipeline takes a sync runner.

export type RunSync = (
  sql: string,
  params: ReadonlyArray<string | number>,
) => unknown[];

/** Accept corrections within ~1 edit per 3 chars (normalized DL distance). */
export const FUZZY_MAX_NORM = 0.34;
/** Trigram candidates fetched before the edit-distance rerank. */
export const FUZZY_CANDIDATES = 50;
/** Corrections OR-expanded per misspelled token (second pass only). */
export const FUZZY_MAX_CORRECTIONS = 3;

/** Fold to the vocab form: lowercase + diacritics stripped (NFD, drop marks). */
export function foldDiacritics(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Damerau-Levenshtein distance (OSA variant: adjacent transposition = 1). */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Distinct trigrams of the token and its adjacent-swap variants. */
function fuzzyTrigrams(tok: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  };
  add(tok);
  for (let i = 0; i + 1 < tok.length; i++)
    add(tok.slice(0, i) + tok[i + 1] + tok[i] + tok.slice(i + 2));
  return [...out];
}

/** Trigram-overlap candidate query over vocab; null when the token is too short. */
export function buildFuzzyCandidatesQuery(token: string): BuiltQuery | null {
  const tg = fuzzyTrigrams(token);
  if (tg.length === 0) return null;
  return {
    sql: `SELECT v.term AS term, v.df AS df
FROM vocab_trigram t JOIN vocab v ON v.id = t.rowid
WHERE vocab_trigram MATCH ?
ORDER BY bm25(vocab_trigram)
LIMIT ${FUZZY_CANDIDATES}`,
    params: [tg.map((t) => `"${t}"`).join(" OR ")],
  };
}

export interface Correction {
  term: string;
  /** Raw length-normalized DL distance (the acceptance criterion). */
  s: number;
}

/**
 * Edit-distance rerank of trigram candidates → accepted corrections, best
 * first. A candidate scores as the best of (a) whole-term distance and (b)
 * distance to its prefix of the token's length or one more — the user may
 * have typed a typo'd PREFIX of the term ("harlw" ~ "harle", "anunci" ~
 * "annunci") — with +0.05 so a completed term wins ties; everything
 * normalized by the longer side. Acceptance uses the raw distance
 * (<= FUZZY_MAX_NORM); ORDERING subtracts a small document-frequency bonus
 * so near-ties resolve toward common catalog terms ("drgas" -> degas (107
 * docs) over durgas (4), "catana" -> katana over catalan).
 */
export function rankCorrections(
  token: string,
  candidates: ReadonlyArray<{ term: string; df: number }>,
): Correction[] {
  return candidates
    .map((c) => {
      let s = damerauLevenshtein(token, c.term) / Math.max(token.length, c.term.length);
      for (const len of [token.length, token.length + 1]) {
        if (c.term.length <= len) continue;
        const slice = c.term.slice(0, len);
        s = Math.min(s, damerauLevenshtein(token, slice) / Math.max(token.length, len) + 0.05);
      }
      return { term: c.term, s, rank: s - 0.03 * Math.log10(c.df + 1) };
    })
    .filter((c) => c.s <= FUZZY_MAX_NORM)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, FUZZY_MAX_CORRECTIONS)
    .map(({ term, s }) => ({ term, s }));
}

/** Does this token (prefix-starred) match anything in the real FTS index? */
function probeToken(run: RunSync, tok: string): boolean {
  return (
    run("SELECT 1 FROM objects_fts WHERE objects_fts MATCH ? LIMIT 1", [`"${tok}"*`]).length > 0
  );
}

/**
 * Missing-space compound rescue: find a split where both halves prefix-match
 * the index AND their conjunction matches at least one row ("stilllife" ->
 * `"still"* AND "life"*`). `minHalf` 3 = the confident pre-correction pass;
 * 2 = the last-resort pass (short particles like "el greco").
 */
function trySplit(run: RunSync, tok: string, minHalf: number): string | null {
  for (let i = minHalf; i <= tok.length - minHalf; i++) {
    const sub = `"${tok.slice(0, i)}"* AND "${tok.slice(i)}"*`;
    if (run("SELECT 1 FROM objects_fts WHERE objects_fts MATCH ? LIMIT 1", [sub]).length > 0)
      return `(${sub})`;
  }
  return null;
}

export interface FuzzyMatches {
  /** Best correction per misspelled token — run this first. */
  primary: string;
  /** OR-expanded alternates; null when no token has more than one. */
  expanded: string | null;
}

/**
 * Corrected FTS match expressions for a zero-result input, or null when no
 * confident correction exists. Per misspelled token: a compound split counts
 * as ONE edit (the missing space), so it scores 1/len on the same scale as
 * corrections — a strictly cheaper, index-validated split wins ("goldsword"
 * 0.11 beats goldwork 0.22), a tie goes to the correction ("monnet" -> monet,
 * not mon|net). Corrections are complete vocab terms — no prefix star, porter
 * covers morphology; multi-word corrections stay quoted phrases. A token with
 * neither a correction nor a split (>= 3-char halves; >= 2 as a last resort)
 * vetoes the whole query — gibberish stays empty, which bounds the
 * false-positive rate. Parts join with explicit AND: FTS5 only allows
 * implicit AND between plain phrases, not around parenthesized groups.
 */
export function fuzzyPrefixMatch(run: RunSync, input: string): FuzzyMatches | null {
  const toks = tokens(foldDiacritics(input));
  if (toks.length === 0) return null;
  let correctedAny = false;
  let expandedAny = false;
  const primary: string[] = [];
  const expanded: string[] = [];
  for (const tok of toks) {
    if (probeToken(run, tok)) {
      primary.push(`"${tok}"*`);
      expanded.push(`"${tok}"*`);
      continue;
    }
    correctedAny = true;
    const q = buildFuzzyCandidatesQuery(tok);
    const corrections = q
      ? rankCorrections(tok, run(q.sql, q.params) as Array<{ term: string; df: number }>)
      : [];
    const splitCheaper = corrections.length === 0 || 1 / tok.length < corrections[0].s;
    const split = splitCheaper && tok.length >= 6 ? trySplit(run, tok, 3) : null;
    if (split !== null) {
      primary.push(split);
      expanded.push(split);
      continue;
    }
    if (corrections.length > 0) {
      primary.push(`"${corrections[0].term}"`);
      if (corrections.length > 1) {
        expanded.push(`(${corrections.map((c) => `"${c.term}"`).join(" OR ")})`);
        expandedAny = true;
      } else expanded.push(`"${corrections[0].term}"`);
      continue;
    }
    const weak = tok.length >= 4 ? trySplit(run, tok, 2) : null;
    if (weak === null) return null;
    primary.push(weak);
    expanded.push(weak);
  }
  // nothing misspelled -> the conjunction is genuinely empty; stay empty
  if (!correctedAny) return null;
  return {
    primary: primary.join(" AND "),
    expanded: expandedAny ? expanded.join(" AND ") : null,
  };
}

/**
 * Client autocomplete entry: exact prefix query first (unchanged fast path);
 * on zero rows, retry with the best correction per misspelled token, and only
 * if THAT comes back empty, once more with the OR-expanded alternates — the
 * conservative pass keeps a strong correction ("osiriss" -> osiris) from
 * being flooded by a weaker sibling's shorter-title bm25 wins (osiride).
 * Top 8 either way. A met.sqlite predating the vocab tables degrades to the
 * old empty result (the fuzzy stage is try-caught) until the client
 * re-downloads the artifact. `museum` scopes both the exact and fuzzy passes
 * (see buildAutocompleteQuery).
 */
export function autocompleteFuzzy(run: RunSync, input: string, museum?: string): SearchRow[] {
  const q = buildAutocompleteQuery(input, museum);
  if (q === null) return [];
  const rows = run(q.sql, q.params) as SearchRow[];
  if (rows.length > 0) return rows;
  try {
    const m = fuzzyPrefixMatch(run, input);
    if (m === null) return [];
    let sql = SELECT_CORE;
    if (museum) sql += `\n  AND o.museum = ?`;
    sql += `\nORDER BY score\nLIMIT 8`;
    const primary = run(sql, museum ? [m.primary, museum] : [m.primary]) as SearchRow[];
    if (primary.length > 0 || m.expanded === null) return primary;
    return run(sql, museum ? [m.expanded, museum] : [m.expanded]) as SearchRow[];
  } catch {
    return [];
  }
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
  if (filters.museum) {
    sql += `\n  AND o.museum = ?`;
    params.push(filters.museum);
  }
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
export function buildGalleryPositionQuery(
  objectID: number,
  opts: { scopeByMuseum?: boolean } = {},
): BuiltQuery {
  // Room codes collide across museums ("241" is a Met gallery AND an AIC
  // gallery), so on schema-v2 artifacts every correlated subquery must stay
  // within the anchor object's museum. Callers pass scopeByMuseum after
  // feature-detecting the museum column (pre-v2 artifacts lack it).
  const scope = opts.scopeByMuseum ? (a: string) => ` AND ${a}.museum = o.museum` : () => "";
  return {
    sql: `SELECT
  (SELECT COUNT(*) FROM objects p
    WHERE p.galleryNumber = o.galleryNumber${scope("p")} AND ${precedes("p", "o")}) + 1 AS position,
  (SELECT COUNT(*) FROM objects t WHERE t.galleryNumber = o.galleryNumber${scope("t")}) AS total
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
export function buildGalleryNeighborsQuery(
  objectID: number,
  opts: { scopeByMuseum?: boolean } = {},
): BuiltQuery {
  // Same museum-scoping rule as buildGalleryPositionQuery (room codes collide
  // across museums; the J15 browse loop must never step into another museum).
  const scope = opts.scopeByMuseum ? (a: string) => ` AND ${a}.museum = o.museum` : () => "";
  return {
    sql: `SELECT
  COALESCE(
    (SELECT p.objectID FROM objects p
      WHERE p.galleryNumber = o.galleryNumber${scope("p")} AND ${precedes("p", "o")}
      ORDER BY p.isHighlight ASC, p.objectID DESC LIMIT 1),
    (SELECT l.objectID FROM objects l WHERE l.galleryNumber = o.galleryNumber${scope("l")}
      ORDER BY l.isHighlight ASC, l.objectID DESC LIMIT 1)
  ) AS prevObjectID,
  COALESCE(
    (SELECT n.objectID FROM objects n
      WHERE n.galleryNumber = o.galleryNumber${scope("n")} AND ${precedes("o", "n")}
      ORDER BY n.isHighlight DESC, n.objectID ASC LIMIT 1),
    (SELECT f.objectID FROM objects f WHERE f.galleryNumber = o.galleryNumber${scope("f")}
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
export function buildAccessionSearchQuery(
  input: string,
  limit = 8,
  museum?: string,
): BuiltQuery | null {
  const toks = tokens(input);
  if (toks.length === 0 || !toks.some((t) => /\d/.test(t))) return null;
  const esc = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${toks.map(esc).join("%")}%`;
  let sql = `SELECT o.objectID, o.title, o.artist, o.galleryNumber, o.site,
       g.floor AS floor, o.isHighlight, o.imageUrl, 0 AS score
FROM objects o
LEFT JOIN galleries g ON g.galleryNumber = o.galleryNumber AND g.site = o.site
WHERE o.accession LIKE ? ESCAPE '\\'`;
  const params: Array<string | number> = [pattern];
  if (museum) {
    sql += `\n  AND o.museum = ?`;
    params.push(museum);
  }
  sql += `\nORDER BY o.isHighlight DESC, o.objectID\nLIMIT ?`;
  params.push(limit);
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
