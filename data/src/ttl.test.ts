/**
 * Integration test for the license-TTL mechanism (V&A's non-commercial
 * 28-day cap, Harvard's 14-day cap, …): computeExpiredMuseums
 * (shared/search.ts) feeding the real `AND o.museum NOT IN (...)` WHERE
 * clause against an actual schema-v2-shaped better-sqlite3 database with a
 * DOCTORED (artificially old) meta.builtAt — the same wiring
 * SqliteDataProvider.create() does in the app, exercised here without any
 * React Native/expo-sqlite test infrastructure (none exists in apps/mobile;
 * see ARCHITECTURE.md "Provenance & the license-TTL mechanism").
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  buildAccessionSearchQuery,
  buildAutocompleteQuery,
  buildFullQuery,
  computeExpiredMuseums,
} from "../../shared/search.ts";

interface Row {
  objectID: number;
  museum: string;
  title: string;
  accession: string;
}

/** Minimal schema-v2 objects + objects_fts + meta, enough for the WHERE-clause builders. */
function buildDb(rows: Row[], builtAt: string): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE objects (
      objectID INTEGER PRIMARY KEY, accession TEXT, title TEXT, artist TEXT,
      culture TEXT, period TEXT, classification TEXT, medium TEXT, tags TEXT,
      galleryNumber TEXT, site TEXT, rotation TEXT, isHighlight INTEGER,
      imageUrl TEXT, metadataDate TEXT, synonyms TEXT, museum TEXT, sourceId TEXT,
      locationNote TEXT, titleAlt TEXT, license TEXT, imageLicense TEXT
    );
    CREATE VIRTUAL TABLE objects_fts USING fts5(
      title, artist, culture, classification, medium, tags, synonyms,
      content='', tokenize='porter unicode61', prefix='2 3 4'
    );
    CREATE TABLE galleries (galleryNumber TEXT, title TEXT, floor TEXT, site TEXT,
      centroidLat REAL, centroidLon REAL, PRIMARY KEY (galleryNumber, site));
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const ins = db.prepare(`INSERT INTO objects VALUES (@objectID, @accession, @title, '', '', '', '', '', '',
    '1', 'test', 'permanent', 0, '', '', '', @museum, @accession, '', '', 'x', '')`);
  const insFts = db.prepare(`INSERT INTO objects_fts (rowid, title) VALUES (?, ?)`);
  for (const r of rows) {
    ins.run(r);
    insFts.run(r.objectID, r.title);
  }
  db.prepare("INSERT INTO meta VALUES ('builtAt', ?)").run(builtAt);
  return db;
}

const ROWS: Row[] = [
  { objectID: 1, museum: "met", title: "Sunflowers", accession: "1.1" },
  { objectID: 2, museum: "vanda", title: "Sunflower Vase", accession: "2.2" },
];

describe("license-TTL mechanism: computeExpiredMuseums -> real WHERE clause", () => {
  it("a fresh artifact (builtAt = now) hides nothing — vanda rows are searchable", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const db = buildDb(ROWS, new Date(now).toISOString());
    const museums = [{ id: "vanda", license: { ttlDays: 28 } }, { id: "met", license: {} }];
    const expired = computeExpiredMuseums(museums, "2026-07-05T00:00:00Z", now);
    expect(expired).toEqual([]);

    const q = buildFullQuery("sunflower", { expiredMuseums: expired })!;
    const rows = db.prepare(q.sql).all(...q.params) as { objectID: number }[];
    expect(rows.map((r) => r.objectID).sort()).toEqual([1, 2]);
    db.close();
  });

  it("a doctored 40-day-old builtAt expires vanda (ttlDays=28) — its rows vanish from every query", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const builtAt40dAgo = new Date(now - 40 * 86_400_000).toISOString();
    const db = buildDb(ROWS, builtAt40dAgo);
    const museums = [{ id: "vanda", license: { ttlDays: 28 } }, { id: "met", license: {} }];
    const expired = computeExpiredMuseums(museums, builtAt40dAgo, now);
    expect(expired).toEqual(["vanda"]);

    // Full search
    const fq = buildFullQuery("sunflower", { expiredMuseums: expired })!;
    const fullRows = db.prepare(fq.sql).all(...fq.params) as { objectID: number }[];
    expect(fullRows.map((r) => r.objectID)).toEqual([1]);

    // Autocomplete
    const aq = buildAutocompleteQuery("sunflower", undefined, expired)!;
    const acRows = db.prepare(aq.sql).all(...aq.params) as { objectID: number }[];
    expect(acRows.map((r) => r.objectID)).toEqual([1]);

    // Accession (digit) search
    const acc = buildAccessionSearchQuery("2.2", 8, undefined, expired);
    const accRows = acc ? (db.prepare(acc.sql).all(...acc.params) as { objectID: number }[]) : [];
    expect(accRows).toEqual([]); // the only accession match (2.2) belongs to the expired museum

    db.close();
  });

  it("a doctored 20-day-old builtAt does NOT yet expire vanda (still within ttlDays - 1)", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const builtAt20dAgo = new Date(now - 20 * 86_400_000).toISOString();
    const museums = [{ id: "vanda", license: { ttlDays: 28 } }];
    expect(computeExpiredMuseums(museums, builtAt20dAgo, now)).toEqual([]);
  });

  // Harvard's 14-day cap: a second, shorter TTL museum coexisting with V&A's
  // 28-day one, verifying the mechanism enforces each museum's own ttlDays
  // independently rather than a single fleet-wide constant.
  const ROWS_HARVARD: Row[] = [
    { objectID: 1, museum: "met", title: "Sunflowers", accession: "1.1" },
    { objectID: 3, museum: "harvard", title: "Self-Portrait Dedicated to Paul Gauguin", accession: "1951.65" },
  ];

  it("a doctored 13-day-old builtAt does NOT yet expire harvard (ttlDays=14, still within ttlDays - 1)", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const builtAt13dAgo = new Date(now - 13 * 86_400_000).toISOString();
    const db = buildDb(ROWS_HARVARD, builtAt13dAgo);
    const museums = [{ id: "harvard", license: { ttlDays: 14 } }, { id: "met", license: {} }];
    const expired = computeExpiredMuseums(museums, builtAt13dAgo, now);
    expect(expired).toEqual([]);

    const q = buildFullQuery("gauguin", { expiredMuseums: expired })!;
    const rows = db.prepare(q.sql).all(...q.params) as { objectID: number }[];
    expect(rows.map((r) => r.objectID)).toEqual([3]);
    db.close();
  });

  it("a doctored 14-day-old builtAt expires harvard (ttlDays=14) — its rows vanish from every query", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const builtAt14dAgo = new Date(now - 14 * 86_400_000).toISOString();
    const db = buildDb(ROWS_HARVARD, builtAt14dAgo);
    const museums = [{ id: "harvard", license: { ttlDays: 14 } }, { id: "met", license: {} }];
    const expired = computeExpiredMuseums(museums, builtAt14dAgo, now);
    expect(expired).toEqual(["harvard"]);

    const fq = buildFullQuery("gauguin", { expiredMuseums: expired })!;
    const fullRows = db.prepare(fq.sql).all(...fq.params) as { objectID: number }[];
    expect(fullRows).toEqual([]);

    const aq = buildAutocompleteQuery("gauguin", undefined, expired)!;
    const acRows = db.prepare(aq.sql).all(...aq.params) as { objectID: number }[];
    expect(acRows).toEqual([]);
    db.close();
  });

  it("independent TTLs: a 20-day-old artifact expires harvard (ttlDays=14) but NOT vanda (ttlDays=28)", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    const builtAt20dAgo = new Date(now - 20 * 86_400_000).toISOString();
    const museums = [
      { id: "vanda", license: { ttlDays: 28 } },
      { id: "harvard", license: { ttlDays: 14 } },
      { id: "met", license: {} },
    ];
    expect(computeExpiredMuseums(museums, builtAt20dAgo, now)).toEqual(["harvard"]);
  });
});
