// Golden-case runner against an arbitrary met.sqlite (argv[2]; defaults to data/met.sqlite)
// and an arbitrary case file (argv[3]; defaults to the Met's search-cases.json — per-museum
// case files live at data/evals/{museumId}/search-cases.json).
// Same logic as the vitest integration block in shared/search.test.ts — use this when the
// DB under test is not at data/met.sqlite (e.g. the C4 full-scale eval DB in /tmp).
// Run with Node >= 24 (native type stripping resolves the shared/search.ts import).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { autocomplete, autocompleteFuzzy, fullSearch, amenityIntent } = await import(
  p("../../shared/search.ts")
);
const Database = createRequire(p("../package.json"))("better-sqlite3");

const DB_PATH = process.argv[2] ?? p("../met.sqlite");
const CASES_PATH = process.argv[3] ?? p("./search-cases.json");
const raw = new Database(DB_PATH, { readonly: true });
const db = { all: (sql, params) => raw.prepare(sql).all(...params) };

// Each museum's goldens run as THAT museum's visitor: the production search
// always ranks with the active venue's museum (ACTIVE_MUSEUM_BOOST in
// shared/search.ts), so the eval mirrors it. Inferred from the cases path
// (data/evals/{museumId}/search-cases.json; the Met's file sits at the root).
// argv[4] overrides. Pre-v2 artifacts (no objects.museum column) get no boost.
const inferredMuseum = /evals[\\/]([a-z]+)[\\/]search-cases\.json$/.exec(CASES_PATH)?.[1] ?? "met";
const hasMuseumCol =
  raw.prepare(`SELECT count(*) AS n FROM pragma_table_info('objects') WHERE name = 'museum'`).get()
    .n > 0;
const ACTIVE = hasMuseumCol ? (process.argv[4] ?? inferredMuseum) : undefined;

const goldens = JSON.parse(readFileSync(CASES_PATH, "utf8")).cases;

const matches = (rows, c) =>
  rows.some(
    (r) =>
      (c.expectObjectIDs?.includes(r.objectID) ?? false) ||
      (c.expectTitleContains !== undefined &&
        // titleAlt is the English display/search title for translateFrom
        // museums (Louvre FR, Rijksmuseum NL) — an English query legitimately
        // lands on it rather than the source-language title.
        `${r.title}\n${r.titleAlt ?? ""}`
          .toLowerCase()
          .includes(c.expectTitleContains.toLowerCase())) ||
      (c.expectArtistContains !== undefined &&
        r.artist.toLowerCase().includes(c.expectArtistContains.toLowerCase())),
  );

const stats = {};
const failures = [];
for (const c of goldens) {
  let ok, rows = [];
  if (c.expectAmenity) {
    ok = amenityIntent(c.query) === c.expectAmenity;
  } else if (c.tier === "autocomplete") {
    rows = await autocomplete(db, c.query, ACTIVE);
    // Production falls back to trigram typo correction on zero rows
    // (SqliteDataProvider.searchAutocomplete → autocompleteFuzzy) — mirror it.
    if (rows.length === 0)
      rows = autocompleteFuzzy(
        (sql, params) => raw.prepare(sql).all(...params),
        c.query,
        undefined,
        undefined,
        ACTIVE,
      );
    ok = matches(rows, c);
  } else if (c.tier === "full") {
    rows = await fullSearch(db, c.query, {}, { limit: 25, activeMuseum: ACTIVE });
    ok = matches(rows, c);
  } else {
    rows = await fullSearch(db, c.query, {}, { relaxed: true, limit: 25, activeMuseum: ACTIVE });
    ok = matches(rows, c);
  }
  const s = (stats[c.tier] ??= { pass: 0, total: 0 });
  s.total++;
  if (ok) s.pass++;
  else
    failures.push(
      `[${c.tier}] ${JSON.stringify(c.query)}\n    top: ${rows.slice(0, 5).map((r) => `${r.objectID} "${r.title}" (${r.artist})`).join(" | ") || "(no rows)"}`,
    );
}
let pass = 0, total = 0;
for (const [tier, s] of Object.entries(stats)) {
  pass += s.pass; total += s.total;
  console.log(`[${tier}] ${s.pass}/${s.total} (${((100 * s.pass) / s.total).toFixed(0)}%)`);
}
console.log(`[overall] ${pass}/${total} (${((100 * pass) / total).toFixed(0)}%)`);
if (failures.length) console.log("\nFAILURES:\n" + failures.join("\n"));
