/**
 * build-db: assemble data/met.sqlite — the single offline artifact every client
 * downloads — from the committed snapshots (no network):
 *
 *   snapshots/objects.json.gz   → objects + objects_fts (FTS5 external-content,
 *                                 porter unicode61, prefix 2/3/4, sync triggers)
 *   snapshots/galleries.geojson → galleries (centroids) + gzipped blob
 *   snapshots/amenities.geojson → amenities + gzipped blob
 *   snapshots/graph.json        → graph_nodes/graph_edges + per-floor rendering
 *                                 polylines blob (routes.geojson is 7 static
 *                                 showcase lines — unusable; polylines are
 *                                 derived from same-floor graph edges instead)
 *
 * Writes met.sqlite atomically (tmp + rename) and data/VERSION with
 * dataVersion = ISO build date + sha256 short hash of the four inputs.
 * Then verifies inline: sizes, real FTS queries, bm25 weighting, and the
 * objects↔galleries coverage join (orphans both ways).
 *
 * Usage: tsx src/build-db.ts
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP_DIR = path.join(DATA_DIR, "snapshots");
const DB_PATH = path.join(DATA_DIR, "met.sqlite");
const TMP_PATH = DB_PATH + ".tmp";
const VERSION_PATH = path.join(DATA_DIR, "VERSION");

interface ObjectRow {
  objectID: number;
  accession: string;
  title: string;
  artist: string;
  culture: string;
  period: string;
  classification: string;
  medium: string;
  tags: string;
  galleryNumber: string;
  site: string;
  rotation: string;
  isHighlight: boolean;
  imageUrl: string;
  metadataDate: string;
}

interface GraphNode {
  id: string;
  lat: number;
  lon: number;
  floor: number;
  site: string;
  gallery?: string;
  kind?: string;
  name?: string;
}

interface GraphEdge {
  a: string;
  b: string;
  len: number;
  kind: string;
  bearing?: number;
  room?: string;
}

type Ring = [number, number][];

interface Feature {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

/**
 * Area-weighted centroid of a GeoJSON Polygon/MultiPolygon via the shoelace
 * formula, computed relative to the first vertex — at raw coordinate magnitudes
 * the signed terms cancel catastrophically for small rooms (the graph pipeline
 * measured centroids km off without the local origin). Holes carry opposite
 * winding so their signed contribution subtracts automatically.
 */
function centroid(geometry: Feature["geometry"]): { lat: number; lon: number } {
  const polys: Ring[][] =
    geometry.type === "Polygon"
      ? [geometry.coordinates as Ring[]]
      : (geometry.coordinates as Ring[][]); // MultiPolygon
  const [ox, oy] = polys[0][0][0];
  let a2 = 0; // 2 × signed area
  let cx = 0;
  let cy = 0;
  let vx = 0; // vertex-mean fallback for degenerate (zero-area) geometry
  let vy = 0;
  let vn = 0;
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const x1 = ring[i][0] - ox;
        const y1 = ring[i][1] - oy;
        const x2 = ring[i + 1][0] - ox;
        const y2 = ring[i + 1][1] - oy;
        const cross = x1 * y2 - x2 * y1;
        a2 += cross;
        cx += (x1 + x2) * cross;
        cy += (y1 + y2) * cross;
        vx += x1;
        vy += y1;
        vn++;
      }
    }
  }
  if (Math.abs(a2) < 1e-18) return { lon: ox + vx / vn, lat: oy + vy / vn };
  return { lon: ox + cx / (3 * a2), lat: oy + cy / (3 * a2) };
}

function main(): void {
  // ---- load inputs ---------------------------------------------------------
  const objectsGz = fs.readFileSync(path.join(SNAP_DIR, "objects.json.gz"));
  const galleriesRaw = fs.readFileSync(path.join(SNAP_DIR, "galleries.geojson"));
  const amenitiesRaw = fs.readFileSync(path.join(SNAP_DIR, "amenities.geojson"));
  const graphRaw = fs.readFileSync(path.join(SNAP_DIR, "graph.json"));

  const objects: ObjectRow[] = JSON.parse(zlib.gunzipSync(objectsGz).toString("utf8"));
  const galleriesGeo: { features: Feature[] } = JSON.parse(galleriesRaw.toString("utf8"));
  const amenitiesGeo: { features: Feature[] } = JSON.parse(amenitiesRaw.toString("utf8"));
  const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = JSON.parse(graphRaw.toString("utf8"));

  const builtAt = new Date().toISOString();
  const hash = createHash("sha256");
  for (const buf of [objectsGz, galleriesRaw, amenitiesRaw, graphRaw]) hash.update(buf);
  const dataVersion = `${builtAt.slice(0, 10)}-${hash.digest("hex").slice(0, 8)}`;

  // ---- build ---------------------------------------------------------------
  fs.rmSync(TMP_PATH, { force: true });
  const db = new Database(TMP_PATH);
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = OFF");

  db.exec(`
    CREATE TABLE objects (
      objectID       INTEGER PRIMARY KEY,
      accession      TEXT NOT NULL,
      title          TEXT NOT NULL,
      artist         TEXT NOT NULL,
      culture        TEXT NOT NULL,
      period         TEXT NOT NULL,
      classification TEXT NOT NULL,
      medium         TEXT NOT NULL,
      tags           TEXT NOT NULL,
      galleryNumber  TEXT NOT NULL,
      site           TEXT NOT NULL,
      rotation       TEXT NOT NULL,
      isHighlight    INTEGER NOT NULL,
      imageUrl       TEXT NOT NULL,
      metadataDate   TEXT NOT NULL
    );
    CREATE INDEX objects_gallery ON objects(galleryNumber);

    CREATE VIRTUAL TABLE objects_fts USING fts5(
      title, artist, culture, classification, medium, tags,
      content=objects, content_rowid=objectID,
      tokenize='porter unicode61', prefix='2 3 4'
    );
    CREATE TRIGGER objects_ai AFTER INSERT ON objects BEGIN
      INSERT INTO objects_fts(rowid, title, artist, culture, classification, medium, tags)
      VALUES (new.objectID, new.title, new.artist, new.culture, new.classification, new.medium, new.tags);
    END;
    CREATE TRIGGER objects_ad AFTER DELETE ON objects BEGIN
      INSERT INTO objects_fts(objects_fts, rowid, title, artist, culture, classification, medium, tags)
      VALUES ('delete', old.objectID, old.title, old.artist, old.culture, old.classification, old.medium, old.tags);
    END;
    CREATE TRIGGER objects_au AFTER UPDATE ON objects BEGIN
      INSERT INTO objects_fts(objects_fts, rowid, title, artist, culture, classification, medium, tags)
      VALUES ('delete', old.objectID, old.title, old.artist, old.culture, old.classification, old.medium, old.tags);
      INSERT INTO objects_fts(rowid, title, artist, culture, classification, medium, tags)
      VALUES (new.objectID, new.title, new.artist, new.culture, new.classification, new.medium, new.tags);
    END;

    -- Schema below is the shared/search.ts contract: galleries PK is
    -- (galleryNumber, site); floor is the TEXT label clients display and
    -- filter on ("G", "1", "1M", "2", ...); amenities.type uses the
    -- search.ts amenity vocabulary ("info", not "information").
    CREATE TABLE galleries (
      galleryNumber TEXT NOT NULL,
      title         TEXT,
      floor         TEXT NOT NULL, -- label: "G", "1", "1M", "2", "3", "5"
      site          TEXT NOT NULL,
      centroidLat   REAL NOT NULL,
      centroidLon   REAL NOT NULL,
      PRIMARY KEY (galleryNumber, site)
    );

    CREATE TABLE amenities (
      id     INTEGER PRIMARY KEY,
      type   TEXT NOT NULL,
      name   TEXT,
      floor  TEXT NOT NULL, -- same label vocabulary as galleries.floor
      site   TEXT NOT NULL,
      lat    REAL NOT NULL,
      lon    REAL NOT NULL,
      closed INTEGER NOT NULL
    );

    CREATE TABLE graph_nodes (
      id      TEXT PRIMARY KEY,
      lat     REAL NOT NULL,
      lon     REAL NOT NULL,
      floor   REAL NOT NULL,
      site    TEXT NOT NULL,
      gallery TEXT,
      kind    TEXT,
      name    TEXT
    );
    CREATE TABLE graph_edges (
      a       TEXT NOT NULL,
      b       TEXT NOT NULL,
      len     REAL NOT NULL,
      kind    TEXT NOT NULL,
      bearing REAL,
      room    TEXT
    );
    CREATE INDEX graph_edges_a ON graph_edges(a);
    CREATE INDEX graph_edges_b ON graph_edges(b);

    CREATE TABLE blobs (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const insObject = db.prepare(
    `INSERT INTO objects VALUES (@objectID, @accession, @title, @artist, @culture, @period,
     @classification, @medium, @tags, @galleryNumber, @site, @rotation, @isHighlight,
     @imageUrl, @metadataDate)`,
  );
  db.transaction(() => {
    for (const o of objects) insObject.run({ ...o, isHighlight: o.isHighlight ? 1 : 0 });
  })();
  db.exec("INSERT INTO objects_fts(objects_fts) VALUES ('optimize')");

  // "Floor 1M" -> "1M"; the label form clients display and filter on.
  const floorLabel = (floorName: unknown): string =>
    String(floorName ?? "").replace(/^Floor\s+/, "");
  // Living Map kind -> shared/search.ts amenity type vocabulary.
  const amenityType = (kind: unknown): string =>
    kind === "information" ? "info" : String(kind ?? "");

  const galleryFeatures = galleriesGeo.features.filter((f) => f.properties.galleryNumber);
  const insGallery = db.prepare("INSERT INTO galleries VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const f of galleryFeatures) {
      const c = centroid(f.geometry);
      insGallery.run(
        f.properties.galleryNumber,
        f.properties.title ?? null,
        floorLabel(f.properties.floorName),
        f.properties.site,
        c.lat,
        c.lon,
      );
    }
  })();

  const insAmenity = db.prepare("INSERT INTO amenities VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    amenitiesGeo.features.forEach((f, i) => {
      const p = f.properties;
      insAmenity.run(i + 1, amenityType(p.kind), p.name ?? null, floorLabel(p.floorName), p.site, p.lat, p.lon, p.closed ? 1 : 0);
    });
  })();

  const insNode = db.prepare("INSERT INTO graph_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insEdge = db.prepare("INSERT INTO graph_edges VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const n of graph.nodes) {
      insNode.run(n.id, n.lat, n.lon, n.floor, n.site, n.gallery ?? null, n.kind ?? null, n.name ?? null);
    }
    for (const e of graph.edges) {
      insEdge.run(e.a, e.b, e.len, e.kind, e.bearing ?? null, e.room ?? null);
    }
  })();

  // Per-floor walking polylines for map rendering, derived from same-floor
  // graph edges (door/walk); clients filter by feature.properties.floor/site.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const polylines = {
    type: "FeatureCollection",
    features: graph.edges.flatMap((e) => {
      if (e.kind !== "walk" && e.kind !== "door") return [];
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b || a.floor !== b.floor) return [];
      return [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
          properties: { floor: a.floor, site: a.site, kind: e.kind },
        },
      ];
    }),
  };

  const insBlob = db.prepare("INSERT INTO blobs VALUES (?, ?)");
  insBlob.run("galleries.geojson", zlib.gzipSync(galleriesRaw, { level: 9 }));
  insBlob.run("amenities.geojson", zlib.gzipSync(amenitiesRaw, { level: 9 }));
  insBlob.run("routes.geojson", zlib.gzipSync(JSON.stringify(polylines), { level: 9 }));

  const counts = {
    objects: objects.length,
    galleries: galleryFeatures.length,
    amenities: amenitiesGeo.features.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
  };
  const insMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
  insMeta.run("dataVersion", dataVersion);
  insMeta.run("builtAt", builtAt);
  insMeta.run("counts", JSON.stringify(counts));

  db.pragma("journal_mode = DELETE"); // ship without a -journal side file
  db.exec("VACUUM");
  db.exec("ANALYZE");
  db.close();
  fs.renameSync(TMP_PATH, DB_PATH);
  fs.writeFileSync(VERSION_PATH, dataVersion + "\n");

  // ---- verify --------------------------------------------------------------
  console.log(`dataVersion ${dataVersion}`);
  console.log(`counts ${JSON.stringify(counts)}`);
  const bytes = fs.statSync(DB_PATH).size;
  const gzBytes = zlib.gzipSync(fs.readFileSync(DB_PATH), { level: 6 }).length;
  console.log(`met.sqlite ${(bytes / 1e6).toFixed(1)} MB raw, ${(gzBytes / 1e6).toFixed(1)} MB gzip`);

  const v = new Database(DB_PATH, { readonly: true });
  const search = v.prepare(`
    SELECT o.objectID, o.title, o.artist, o.galleryNumber, g.floor,
           round(bm25(objects_fts, 10, 8, 3, 5, 2, 4), 2) AS score
    FROM objects_fts
    JOIN objects o ON o.objectID = objects_fts.rowid
    LEFT JOIN galleries g ON g.galleryNumber = o.galleryNumber AND g.site = o.site
    WHERE objects_fts MATCH ?
    ORDER BY score LIMIT 5
  `);
  const count = v.prepare(
    "SELECT count(*) AS n FROM objects_fts WHERE objects_fts MATCH ?",
  );
  for (const q of ["pyram*", "monet*", "gold* AND sword*"]) {
    const n = (count.get(q) as { n: number }).n;
    console.log(`\nFTS '${q}' → ${n} hits`);
    for (const r of search.all(q) as Record<string, unknown>[]) {
      console.log(
        `  [${r.score}] #${r.objectID} "${r.title}" — ${r.artist || "(no artist)"} | gallery ${r.galleryNumber} floor ${r.floor ?? "?"}`,
      );
    }
  }

  const cov = v
    .prepare(`
      SELECT count(*) AS total,
             sum(EXISTS (SELECT 1 FROM galleries g
                         WHERE g.galleryNumber = o.galleryNumber AND g.site = o.site)) AS matched
      FROM objects o
    `)
    .get() as { total: number; matched: number };
  const orphanObjGalleries = v
    .prepare(`
      SELECT DISTINCT galleryNumber FROM objects
      WHERE galleryNumber NOT IN (SELECT galleryNumber FROM galleries) ORDER BY galleryNumber
    `)
    .all()
    .map((r) => (r as { galleryNumber: string }).galleryNumber);
  const orphanGalleries = v
    .prepare(`
      SELECT galleryNumber FROM galleries
      WHERE galleryNumber NOT IN (SELECT DISTINCT galleryNumber FROM objects) ORDER BY galleryNumber
    `)
    .all()
    .map((r) => (r as { galleryNumber: string }).galleryNumber);
  console.log(
    `\ncoverage: ${cov.matched}/${cov.total} objects (${((100 * cov.matched) / cov.total).toFixed(1)}%) have a galleries row`,
  );
  console.log(
    `orphan gallery numbers on objects (no polygon): ${orphanObjGalleries.length}${
      orphanObjGalleries.length ? " → " + orphanObjGalleries.slice(0, 20).join(", ") : ""
    }${orphanObjGalleries.length > 20 ? ", …" : ""}`,
  );
  console.log(`galleries with zero objects: ${orphanGalleries.length}`);
  v.close();
}

main();
