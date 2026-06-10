/**
 * Journey fixtures read live from data/met.sqlite at spec load, so the same
 * assertions hold against the current partial snapshot AND the full 45k
 * catalog once hydration lands (fixtures re-derive themselves; conditional
 * journeys self-upgrade — see each field's doc).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { buildRouteGraph, route } from '../../shared/routing.ts';
import { buildAutocompleteQuery } from '../../shared/search.ts';

const DB_PATH = path.resolve(__dirname, '../../data/met.sqlite');

export interface FixtureObject {
  objectID: number;
  title: string;
  artist: string;
  galleryNumber: string;
}

export interface JourneyFixtures {
  /** Total objects — journeys log it so a video is self-describing. */
  objectCount: number;
  /** J2/J15: open, polygon-mapped gallery with the most objects, + them. */
  galleryId: string;
  galleryFloorNumeric: number;
  galleryObjects: FixtureObject[];
  /** TRUE object count of that gallery (galleryObjects is capped at 500). */
  galleryTotal: number;
  /** J4: distinctive clean-ASCII-titled object (same rule as dataprovider.spec). */
  artifact: FixtureObject;
  /** J5: artist with the most on-view objects + their count. */
  artist: string;
  artistCount: number;
  /** J6: validated multi-word autocomplete query + an objectID it must rank. */
  multiWordQuery: string;
  multiWordHit: FixtureObject;
  /** J7: is Washington Crossing the Delaware (11417) in the catalog yet? */
  washingtonPresent: boolean;
  /** J9: lat/lon centroids of the first galleries en route 131→822 (walk flavor). */
  walkCoords: { lat: number; lon: number }[];
  /** J14: a Cloisters-sited on-view object, when the catalog has one. */
  cloistersObject: FixtureObject | null;
}

interface GalleryGeomProps {
  galleryNumber: string;
  floor: number;
  site: string;
  closed: boolean;
}

function pickCleanObject(db: Database.Database): FixtureObject {
  const rows = db
    .prepare(
      `SELECT objectID, title, artist, galleryNumber FROM objects
       WHERE galleryNumber != '' AND length(title) BETWEEN 10 AND 60
       ORDER BY isHighlight DESC, objectID LIMIT 200`,
    )
    .all() as FixtureObject[];
  const clean = rows.find((r) => /^[A-Za-z][A-Za-z0-9 ]+ [A-Za-z0-9 ]+$/.test(r.title));
  if (!clean) throw new Error('no clean fixture object in data/met.sqlite');
  return clean;
}

/** First multi-word candidate the REAL autocomplete SQL returns rows for. */
function pickMultiWordQuery(
  db: Database.Database,
): { query: string; hit: FixtureObject } {
  const candidates: string[] = [];
  // The plan's showcase query — active as soon as arms & armor hydrates.
  if (
    (db.prepare(`SELECT COUNT(*) c FROM objects WHERE classification LIKE '%Sword%'`).get() as { c: number }).c > 0
  ) {
    candidates.push('gold swords');
  }
  // Fallbacks derived from whatever is on view: "<medium-word> <title-word>".
  const rows = db
    .prepare(
      `SELECT objectID, title, artist, galleryNumber, medium, classification
       FROM objects WHERE galleryNumber != '' AND medium != '' ORDER BY isHighlight DESC LIMIT 100`,
    )
    .all() as (FixtureObject & { medium: string; classification: string })[];
  const DULL = new Set(['partly', 'various', 'possibly', 'overall', 'probably']);
  for (const r of rows) {
    const mediumWord = (r.medium.toLowerCase().match(/[a-z]{5,}/g) ?? []).find(
      (w) => !DULL.has(w),
    );
    const titleWord = (r.title.toLowerCase().match(/[a-z]{5,}/) ?? [])[0];
    if (mediumWord && titleWord && mediumWord !== titleWord) {
      candidates.push(`${mediumWord} ${titleWord}`);
    }
  }
  for (const query of candidates) {
    const q = buildAutocompleteQuery(query);
    if (!q) continue;
    try {
      const hits = db.prepare(q.sql).all(...q.params) as { objectID: number }[];
      if (hits.length > 0) {
        const hit = db
          .prepare('SELECT objectID, title, artist, galleryNumber FROM objects WHERE objectID = ?')
          .get(hits[0].objectID) as FixtureObject;
        return { query, hit };
      }
    } catch {
      /* FTS syntax edge — try the next candidate */
    }
  }
  throw new Error('no multi-word autocomplete query matches data/met.sqlite');
}

/** On-view object count in one gallery (e.g. J9's arrival "What's here"). */
export function countObjectsIn(galleryNumber: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return (
      db
        .prepare('SELECT COUNT(*) c FROM objects WHERE galleryNumber = ?')
        .get(galleryNumber) as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

export function loadJourneyFixtures(): JourneyFixtures {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const objectCount = (db.prepare('SELECT COUNT(*) c FROM objects').get() as { c: number }).c;

    // Geometry: open galleries that actually have a polygon (tappable on map).
    const blob = db
      .prepare(`SELECT value FROM blobs WHERE key = 'galleries.geojson'`)
      .get() as { value: Buffer };
    const geo = JSON.parse(gunzipSync(blob.value).toString()) as {
      features: { properties: GalleryGeomProps }[];
    };
    const openMapped = new Map(
      geo.features
        .filter((f) => !f.properties.closed && f.properties.site === 'fifthAve')
        .map((f) => [f.properties.galleryNumber, f.properties]),
    );

    const byCount = db
      .prepare(
        `SELECT galleryNumber, COUNT(*) c FROM objects WHERE galleryNumber != ''
         GROUP BY galleryNumber ORDER BY c DESC LIMIT 50`,
      )
      .all() as { galleryNumber: string; c: number }[];
    const top = byCount.find((g) => openMapped.has(g.galleryNumber));
    if (!top) throw new Error('no open mapped gallery with objects');
    const galleryId = top.galleryNumber;
    const galleryFloorNumeric = openMapped.get(galleryId)!.floor;
    // Mirrors SqliteDataProvider.objectsInGallery: same ordering AND the same
    // GALLERY_OBJECTS_LIMIT=500 display cap. The app's room-sheet COUNT and
    // the object page's "n of N" browser are defined over the FULL gallery
    // (galleryTotal, SQL primitives) — only the rendered list is capped.
    const galleryObjects = db
      .prepare(
        `SELECT objectID, title, artist, galleryNumber FROM objects
         WHERE galleryNumber = ? ORDER BY isHighlight DESC, objectID LIMIT 500`,
      )
      .all(galleryId) as FixtureObject[];
    const galleryTotal = top.c;

    const artistRow = db
      .prepare(
        `SELECT artist, COUNT(*) c FROM objects WHERE artist != '' AND galleryNumber != ''
         GROUP BY artist ORDER BY c DESC LIMIT 1`,
      )
      .get() as { artist: string; c: number };

    const washingtonPresent =
      (db.prepare('SELECT COUNT(*) c FROM objects WHERE objectID = 11417').get() as { c: number })
        .c > 0;

    const cloistersObject =
      (db
        .prepare(
          `SELECT o.objectID, o.title, o.artist, o.galleryNumber
           FROM objects o JOIN galleries g
             ON g.galleryNumber = o.galleryNumber AND g.site = 'cloisters'
           ORDER BY o.isHighlight DESC LIMIT 1`,
        )
        .get() as FixtureObject | undefined) ?? null;

    // J9 walk flavor: centroids of the first galleries on the real 131→822 route.
    const nodes = db
      .prepare('SELECT id, lat, lon, floor, site, gallery, kind, name FROM graph_nodes')
      .all();
    const edges = db.prepare('SELECT a, b, len, kind, bearing, room FROM graph_edges').all();
    const gals = db
      .prepare('SELECT galleryNumber, title, floor, site, centroidLat, centroidLon FROM galleries')
      .all() as {
      galleryNumber: string;
      centroidLat: number;
      centroidLon: number;
    }[];
    const centroid = new Map(gals.map((g) => [g.galleryNumber, g]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph = buildRouteGraph(nodes as any, edges as any, gals as any);
    const r = route(graph, '131', '822', {});
    const walkCoords = (r?.steps ?? [])
      .map((s) => (s.gallery ? centroid.get(s.gallery) : undefined))
      .filter((g): g is NonNullable<typeof g> => g !== undefined)
      .slice(0, 4)
      .map((g) => ({ lat: g.centroidLat, lon: g.centroidLon }));

    const { query: multiWordQuery, hit: multiWordHit } = pickMultiWordQuery(db);

    return {
      objectCount,
      galleryId,
      galleryFloorNumeric,
      galleryObjects,
      galleryTotal,
      artifact: pickCleanObject(db),
      artist: artistRow.artist,
      artistCount: artistRow.c,
      multiWordQuery,
      multiWordHit,
      washingtonPresent,
      walkCoords,
      cloistersObject,
    };
  } finally {
    db.close();
  }
}
