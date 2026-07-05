/**
 * build-db: assemble data/met.sqlite — the single offline artifact every client
 * downloads — by MERGING every registry museum's snapshots (no network).
 * (The filename "met.sqlite" is a frozen infra identifier, like the npm
 * package name — the artifact has been multi-museum since schema v2.)
 *
 * Per museum (data/snapshots for the Met, data/museums/{id}/snapshots else):
 *   objects.json.gz    → objects + objects_fts rows
 *   synonyms.json      → (optional) LLM synonym expansion, FTS-indexed
 *   galleries.geojson  → galleries (centroids) — museums WITH geometry
 *   galleries.json     → gallery labels/floors — museums WITHOUT geometry
 *                        (else galleries are synthesized from distinct
 *                        object galleryNumbers with NULL title/floor)
 *   amenities.geojson / graph.json → amenities, routing graph (optional)
 *
 * Schema v2 (multi-museum, backward-compatible for readers):
 *   - objects gains museum, sourceId, locationNote, titleAlt, license,
 *     imageLicense (TEXT NOT NULL, '' defaults; license from the registry).
 *   - objects_fts is CONTENTLESS (content='') with explicit inserts: the
 *     indexed title is "title titleAlt" so bilingual titles match at full
 *     weight while `objects.title` stays the display form. Same 7 columns,
 *     tokenizer, prefixes, and bm25 weight positions as v1 — shipped clients'
 *     SQL is unchanged (they only read rowid + bm25 + objects.*).
 *   - objectID: Met keeps native ids; other museums get a 48-bit
 *     sha256("{museum}/{sourceId}") id (collision-asserted at build).
 *   - galleries.floor/centroidLat/centroidLon are nullable (label-only museums).
 *   - graph node ids are prefixed "{museum}:" for non-Met museums.
 *   - meta.museums = registry entries + per-museum counts/fetchedAt;
 *     meta.schemaVersion = 2.
 *
 * Writes met.sqlite atomically (tmp + rename) and data/VERSION with
 * dataVersion = ISO build date + sha256 short hash of all inputs. Then
 * verifies inline: real FTS queries, bm25 weighting, per-museum coverage.
 *
 * Usage: tsx src/build-db.ts
 *   MET_DATA_DIR=<dir> overrides the data root (Met snapshots at
 *   $MET_DATA_DIR/snapshots, other museums at $MET_DATA_DIR/museums/{id}/
 *   snapshots, met.sqlite + VERSION written to $MET_DATA_DIR) — used by the
 *   nightly job's stage dir.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { MUSEUMS, type MuseumInfo } from "./sources/registry.ts";
import type { GalleryLabelRow, ObjectRow } from "./sources/types.ts";

const DATA_DIR = process.env.MET_DATA_DIR
  ? path.resolve(process.env.MET_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(DATA_DIR, "met.sqlite");
const TMP_PATH = DB_PATH + ".tmp";
const VERSION_PATH = path.join(DATA_DIR, "VERSION");

const snapDir = (id: string): string =>
  id === "met" ? path.join(DATA_DIR, "snapshots") : path.join(DATA_DIR, "museums", id, "snapshots");

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

interface Synonyms {
  vocab: Record<string, string>;
  titles: Record<string, string>;
}

/** Everything loaded from one museum's snapshot dir. */
interface MuseumInputs {
  info: MuseumInfo;
  objects: ObjectRow[];
  synonyms: Synonyms;
  galleriesGeo: { features: Feature[] } | null;
  galleryLabels: GalleryLabelRow[] | null;
  amenitiesGeo: { features: Feature[] } | null;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  fetchedAt: string | null; // objects-meta.json fetchedAt — staleness UI
  rawBuffers: Buffer[]; // dataVersion hash inputs
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

/** 48-bit objectID from museum-scoped sourceId (Met keeps native numeric ids). */
export function hashObjectID(museum: string, sourceId: string): number {
  const h = createHash("sha256").update(`${museum}/${sourceId}`).digest();
  return h.readUIntBE(0, 6); // 48 bits — safe integer, collision-asserted at build
}

function loadMuseum(info: MuseumInfo): MuseumInputs | null {
  const dir = snapDir(info.id);
  const objectsPath = path.join(dir, "objects.json.gz");
  if (!fs.existsSync(objectsPath)) {
    if (info.id === "met") throw new Error("Met snapshot missing: " + objectsPath);
    console.warn(`build-db: no snapshot for ${info.id} (${objectsPath}) — skipping museum`);
    return null;
  }
  const rawBuffers: Buffer[] = [];
  const read = (name: string): Buffer | null => {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    rawBuffers.push(buf);
    return buf;
  };

  const objectsGz = read("objects.json.gz")!;
  const synonymsRaw = read("synonyms.json");
  const galleriesGeoRaw = read("galleries.geojson");
  const galleryLabelsRaw = read("galleries.json");
  const amenitiesRaw = read("amenities.geojson");
  const graphRaw = read("graph.json");
  let fetchedAt: string | null = null;
  try {
    fetchedAt =
      (JSON.parse(fs.readFileSync(path.join(dir, "objects-meta.json"), "utf8")) as {
        fetchedAt?: string;
      }).fetchedAt ?? null;
  } catch {
    /* objects-meta.json is informational */
  }

  return {
    info,
    objects: JSON.parse(zlib.gunzipSync(objectsGz).toString("utf8")),
    synonyms: synonymsRaw
      ? JSON.parse(synonymsRaw.toString("utf8"))
      : { vocab: {}, titles: {} },
    galleriesGeo: galleriesGeoRaw ? JSON.parse(galleriesGeoRaw.toString("utf8")) : null,
    galleryLabels: galleryLabelsRaw ? JSON.parse(galleryLabelsRaw.toString("utf8")) : null,
    amenitiesGeo: amenitiesRaw ? JSON.parse(amenitiesRaw.toString("utf8")) : null,
    graph: graphRaw ? JSON.parse(graphRaw.toString("utf8")) : null,
    fetchedAt,
    rawBuffers,
  };
}

function main(): void {
  // ---- load every museum's inputs ------------------------------------------
  const museums = MUSEUMS.map(loadMuseum).filter((m): m is MuseumInputs => m !== null);

  const builtAt = new Date().toISOString();
  const hash = createHash("sha256");
  for (const m of museums) for (const buf of m.rawBuffers) hash.update(buf);
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
      metadataDate   TEXT NOT NULL,
      synonyms       TEXT NOT NULL,
      -- schema v2 (multi-museum)
      museum         TEXT NOT NULL,             -- registry museum id
      sourceId       TEXT NOT NULL,             -- museum-native record id
      locationNote   TEXT NOT NULL DEFAULT '',  -- sub-room detail (V&A case …)
      titleAlt       TEXT NOT NULL DEFAULT '',  -- English display title when title is not English
      license        TEXT NOT NULL,             -- per-record text license
      imageLicense   TEXT NOT NULL DEFAULT ''   -- '' = no image derivatives allowed
    );
    CREATE INDEX objects_gallery ON objects(galleryNumber);
    CREATE INDEX objects_museum ON objects(museum);
    CREATE UNIQUE INDEX objects_source ON objects(museum, sourceId);

    -- CONTENTLESS FTS (schema v2): rows are inserted explicitly so the INDEXED
    -- text can differ from the DISPLAY text (bilingual titles index
    -- "title titleAlt" at full title weight). Same columns/tokenizer/prefixes
    -- as v1; readers only use rowid + bm25() so their SQL is unchanged.
    -- (v1 was external-content with sync triggers; builds are always
    -- from-scratch so the triggers bought nothing.)
    CREATE VIRTUAL TABLE objects_fts USING fts5(
      title, artist, culture, classification, medium, tags, synonyms,
      content='',
      tokenize='porter unicode61', prefix='2 3 4'
    );

    -- Schema below is the shared/search.ts contract: galleries PK is
    -- (galleryNumber, site); floor is the TEXT label clients display and
    -- filter on ("G", "1", "1M", "2", ...) — NULL when the museum's data
    -- doesn't say; centroids are NULL for museums without geometry.
    CREATE TABLE galleries (
      galleryNumber TEXT NOT NULL,
      title         TEXT,
      floor         TEXT,
      site          TEXT NOT NULL,
      centroidLat   REAL,
      centroidLon   REAL,
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

    -- Typo-tolerance vocabulary (shared/search.ts fuzzy autocomplete): every
    -- distinct searchable token (len >= 3, lowercased, diacritics folded)
    -- across the FTS-INDEXED text (so bilingual titles contribute both
    -- languages) plus multi-word artist names, with document frequency.
    CREATE TABLE vocab (
      id   INTEGER PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      df   INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE vocab_trigram USING fts5(
      term, content=vocab, content_rowid=id, tokenize='trigram', detail=column
    );

    CREATE TABLE blobs (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const insObject = db.prepare(
    `INSERT INTO objects VALUES (@objectID, @accession, @title, @artist, @culture, @period,
     @classification, @medium, @tags, @galleryNumber, @site, @rotation, @isHighlight,
     @imageUrl, @metadataDate, @synonyms,
     @museum, @sourceId, @locationNote, @titleAlt, @license, @imageLicense)`,
  );
  const insFts = db.prepare(
    `INSERT INTO objects_fts (rowid, title, artist, culture, classification, medium, tags, synonyms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Indexed-text tuples per object — reused for the typo vocabulary so both
  // stay in lockstep with what FTS actually matches.
  const indexedTuples: Array<{ title: string; artist: string; texts: string[] }> = [];
  const usedIds = new Map<number, string>(); // objectID → "museum/sourceId" (collision assert)
  const perMuseumCounts: Record<string, number> = {};

  for (const m of museums) {
    const { info, objects, synonyms } = m;
    const synFor = (o: ObjectRow): string =>
      [
        ...new Set(
          [
            synonyms.vocab[o.culture],
            synonyms.vocab[o.period],
            synonyms.vocab[o.classification],
            synonyms.titles[o.title],
          ].filter(Boolean),
        ),
      ].join(" ");

    // Met-only: recompute site + canonicalize galleryNumber from the geometry
    // join (the Met API zero-pads Cloisters numbers; see v1 history). Other
    // museums' sources emit canonical room codes directly.
    const siteByGallery = new Map<string, string>();
    const galleryVocab = new Set<string>();
    if (m.galleriesGeo) {
      for (const f of m.galleriesGeo.features) {
        const n = String(f.properties.galleryNumber ?? "").trim();
        if (n) {
          galleryVocab.add(n);
          siteByGallery.set(n, String(f.properties.site));
          siteByGallery.set(n.replace(/^0+/, ""), String(f.properties.site));
        }
      }
    }
    const authoritativeSite = (g: string, fallback: string): string =>
      siteByGallery.get(g) ?? siteByGallery.get(g.replace(/^0+/, "")) ?? fallback;
    const canonicalGallery = (g: string): string => {
      if (!/^0\d+$/.test(g)) return g;
      const stripped = g.replace(/^0+/, "");
      return galleryVocab.has(stripped) && !galleryVocab.has(g) ? stripped : g;
    };

    db.transaction(() => {
      for (const o of objects) {
        const sourceId = o.sourceId ?? String(o.objectID);
        const objectID = info.id === "met" ? o.objectID : hashObjectID(info.id, sourceId);
        const key = `${info.id}/${sourceId}`;
        const clash = usedIds.get(objectID);
        if (clash) throw new Error(`objectID collision: ${key} vs ${clash} → ${objectID}`);
        usedIds.set(objectID, key);

        const galleryNumber = m.galleriesGeo ? canonicalGallery(o.galleryNumber) : o.galleryNumber;
        const site = m.galleriesGeo ? authoritativeSite(galleryNumber, o.site) : o.site;
        const titleAlt = o.titleAlt ?? "";
        const syn = synFor(o);
        insObject.run({
          ...o,
          objectID,
          galleryNumber,
          site,
          isHighlight: o.isHighlight ? 1 : 0,
          synonyms: syn,
          museum: info.id,
          sourceId,
          locationNote: o.locationNote ?? "",
          titleAlt,
          license: o.license ?? info.license.text,
          imageLicense: o.imageLicense ?? info.license.images,
        });
        // Untitled-object convention (V&A: ~97% of rows display objectType as
        // the title) makes title === classification. Indexing that copy at
        // title weight both double-counts the term (10 + 5) and — because
        // sparse rows win bm25's length normalization — lets a museum of
        // type-titled rows sweep generic-noun autocomplete across the fleet
        // (measured: 8 V&A "Powder flask" rows filling the whole top-8 over
        // every true-titled Met/Cleveland flask). Semantically the fallback
        // IS a type, so index it ONLY as classification (weight 5): rows
        // with real titles outrank type matches, which is exactly what the
        // column weights mean. The DISPLAY title keeps the fallback value.
        const isTypeTitle =
          o.classification.trim().toLowerCase() === o.title.trim().toLowerCase() &&
          o.title.trim() !== "";
        // Indexed title carries both languages at full weight.
        const titleForIndex = isTypeTitle ? "" : o.title;
        const indexedTitle = titleAlt ? `${titleForIndex} ${titleAlt}`.trim() : titleForIndex;
        insFts.run(objectID, indexedTitle, o.artist, o.culture, o.classification, o.medium, o.tags, syn);
        indexedTuples.push({
          title: indexedTitle,
          artist: o.artist,
          texts: [indexedTitle, o.artist, o.culture, o.classification, o.medium, o.tags, syn],
        });
      }
    })();
    perMuseumCounts[info.id] = objects.length;
  }
  db.exec("INSERT INTO objects_fts(objects_fts) VALUES ('optimize')");

  // ---- typo-tolerance vocabulary (fuzzy autocomplete candidate source) ------
  // Tokenization mirrors what unicode61 does to latin text: lowercase, fold
  // diacritics, split on non-alphanumerics. Tokens < 3 chars carry no trigram
  // and are never fuzzy-corrected (the exact prefix path handles them).
  // Multi-word artist names (each ";"-separated artist) are stored whole so a
  // missing-space typo ("vangogh") can correct to the phrase "van gogh".
  const fold = (s: string): string =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const vocabTokens = (s: string): string[] =>
    fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const termDf = new Map<string, number>();
  for (const o of indexedTuples) {
    const seen = new Set<string>();
    for (const field of o.texts) for (const t of vocabTokens(field)) seen.add(t);
    for (const name of o.artist.split(";")) {
      const phrase = vocabTokens(name).join(" ");
      if (phrase.includes(" ") && phrase.length <= 40) seen.add(phrase);
    }
    for (const t of seen) termDf.set(t, (termDf.get(t) ?? 0) + 1);
  }
  const insVocab = db.prepare("INSERT INTO vocab(id, term, df) VALUES (?, ?, ?)");
  const insVocabFts = db.prepare("INSERT INTO vocab_trigram(rowid, term) VALUES (?, ?)");
  db.transaction(() => {
    let id = 0;
    for (const [term, df] of termDf) {
      id++;
      insVocab.run(id, term, df);
      insVocabFts.run(id, term);
    }
  })();
  db.exec("INSERT INTO vocab_trigram(vocab_trigram) VALUES ('optimize')");

  // "Floor 1M" -> "1M"; the label form clients display and filter on.
  const floorLabel = (floorName: unknown): string =>
    String(floorName ?? "").replace(/^Floor\s+/, "");
  // Living Map kind -> shared/search.ts amenity type vocabulary.
  const amenityType = (kind: unknown): string =>
    kind === "information" ? "info" : String(kind ?? "");

  // ---- galleries: geometry → labels file → synthesized from objects --------
  const insGallery = db.prepare("INSERT INTO galleries VALUES (?, ?, ?, ?, ?, ?)");
  let galleryCount = 0;
  for (const m of museums) {
    db.transaction(() => {
      if (m.galleriesGeo) {
        const withPolygon = new Set<string>();
        for (const f of m.galleriesGeo.features) {
          if (!f.properties.galleryNumber) continue;
          const c = centroid(f.geometry);
          insGallery.run(
            f.properties.galleryNumber,
            f.properties.title ?? null,
            floorLabel(f.properties.floorName),
            f.properties.site,
            c.lat,
            c.lon,
          );
          withPolygon.add(String(f.properties.galleryNumber));
          galleryCount++;
        }
        // Geometry + labels can coexist (Louvre: OSM polygons cover ~2/3 of
        // the plan's salles): room codes the geometry couldn't match still get
        // label rows from galleries.json so search/browse/"n of N" know every
        // room. No-op for the Met, which ships no galleries.json.
        for (const g of m.galleryLabels ?? []) {
          if (withPolygon.has(g.galleryNumber)) continue;
          insGallery.run(g.galleryNumber, g.title ?? null, g.floor ?? null, g.site, null, null);
          galleryCount++;
        }
        return;
      }
      // No geometry: label rows from galleries.json, else synthesize from the
      // museum's distinct (galleryNumber, site) pairs so gallery search, room
      // browse, and "n of N" work at room-label fidelity.
      const labels = new Map<string, GalleryLabelRow>();
      for (const g of m.galleryLabels ?? []) labels.set(`${g.galleryNumber} ${g.site}`, g);
      const pairs = db
        .prepare(
          "SELECT DISTINCT galleryNumber, site FROM objects WHERE museum = ? AND galleryNumber != ''",
        )
        .all(m.info.id) as Array<{ galleryNumber: string; site: string }>;
      for (const p of pairs) {
        const label = labels.get(`${p.galleryNumber} ${p.site}`);
        insGallery.run(p.galleryNumber, label?.title ?? null, label?.floor ?? null, p.site, null, null);
        galleryCount++;
      }
    })();
  }

  const insAmenity = db.prepare("INSERT INTO amenities VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let amenityCount = 0;
  db.transaction(() => {
    for (const m of museums) {
      for (const f of m.amenitiesGeo?.features ?? []) {
        const p = f.properties;
        amenityCount++;
        insAmenity.run(amenityCount, amenityType(p.kind), p.name ?? null, floorLabel(p.floorName), p.site, p.lat, p.lon, p.closed ? 1 : 0);
      }
    }
  })();

  // Graph node ids are museum-unique by prefixing non-Met ids (Met ids stay
  // stable for shipped-client route deep links).
  const insNode = db.prepare("INSERT INTO graph_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insEdge = db.prepare("INSERT INTO graph_edges VALUES (?, ?, ?, ?, ?, ?)");
  let nodeCount = 0;
  let edgeCount = 0;
  const allPolylineFeatures: unknown[] = [];
  db.transaction(() => {
    for (const m of museums) {
      if (!m.graph) continue;
      const prefix = m.info.id === "met" ? "" : `${m.info.id}:`;
      for (const n of m.graph.nodes) {
        insNode.run(prefix + n.id, n.lat, n.lon, n.floor, n.site, n.gallery ?? null, n.kind ?? null, n.name ?? null);
        nodeCount++;
      }
      for (const e of m.graph.edges) {
        insEdge.run(prefix + e.a, prefix + e.b, e.len, e.kind, e.bearing ?? null, e.room ?? null);
        edgeCount++;
      }
      // Per-floor walking polylines for map rendering, derived from same-floor
      // graph edges (door/walk); clients filter by feature.properties.floor/site.
      const nodeById = new Map(m.graph.nodes.map((n) => [n.id, n]));
      for (const e of m.graph.edges) {
        if (e.kind !== "walk" && e.kind !== "door") continue;
        const a = nodeById.get(e.a);
        const b = nodeById.get(e.b);
        if (!a || !b || a.floor !== b.floor) continue;
        allPolylineFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
          properties: { floor: a.floor, site: a.site, kind: e.kind },
        });
      }
    }
  })();

  // ---- blobs: merged FeatureCollections across museums ----------------------
  const mergeFeatures = (colls: Array<{ features: Feature[] } | null>): string =>
    JSON.stringify({
      type: "FeatureCollection",
      features: colls.flatMap((c) => c?.features ?? []),
    });
  const insBlob = db.prepare("INSERT INTO blobs VALUES (?, ?)");
  insBlob.run(
    "galleries.geojson",
    zlib.gzipSync(mergeFeatures(museums.map((m) => m.galleriesGeo)), { level: 9 }),
  );
  insBlob.run(
    "amenities.geojson",
    zlib.gzipSync(mergeFeatures(museums.map((m) => m.amenitiesGeo)), { level: 9 }),
  );
  insBlob.run(
    "routes.geojson",
    zlib.gzipSync(
      JSON.stringify({ type: "FeatureCollection", features: allPolylineFeatures }),
      { level: 9 },
    ),
  );

  const counts = {
    objects: indexedTuples.length,
    vocab: termDf.size,
    galleries: galleryCount,
    amenities: amenityCount,
    graphNodes: nodeCount,
    graphEdges: edgeCount,
  };
  // meta.museums: the registry entry + per-museum liveness — the client and
  // the server manifest endpoint read the same facts offline.
  const museumsMeta = museums.map((m) => ({
    ...m.info,
    counts: { objects: perMuseumCounts[m.info.id] },
    capabilities: {
      hasGeometry: !!m.galleriesGeo,
      hasGraph: !!m.graph,
      granularity: m.info.fidelity === "museum-only" ? "museum" : "room",
      languages: m.objects.some((o) => o.titleAlt) ? ["en", "fr"] : ["en"],
    },
    fetchedAt: m.fetchedAt,
  }));
  const insMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
  insMeta.run("dataVersion", dataVersion);
  insMeta.run("builtAt", builtAt);
  insMeta.run("counts", JSON.stringify(counts));
  insMeta.run("schemaVersion", "2");
  insMeta.run("museums", JSON.stringify(museumsMeta));

  db.pragma("journal_mode = DELETE"); // ship without a -journal side file
  db.exec("VACUUM");
  db.exec("ANALYZE");
  db.close();
  fs.renameSync(TMP_PATH, DB_PATH);
  fs.writeFileSync(VERSION_PATH, dataVersion + "\n");

  // ---- verify --------------------------------------------------------------
  console.log(`dataVersion ${dataVersion}`);
  console.log(`counts ${JSON.stringify(counts)} (per museum: ${JSON.stringify(perMuseumCounts)})`);
  const bytes = fs.statSync(DB_PATH).size;
  const gzBytes = zlib.gzipSync(fs.readFileSync(DB_PATH), { level: 6 }).length;
  console.log(`met.sqlite ${(bytes / 1e6).toFixed(1)} MB raw, ${(gzBytes / 1e6).toFixed(1)} MB gzip`);

  const v = new Database(DB_PATH, { readonly: true });
  const search = v.prepare(`
    SELECT o.objectID, o.title, o.artist, o.galleryNumber, o.museum, g.floor,
           round(bm25(objects_fts, 10, 8, 3, 5, 2, 4, 1), 2) AS score
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
        `  [${r.score}] #${r.objectID} (${r.museum}) "${r.title}" — ${r.artist || "(no artist)"} | gallery ${r.galleryNumber} floor ${r.floor ?? "?"}`,
      );
    }
  }

  const trig = v
    .prepare(`
      SELECT vv.term FROM vocab_trigram t JOIN vocab vv ON vv.id = t.rowid
      WHERE vocab_trigram MATCH '"har" OR "arl" OR "rlw"'
      ORDER BY bm25(vocab_trigram) LIMIT 3
    `)
    .all()
    .map((r) => (r as { term: string }).term);
  console.log(`\nvocab trigram 'harlw' candidates → ${trig.join(", ") || "(none)"}`);

  // Per-museum coverage: every object row joins a galleries row (synthesized
  // rows make this structural for label-only museums — a miss is a bug).
  for (const m of museums) {
    const cov = v
      .prepare(`
        SELECT count(*) AS total,
               sum(EXISTS (SELECT 1 FROM galleries g
                           WHERE g.galleryNumber = o.galleryNumber AND g.site = o.site)) AS matched
        FROM objects o WHERE o.museum = ?
      `)
      .get(m.info.id) as { total: number; matched: number };
    console.log(
      `coverage[${m.info.id}]: ${cov.matched}/${cov.total} objects (${((100 * cov.matched) / cov.total).toFixed(1)}%) have a galleries row`,
    );
  }
  const orphanObjGalleries = v
    .prepare(`
      SELECT DISTINCT galleryNumber FROM objects o
      WHERE NOT EXISTS (SELECT 1 FROM galleries g
                        WHERE g.galleryNumber = o.galleryNumber AND g.site = o.site)
      ORDER BY galleryNumber
    `)
    .all()
    .map((r) => (r as { galleryNumber: string }).galleryNumber);
  console.log(
    `orphan gallery numbers on objects (no galleries row): ${orphanObjGalleries.length}${
      orphanObjGalleries.length ? " → " + orphanObjGalleries.slice(0, 20).join(", ") : ""
    }${orphanObjGalleries.length > 20 ? ", …" : ""}`,
  );
  v.close();
}

main();
