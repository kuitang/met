/**
 * Unit tests for the pure metric functions in museums-audit.ts, against a
 * tiny in-memory schema-v2-shaped fixture (same minimal-columns approach as
 * ttl.test.ts) — no dependency on the real data/met.sqlite artifact.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  computeChurn,
  duplicateClusters,
  emptyTitlePct,
  fillRates,
  galleryTableSiteViolations,
  licenseEmptyCount,
  licenseHistogram,
  objectGalleryJoin,
  objectIdCollisions,
  objectSiteViolations,
  roomLabelCoverage,
  rowsPerGallery,
  sourceIdDuplicateCount,
  titleAltCoveragePct,
  ttlMetaViolations,
  type MuseumInfoLike,
} from "./museums-audit.ts";

type DB = InstanceType<typeof Database>;

interface Row {
  objectID: number;
  museum: string;
  sourceId: string;
  title: string;
  artist?: string;
  period?: string;
  classification?: string;
  medium?: string;
  tags?: string;
  imageUrl?: string;
  imageLicense?: string;
  locationNote?: string;
  titleAlt?: string;
  license?: string;
  galleryNumber: string;
  site: string;
}

function buildDb(rows: Row[]): DB {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE objects (
      objectID INTEGER PRIMARY KEY, accession TEXT, title TEXT NOT NULL, artist TEXT NOT NULL,
      culture TEXT, period TEXT NOT NULL, classification TEXT NOT NULL, medium TEXT NOT NULL,
      tags TEXT NOT NULL, galleryNumber TEXT NOT NULL, site TEXT NOT NULL, rotation TEXT,
      isHighlight INTEGER, imageUrl TEXT NOT NULL, metadataDate TEXT, synonyms TEXT,
      museum TEXT NOT NULL, sourceId TEXT NOT NULL, locationNote TEXT NOT NULL,
      titleAlt TEXT NOT NULL, license TEXT NOT NULL, imageLicense TEXT NOT NULL
    );
    CREATE TABLE galleries (
      galleryNumber TEXT NOT NULL, title TEXT, floor TEXT, site TEXT NOT NULL,
      centroidLat REAL, centroidLon REAL, PRIMARY KEY (galleryNumber, site)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ins = db.prepare(`
    INSERT INTO objects VALUES (@objectID, '', @title, @artist, '', @period, @classification, @medium,
      @tags, @galleryNumber, @site, 'permanent', 0, @imageUrl, '', '', @museum, @sourceId,
      @locationNote, @titleAlt, @license, @imageLicense)
  `);
  for (const r of rows) {
    ins.run({
      objectID: r.objectID,
      museum: r.museum,
      sourceId: r.sourceId,
      title: r.title,
      artist: r.artist ?? "",
      period: r.period ?? "",
      classification: r.classification ?? "",
      medium: r.medium ?? "",
      tags: r.tags ?? "",
      imageUrl: r.imageUrl ?? "",
      imageLicense: r.imageLicense ?? "",
      locationNote: r.locationNote ?? "",
      titleAlt: r.titleAlt ?? "",
      license: r.license ?? "CC0-1.0",
      galleryNumber: r.galleryNumber,
      site: r.site,
    });
  }
  return db;
}

function addGallery(db: DB, galleryNumber: string, site: string, title: string | null = "Room", floor: string | null = "1"): void {
  db.prepare(`INSERT INTO galleries VALUES (?, ?, ?, ?, NULL, NULL)`).run(galleryNumber, title, floor, site);
}

const ROWS: Row[] = [
  {
    objectID: 1,
    museum: "test",
    sourceId: "a",
    title: "Vase",
    artist: "Jane Doe",
    period: "1800s",
    classification: "Ceramics",
    medium: "Clay",
    tags: "pottery",
    imageUrl: "https://x/1.jpg",
    imageLicense: "CC0-1.0",
    galleryNumber: "101",
    site: "testsite",
  },
  {
    objectID: 2,
    museum: "test",
    sourceId: "b",
    title: "Bowl",
    galleryNumber: "101",
    site: "testsite",
  },
  {
    objectID: 3,
    museum: "test",
    sourceId: "c",
    title: "",
    galleryNumber: "999", // no matching galleries row — orphan
    site: "testsite",
  },
];

describe("fillRates", () => {
  it("computes per-field non-empty percentages", () => {
    const db = buildDb(ROWS);
    const fr = fillRates(db, "test");
    expect(fr.n).toBe(3);
    expect(fr.artistPct).toBeCloseTo(33.33, 1); // only row 1
    expect(fr.imagePct).toBeCloseTo(33.33, 1);
    expect(fr.imageLicensedPct).toBeCloseTo(33.33, 1);
    db.close();
  });

  it("returns all-zero rates for a museum with no rows", () => {
    const db = buildDb(ROWS);
    const fr = fillRates(db, "nonexistent");
    expect(fr).toEqual({
      n: 0,
      artistPct: 0,
      periodPct: 0,
      classificationPct: 0,
      mediumPct: 0,
      tagsPct: 0,
      imagePct: 0,
      imageLicensedPct: 0,
      locationNotePct: 0,
    });
    db.close();
  });
});

describe("roomLabelCoverage", () => {
  it("counts titled/floored galleries for the given sites only", () => {
    const db = buildDb(ROWS);
    addGallery(db, "101", "testsite", "Ceramics Wing", "1");
    addGallery(db, "102", "testsite", null, null); // untitled, unfloored
    addGallery(db, "5", "othersite", "Other Wing", "2"); // different site — excluded
    const cov = roomLabelCoverage(db, ["testsite"]);
    expect(cov.total).toBe(2);
    expect(cov.titled).toBe(1);
    expect(cov.floored).toBe(1);
    expect(cov.titledPct).toBeCloseTo(50, 5);
    db.close();
  });

  it("returns zeros for an empty site list", () => {
    const db = buildDb(ROWS);
    expect(roomLabelCoverage(db, [])).toEqual({ total: 0, titled: 0, floored: 0, titledPct: 0, flooredPct: 0 });
    db.close();
  });
});

describe("objectGalleryJoin", () => {
  it("reports the site-scoped join rate, flagging the orphan gallery number", () => {
    const db = buildDb(ROWS);
    addGallery(db, "101", "testsite");
    const join = objectGalleryJoin(db, "test");
    expect(join.total).toBe(3);
    expect(join.matched).toBe(2); // rows 1 & 2 join gallery 101; row 3 (gallery 999) is orphaned
    expect(join.pct).toBeCloseTo((2 / 3) * 100, 5);
    db.close();
  });

  it("site-scoping matters: a same-numbered gallery on a different site does not count as a match", () => {
    const db = buildDb(ROWS);
    addGallery(db, "101", "othersite"); // wrong site — must NOT satisfy the join
    const join = objectGalleryJoin(db, "test");
    expect(join.matched).toBe(0);
    db.close();
  });
});

describe("structural invariant helpers", () => {
  it("objectIdCollisions is empty when objectID is a real primary key", () => {
    const db = buildDb(ROWS);
    expect(objectIdCollisions(db)).toEqual([]);
    db.close();
  });

  it("sourceIdDuplicateCount flags repeated (museum, sourceId) pairs", () => {
    const db = buildDb(ROWS);
    // Fabricate a duplicate sourceId under a different objectID (allowed since
    // objectID is the PK, but (museum, sourceId) should be unique in a real build).
    db.prepare(
      `INSERT INTO objects VALUES (99, '', 't', '', '', '', '', '', '', '101', 'testsite', 'permanent', 0, '', '', '', 'test', 'a', '', '', 'CC0-1.0', '')`,
    ).run();
    expect(sourceIdDuplicateCount(db, "test")).toBe(1);
    expect(sourceIdDuplicateCount(db, "other-museum")).toBe(0);
    db.close();
  });

  it("objectSiteViolations flags site values outside the museum's registered sites", () => {
    const db = buildDb(ROWS);
    expect(objectSiteViolations(db, "test", new Set(["testsite"]))).toEqual([]);
    expect(objectSiteViolations(db, "test", new Set(["some-other-site"]))).toEqual(["testsite"]);
    db.close();
  });

  it("galleryTableSiteViolations checks galleries.site against the full registry (no museum column)", () => {
    const db = buildDb(ROWS);
    addGallery(db, "101", "testsite");
    addGallery(db, "5", "rogue-site");
    expect(galleryTableSiteViolations(db, new Set(["testsite"]))).toEqual(["rogue-site"]);
    db.close();
  });

  it("licenseEmptyCount counts objects with an empty license string", () => {
    const db = buildDb(ROWS.map((r) => ({ ...r, license: r.objectID === 3 ? "" : "CC0-1.0" })));
    expect(licenseEmptyCount(db, "test")).toBe(1);
    db.close();
  });

  it("ttlMetaViolations flags TTL-marked license text without ttlDays, and vice versa", () => {
    const good: MuseumInfoLike[] = [
      { id: "clean", license: { text: "CC0-1.0" } },
      { id: "ttl-ok", license: { text: "vanda-nc-ttl28", ttlDays: 28 } },
    ];
    expect(ttlMetaViolations(good)).toEqual([]);

    const badMissing: MuseumInfoLike[] = [{ id: "ttl-missing", license: { text: "vanda-nc-ttl28" } }];
    expect(ttlMetaViolations(badMissing)).toEqual(["ttl-missing"]);

    const badExtra: MuseumInfoLike[] = [{ id: "ttl-unexpected", license: { text: "CC0-1.0", ttlDays: 7 } }];
    expect(ttlMetaViolations(badExtra)).toEqual(["ttl-unexpected"]);
  });
});

describe("distribution sanity helpers", () => {
  it("duplicateClusters finds (title, artist) groups above the threshold", () => {
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
      objectID: i + 1,
      museum: "test",
      sourceId: String(i),
      title: "Dish",
      artist: "Unknown",
      galleryNumber: "1",
      site: "testsite",
    }));
    const db = buildDb(rows);
    const clusters = duplicateClusters(db, "test", 20);
    expect(clusters).toEqual([{ title: "Dish", artist: "Unknown", n: 25 }]);
    expect(duplicateClusters(db, "test", 30)).toEqual([]);
    db.close();
  });

  it("rowsPerGallery computes p50/p95/max over per-gallery object counts", () => {
    const rows: Row[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        objectID: i + 1,
        museum: "test",
        sourceId: `a${i}`,
        title: "x",
        galleryNumber: "1",
        site: "s",
      })),
      { objectID: 100, museum: "test", sourceId: "b0", title: "x", galleryNumber: "2", site: "s" },
    ];
    const db = buildDb(rows);
    const rpg = rowsPerGallery(db, "test");
    expect(rpg.galleryCount).toBe(2);
    expect(rpg.max).toBe(10);
    expect(rpg.p50).toBe(10); // sorted [1, 10]; p50 index floor(2*0.5)=1 -> 10
    db.close();
  });

  it("emptyTitlePct and titleAltCoveragePct compute simple percentages", () => {
    const db = buildDb(ROWS);
    expect(emptyTitlePct(db, "test")).toBeCloseTo(100 / 3, 5); // row 3 has title ''
    const withAlt = buildDb(ROWS.map((r) => ({ ...r, titleAlt: r.objectID === 1 ? "Alt Title" : "" })));
    expect(titleAltCoveragePct(withAlt, "test")).toBeCloseTo(100 / 3, 5);
    db.close();
  });

  it("licenseHistogram groups by (license, imageLicense)", () => {
    const db = buildDb(
      ROWS.map((r) => ({ ...r, license: "CC0-1.0", imageLicense: r.objectID === 1 ? "CC0-1.0" : "" })),
    );
    const hist = licenseHistogram(db, "test");
    expect(hist).toEqual(
      expect.arrayContaining([
        { license: "CC0-1.0", imageLicense: "CC0-1.0", n: 1 },
        { license: "CC0-1.0", imageLicense: "", n: 2 },
      ]),
    );
    db.close();
  });
});

describe("computeChurn", () => {
  it("counts added, removed, and moved-room rows keyed on (museum, sourceId)", () => {
    const prev = buildDb([
      { objectID: 1, museum: "test", sourceId: "a", title: "x", galleryNumber: "1", site: "s" },
      { objectID: 2, museum: "test", sourceId: "b", title: "x", galleryNumber: "2", site: "s" },
      { objectID: 3, museum: "test", sourceId: "c", title: "x", galleryNumber: "3", site: "s" }, // removed in curr
    ]);
    const curr = buildDb([
      { objectID: 1, museum: "test", sourceId: "a", title: "x", galleryNumber: "1", site: "s" }, // unchanged
      { objectID: 2, museum: "test", sourceId: "b", title: "x", galleryNumber: "9", site: "s" }, // moved room
      { objectID: 4, museum: "test", sourceId: "d", title: "x", galleryNumber: "1", site: "s" }, // added
    ]);
    const churn = computeChurn(prev, curr, "test");
    expect(churn).not.toBeNull();
    expect(churn!.matched).toBe(2); // a and b matched by sourceId
    expect(churn!.added).toBe(1); // d
    expect(churn!.removed).toBe(1); // c
    expect(churn!.movedRooms).toBe(1); // b moved from gallery 2 -> 9
    expect(churn!.addedPct).toBeCloseTo((1 / 3) * 100, 5); // baseline = prev count (3)
    expect(churn!.removedPct).toBeCloseTo((1 / 3) * 100, 5);
    expect(churn!.movedPct).toBeCloseTo(50, 5); // 1 of 2 matched moved
    prev.close();
    curr.close();
  });

  it("returns null when either database predates schema v2 (no museum/sourceId columns)", () => {
    const v1 = new Database(":memory:");
    v1.exec(`CREATE TABLE objects (objectID INTEGER PRIMARY KEY, galleryNumber TEXT, site TEXT)`);
    const v2 = buildDb(ROWS);
    expect(computeChurn(v1, v2, "test")).toBeNull();
    expect(computeChurn(v2, v1, "test")).toBeNull();
    v1.close();
    v2.close();
  });
});
