import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  normalizeQuery,
  toPrefixMatch,
  relaxQuery,
  buildAutocompleteQuery,
  buildFullQuery,
  amenityIntent,
  autocomplete,
  fullSearch,
  type DbHandle,
  type SearchRow,
} from "./search.ts";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// ---------------------------------------------------------------- unit: pure builders

describe("normalizeQuery", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeQuery("  Washington,  Crossing!! the (Delaware) ")).toBe(
      "washington crossing the delaware",
    );
  });
  it("keeps unicode letters (diacritics handled by the FTS tokenizer)", () => {
    expect(normalizeQuery("Géricault")).toBe("géricault");
  });
  it("neutralizes FTS5 syntax characters", () => {
    expect(normalizeQuery('sword" OR objectID:*')).toBe("sword or objectid");
  });
});

describe("toPrefixMatch", () => {
  it("quotes and prefix-stars every token, implicit AND", () => {
    expect(toPrefixMatch("van gogh")).toBe('"van"* "gogh"*');
  });
  it("returns null for empty/whitespace/punctuation-only input", () => {
    expect(toPrefixMatch("")).toBeNull();
    expect(toPrefixMatch("  !?  ")).toBeNull();
  });
});

describe("relaxQuery", () => {
  it("drops stopwords and OR-joins quoted unstarred tokens", () => {
    expect(
      relaxQuery("that huge painting of washington crossing a river in a boat"),
    ).toBe('"huge" OR "painting" OR "washington" OR "crossing" OR "river" OR "boat"');
  });
  it("falls back to all tokens when everything is a stopword", () => {
    expect(relaxQuery("of the")).toBe('"of" OR "the"');
  });
  it("returns null on empty input", () => {
    expect(relaxQuery("  ")).toBeNull();
  });
});

describe("buildAutocompleteQuery", () => {
  it("builds weighted-bm25, highlight-boosted, gallery-joined, LIMIT 8 SQL", () => {
    const q = buildAutocompleteQuery("Monet")!;
    expect(q.params).toEqual(['"monet"*']);
    expect(q.sql).toContain("bm25(objects_fts, 10, 8, 3, 5, 2, 4, 1)");
    expect(q.sql).toContain("o.isHighlight * 2");
    expect(q.sql).toContain("LEFT JOIN galleries g");
    expect(q.sql).toContain("objects_fts MATCH ?");
    expect(q.sql).toContain("LIMIT 8");
  });
  it("returns null for empty input", () => {
    expect(buildAutocompleteQuery("")).toBeNull();
  });
});

describe("buildFullQuery", () => {
  it("appends site/floor/rotation/hasImage filters in order, optional LIMIT", () => {
    const q = buildFullQuery(
      "sword",
      { site: "fifthAve", floor: "2", rotation: "permanent", hasImage: true },
      { limit: 25 },
    )!;
    expect(q.params).toEqual(['"sword"*', "fifthAve", "2", "permanent", 25]);
    expect(q.sql).toContain("AND o.site = ?");
    expect(q.sql).toContain("AND g.floor = ?");
    expect(q.sql).toContain("AND o.rotation = ?");
    expect(q.sql).toContain("AND o.imageUrl <> ''");
    expect(q.sql).toContain("LIMIT ?");
  });
  it("has no LIMIT by default (All Results page)", () => {
    expect(buildFullQuery("sword")!.sql).not.toContain("LIMIT");
  });
  it("relaxed mode uses OR semantics", () => {
    const q = buildFullQuery("washington crossing delaware", {}, { relaxed: true })!;
    expect(q.params[0]).toBe('"washington" OR "crossing" OR "delaware"');
  });
});

describe("amenityIntent", () => {
  const table: Array<[string, string | null]> = [
    ["restroom", "restroom"],
    ["restrooms", "restroom"],
    ["where is the nearest toilet", "restroom"],
    ["bathroom", "restroom"],
    ["cafe", "dining"],
    ["where can i eat lunch", "dining"],
    ["coffee", "dining"],
    ["elevator", "elevator"],
    ["lift", "elevator"],
    ["water fountain", "water"],
    ["drinking fountain", "water"],
    ["information desk", "info"],
    ["water lilies", null], // must NOT misroute the Monet query
    ["monet", null],
    ["the fountain of youth painting", null],
    ["", null],
  ];
  for (const [q, want] of table) {
    it(`${JSON.stringify(q)} -> ${want}`, () => expect(amenityIntent(q)).toBe(want));
  }
});

// ------------------------------------------- integration-lite: in-memory fixture DB
// Validates the SQL actually executes against the B4 schema contract (FTS5
// external content, porter unicode61, prefix 2/3/4) using the 16 real
// planning-bench objects.

interface BenchObj {
  objectID: number;
  title: string;
  artist: string;
  medium: string;
  accession: string;
  gallery: string;
  dept: string;
  isHighlight: boolean;
  img: string;
}

function fixtureDb(): { db: DbHandle; raw: InstanceType<typeof Database> } {
  const objs: BenchObj[] = JSON.parse(
    readFileSync(p("../data/evals/planning-bench/objects.json"), "utf8"),
  );
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE objects(
      objectID INTEGER PRIMARY KEY, accession TEXT, title TEXT, artist TEXT,
      culture TEXT, period TEXT, classification TEXT, medium TEXT, tags TEXT,
      galleryNumber TEXT, site TEXT, rotation TEXT, isHighlight INTEGER,
      imageUrl TEXT, metadataDate TEXT, synonyms TEXT);
    CREATE VIRTUAL TABLE objects_fts USING fts5(
      title, artist, culture, classification, medium, tags, synonyms,
      content='objects', content_rowid='objectID',
      tokenize='porter unicode61', prefix='2 3 4');
    CREATE TABLE galleries(galleryNumber TEXT, site TEXT, floor TEXT,
      PRIMARY KEY(galleryNumber, site));
  `);
  const insObj = raw.prepare(
    `INSERT INTO objects(objectID, accession, title, artist, culture, period,
       classification, medium, tags, galleryNumber, site, rotation, isHighlight,
       imageUrl, metadataDate, synonyms)
     VALUES (?, ?, ?, ?, '', '', ?, ?, '', ?, 'fifthAve', 'permanent', ?, ?, '', '')`,
  );
  const insFts = raw.prepare(
    `INSERT INTO objects_fts(rowid, title, artist, culture, classification, medium, tags, synonyms)
     VALUES (?, ?, ?, '', ?, ?, '', '')`,
  );
  const insGal = raw.prepare(
    `INSERT OR IGNORE INTO galleries(galleryNumber, site, floor) VALUES (?, 'fifthAve', ?)`,
  );
  for (const o of objs) {
    insObj.run(o.objectID, o.accession, o.title, o.artist, o.dept, o.medium,
      o.gallery, o.isHighlight ? 1 : 0, o.img);
    insFts.run(o.objectID, o.title, o.artist, o.dept, o.medium);
    insGal.run(o.gallery, Number(o.gallery) >= 200 ? "2" : "1");
  }
  const db: DbHandle = {
    all: (sql, params) => raw.prepare(sql).all(...params) as SearchRow[],
  };
  return { db, raw };
}

describe("fixture DB (16 planning-bench objects, contract schema)", () => {
  const { db } = fixtureDb();

  it("autocomplete: exact title token ranks first, gallery floor joined", async () => {
    const rows = await autocomplete(db, "sphinx");
    expect(rows[0].objectID).toBe(544442);
    expect(rows[0].galleryNumber).toBe("131");
    expect(rows[0].floor).toBe("1");
  });

  it("autocomplete: prefix matching on partial tokens", async () => {
    const rows = await autocomplete(db, "washington cross");
    expect(rows[0].objectID).toBe(11417);
  });

  it("autocomplete: porter stemming (swords -> sword) via full search path", async () => {
    const rows = await fullSearch(db, "ceremonial maces");
    expect(rows.map((r) => r.objectID)).toContain(24423);
  });

  it("autocomplete: at most 8 rows, empty input -> empty", async () => {
    expect((await autocomplete(db, "a")).length).toBeLessThanOrEqual(8);
    expect(await autocomplete(db, "")).toEqual([]);
  });

  it("score is ascending (more negative = better) and highlights boosted", async () => {
    const rows = await fullSearch(db, "oil canvas"); // matches all paintings via medium
    for (let i = 1; i < rows.length; i++) expect(rows[i].score).toBeGreaterThanOrEqual(rows[i - 1].score);
    const hl = rows.findIndex((r) => r.isHighlight === 1);
    const non = rows.findIndex((r) => r.isHighlight === 0);
    expect(hl).toBeGreaterThanOrEqual(0);
    if (non >= 0) expect(hl).toBeLessThan(non); // same bm25 (identical medium), boost decides
  });

  it("filters: site excludes everything when no cloisters rows", async () => {
    expect(await fullSearch(db, "sphinx", { site: "cloisters" })).toEqual([]);
    expect((await fullSearch(db, "sphinx", { site: "fifthAve" })).length).toBeGreaterThan(0);
  });

  it("filters: floor + rotation + hasImage + limit execute", async () => {
    const rows = await fullSearch(
      db, "oil canvas",
      { floor: "2", rotation: "permanent", hasImage: true },
      { limit: 3 },
    );
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(r.floor).toBe("2");
  });

  it("relaxed query ranks Washington Crossing first for the J7 phrasing", async () => {
    const rows = await fullSearch(
      db, "that huge painting of washington crossing a river in a boat",
      {}, { relaxed: true, limit: 5 },
    );
    expect(rows[0].objectID).toBe(11417);
  });

  it("FTS special characters in user input cannot break the query", async () => {
    await expect(fullSearch(db, 'sphinx" OR title:* NEAR(')).resolves.toBeTruthy();
  });
});

// ------------------------------------------------- golden cases (50) — needs met.sqlite

interface GoldenCase {
  query: string;
  tier: "autocomplete" | "full" | "llm";
  expectObjectIDs?: number[];
  expectTitleContains?: string;
  expectArtistContains?: string;
  expectAmenity?: string;
  note?: string;
}

const goldens: GoldenCase[] = JSON.parse(
  readFileSync(p("../data/evals/search-cases.json"), "utf8"),
).cases;

function rowMatches(rows: SearchRow[], c: GoldenCase): boolean {
  return rows.some(
    (r) =>
      (c.expectObjectIDs?.includes(r.objectID) ?? false) ||
      (c.expectTitleContains !== undefined &&
        r.title.toLowerCase().includes(c.expectTitleContains.toLowerCase())) ||
      (c.expectArtistContains !== undefined &&
        r.artist.toLowerCase().includes(c.expectArtistContains.toLowerCase())),
  );
}

describe("golden cases: amenity intent (no DB needed)", () => {
  for (const c of goldens.filter((c) => c.expectAmenity)) {
    it(`${JSON.stringify(c.query)} -> ${c.expectAmenity}`, () => {
      expect(amenityIntent(c.query)).toBe(c.expectAmenity);
    });
  }
});

const DB_PATH = p("../data/met.sqlite");
const hasDb = existsSync(DB_PATH);

// The goldens target the full ~45.5k-object on-view catalog. While the
// objects snapshot is the documented partial set (Met API WAF throttling,
// see docs/DATA.md), pass rates are meaningless — skip until build-db has
// run against a (near-)complete snapshot. C4 measured 96% at full scale
// against an equivalent-schema 44,468-object DB (data/evals/reports/search-eval.md).
let dbObjectCount = 0;
if (hasDb) {
  const d = new Database(DB_PATH, { readonly: true });
  try {
    dbObjectCount = JSON.parse(
      (d.prepare("SELECT value FROM meta WHERE key='counts'").get() as { value: string }).value,
    ).objects;
  } finally {
    d.close();
  }
}
const fullDb = dbObjectCount >= 40_000;
if (hasDb && !fullDb) {
  console.log(
    `golden cases SKIPPED: data/met.sqlite holds ${dbObjectCount} objects (partial snapshot; full catalog ≈ 45.5k)`,
  );
}

describe.skipIf(!fullDb)("golden cases: against real data/met.sqlite", () => {
  it("runs all object goldens and reports pass rate per tier", async () => {
    const raw = new Database(DB_PATH, { readonly: true });
    const db: DbHandle = {
      all: (sql, params) => raw.prepare(sql).all(...params) as SearchRow[],
    };
    const stats: Record<string, { pass: number; total: number }> = {};
    const failures: string[] = [];
    for (const c of goldens) {
      if (c.expectAmenity) continue; // covered above, DB-free
      let rows: SearchRow[];
      if (c.tier === "autocomplete") rows = await autocomplete(db, c.query);
      else if (c.tier === "full") rows = await fullSearch(db, c.query, {}, { limit: 25 });
      else rows = await fullSearch(db, c.query, {}, { relaxed: true, limit: 25 });
      const ok = rowMatches(rows, c);
      const s = (stats[c.tier] ??= { pass: 0, total: 0 });
      s.total++;
      if (ok) s.pass++;
      else failures.push(`[${c.tier}] ${JSON.stringify(c.query)} — top: ${rows.slice(0, 3).map((r) => `${r.objectID} ${r.title}`).join(" | ") || "(no rows)"}`);
    }
    let pass = 0, total = 0;
    for (const [tier, s] of Object.entries(stats)) {
      pass += s.pass; total += s.total;
      console.log(`golden pass rate [${tier}]: ${s.pass}/${s.total} (${((100 * s.pass) / s.total).toFixed(0)}%)`);
    }
    console.log(`golden pass rate [overall]: ${pass}/${total} (${((100 * pass) / total).toFixed(0)}%)`);
    if (failures.length) console.log("failures:\n" + failures.join("\n"));
    // LLM-tier cases run here through the post-rewrite relaxed-FTS path only
    // (no Gemini); the rewrite itself is exercised by the server's Gate C eval.
    expect(pass / total).toBeGreaterThanOrEqual(0.7);
  });
});

if (!hasDb) {
  console.log(
    "search.test.ts: data/met.sqlite not found — golden-case integration skipped (pending B4 build-db). Unit + fixture tests still ran.",
  );
}
