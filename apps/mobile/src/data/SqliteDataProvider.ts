/**
 * SqliteDataProvider — the real DataProvider over a downloaded met.sqlite,
 * opened via the ./sqlite seam (native: expo-sqlite; web: official
 * sqlite-wasm in memory — see sqlite.web.ts for why not expo-sqlite there).
 *
 * Shape of the implementation:
 *  - Object search runs as SQL on every call, through the shared
 *    platform-neutral builders (shared/search.ts) + a hydration query for the
 *    full MetObject columns. Sync (allSync) because the DataProvider
 *    interface is synchronous; every query carries a LIMIT (UI lists are
 *    bounded and result sets must stay render-loop cheap).
 *  - Small tables (galleries, amenities, graph, geometry blob) are loaded
 *    once in create() and served from memory; route() delegates to
 *    shared/routing.ts (buildRouteGraph/route) over those plain rows.
 *  - galleriesGeometry(site, floor) implements the S2 map contract
 *    (components/MapGeometry.ts GeometryProvider): gunzipped
 *    blobs['galleries.geojson'] features filtered per site+floor. Room.rect
 *    and Route.geo reuse MapGeometry's buildSiteGeometry projection/viewBox
 *    so map overlays line up exactly.
 *
 * Field mapping vs the stub MetObject: date←period, dept←classification,
 * credit←'' (synopsis/credit are fetched lazily from the Met API on the
 * object page in a later phase).
 */
import { gunzipSync } from 'fflate';

import {
  buildSiteGeometry,
  floorLabel,
  placeRoomKind,
  type GalleryFeature,
  type MapShape,
  type Site,
  type SiteGeometry,
} from '@/components/MapGeometry';
import {
  buildRouteGraph,
  route as sharedRoute,
  type GalleryRow,
  type GraphEdge,
  type GraphNode,
  type RouteGraph,
  type RouteStep as SharedRouteStep,
} from '@met/shared/routing';
import {
  autocompleteFuzzy,
  buildAccessionSearchQuery,
  buildFullQuery,
  buildGalleryNeighborsQuery,
  buildGalleryPositionQuery,
  computeExpiredMuseums,
  GALLERY_ORDER,
  matchGalleries,
  type SearchFilters,
} from '@met/shared/search';

import type { DataProvider, MetObject, MuseumEntry, Room, RoomKind, Route } from './provider';
import { BUILTIN_MET_ENTRY, MET_SITE_IDS, parseRoomId, scopedRoomId } from './provider';
import type { MetDb } from './sqlite';

const SEARCH_ALL_LIMIT = 200; // All Results page cap
const GALLERY_OBJECTS_LIMIT = 500;

interface ObjectRow {
  objectID: number;
  accession: string;
  title: string;
  artist: string;
  period: string;
  classification: string;
  medium: string;
  galleryNumber: string;
  site: string;
  isHighlight: number;
  imageUrl: string;
  thumbKey: string;
  museum: string;
  sourceId: string;
}

// `site` has existed since schema v1 (SELECT_CORE in shared/search.ts already
// selects it unconditionally); thumbKey/museum are schema-v2-era additions,
// feature-detected in create() below (a pre-v2 artifact selects '' literals
// for both, and toMetObject()'s `|| undefined` turns that into "no thumbnail"
// / "museum unknown → treat as met", exactly like the pre-existing thumbKey
// convention).
const OBJECT_COLS =
  'objectID, accession, title, artist, period, classification, medium, galleryNumber, isHighlight, imageUrl, site';

function toMetObject(r: ObjectRow): MetObject {
  return {
    objectID: r.objectID,
    title: r.title,
    artist: r.artist,
    date: r.period,
    medium: r.medium,
    accession: r.accession,
    // Site-scoped ROOM ID (bare for Met) — every consumer (getGallery,
    // objectsInGallery, the /?focus= grammar) treats `gallery` as a room key,
    // and bare codes are ambiguous across museums. Display code comes from
    // room lookups, never from this field.
    gallery: r.galleryNumber ? scopedRoomId(r.site, r.galleryNumber) : r.galleryNumber,
    dept: r.classification,
    credit: '',
    isHighlight: r.isHighlight === 1,
    img: r.imageUrl,
    thumbKey: r.thumbKey,
    museum: r.museum || undefined,
    site: r.site,
    // Pre-v2 artifacts select '' — the Met's sourceId IS its objectID.
    sourceId: r.sourceId || String(r.objectID),
  };
}

interface AmenityRow {
  id: number;
  type: string;
  name: string | null;
  floor: string;
  site: string;
  lat: number;
  lon: number;
}

interface DbGalleryRow extends GalleryRow {
  centroidLat: number;
  centroidLon: number;
}

/**
 * NULL/'' (C3: museums whose gallery rows ship with no authoritative floor
 * mapping — AIC, SMK; see data/src/sources/{aic,smk}.ts) → NaN, "unknown",
 * not 0/"G" — Number(null) coerces to 0, which used to mislabel every such
 * room "Floor G". Callers use floorLabel(NaN) === '' to detect this.
 */
function floorNumber(label: string | null | undefined): number {
  if (label == null || label === '') return NaN;
  if (label === 'G') return 0;
  if (label === '1M') return 1.5;
  return Number(label);
}

const AMENITY_NAMES: Record<string, string> = {
  restroom: 'Restroom',
  elevator: 'Elevator',
  escalator: 'Escalator',
  dining: 'Dining',
  water: 'Water fountain',
  info: 'Information desk',
  entrance: 'Entrance',
  shop: 'Shop',
  tickets: 'Tickets',
  cloakroom: 'Coat check',
  firstAid: 'First aid',
};

/**
 * Equirectangular meters, y grows south. Same origin/constants as
 * MapGeometry.buildSiteGeometry pass 1 (the site geometry bbox center), so
 * provider coordinates land exactly in FloorMap's space.
 */
interface Projector {
  x(lon: number): number;
  y(lat: number): number;
}

function projectorFromFeatures(features: GalleryFeature[]): Projector | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const f of features) {
    const rings =
      f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  if (!Number.isFinite(minLat)) return null;
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return { x: (lon) => (lon - lon0) * kx, y: (lat) => (lat0 - lat) * 110_540 };
}

export class SqliteDataProvider implements DataProvider {
  readonly dataVersion: string;
  readonly builtAt?: string;

  /**
   * Object SELECT list. Older met.sqlite artifacts (downloaded/cached before
   * the thumbnail pipeline / schema v2 landed) have no thumbKey/museum
   * columns — create() detects each and selects a '' literal instead, so the
   * provider keeps working against any artifact version (components then use
   * the proxy fallback for images, and treat museum '' as 'met' — see
   * toMetObject / objectMuseumId).
   */
  private objectCols = `${OBJECT_COLS}, '' AS thumbKey, '' AS museum, '' AS sourceId`;

  /** Site ids belonging to an expired museum (derived from expiredMuseums + museumEntries). */
  private expiredSiteIds: Set<string>;

  private constructor(
    private met: MetDb,
    private rooms: Map<string, Room>,
    private galleryRooms: Room[],
    private amenityRooms: Room[],
    /** Room id (`amenity-N`) → nearest graph space-node id. */
    private amenityNode: Map<string, string>,
    private graph: RouteGraph,
    /** `${site}|${floorLabel}` → geometry features (S2 map contract). */
    private geometryByFloor: Map<string, GalleryFeature[]>,
    private projectors: Map<string, Projector>,
    private viewBoxBySite: Map<string, SiteGeometry['viewBox']>,
    /** Stub-era 'great-hall' route anchor → a node near the main entrance. */
    private entranceNodeId: string | null,
    /** meta.museums (schema v2); [BUILTIN_MET_ENTRY] for pre-v2 artifacts. */
    private museumEntries: MuseumEntry[],
    /** objects.museum exists (schema v2) — gates whether museum-scoped search is safe to run. */
    private hasMuseumColumn: boolean,
    builtAt: string | undefined,
    /**
     * Museum registry ids whose license TTL has lapsed (registry
     * license.ttlDays vs meta.builtAt age, computed once in create() — see
     * ARCHITECTURE.md "Provenance & the license-TTL mechanism"). Threaded
     * into every search/browse query as `AND o.museum NOT IN (...)` — the
     * WHERE clause IS the compliance mechanism.
     */
    private expiredMuseumIds: string[],
  ) {
    this.dataVersion = met.dataVersion;
    this.builtAt = builtAt;
    const expiredIds = new Set(expiredMuseumIds);
    this.expiredSiteIds = new Set(
      museumEntries.filter((m) => expiredIds.has(m.id)).flatMap((m) => m.sites.map((s) => s.siteId)),
    );
  }

  static async create(met: MetDb): Promise<SqliteDataProvider> {
    const [thumbCol, museumCol, galleryRows, amenityRows, nodes, edges, blob, museumsMeta, builtAtMeta] =
      await Promise.all([
        met.allAsync<{ name: string }>(
          `SELECT name FROM pragma_table_info('objects') WHERE name = 'thumbKey'`,
        ),
        met.allAsync<{ name: string }>(
          `SELECT name FROM pragma_table_info('objects') WHERE name = 'museum'`,
        ),
        met.allAsync<DbGalleryRow>(
          'SELECT galleryNumber, title, floor, site, centroidLat, centroidLon FROM galleries',
        ),
        met.allAsync<AmenityRow>(
          'SELECT id, type, name, floor, site, lat, lon FROM amenities WHERE closed = 0',
        ),
        met.allAsync<GraphNode>(
          'SELECT id, lat, lon, floor, site, gallery, kind, name FROM graph_nodes',
        ),
        met.allAsync<GraphEdge>('SELECT a, b, len, kind, bearing, room FROM graph_edges'),
        met.allAsync<{ value: Uint8Array }>(
          `SELECT value FROM blobs WHERE key = 'galleries.geojson'`,
        ),
        met.allAsync<{ value: string }>(`SELECT value FROM meta WHERE key = 'museums'`),
        // Artifact build date (C3 staleness fallback + the license-TTL age
        // check) — pre-v2 artifacts have no row, hence the array-length check
        // below rather than assuming one.
        met.allAsync<{ value: string }>(`SELECT value FROM meta WHERE key = 'builtAt'`),
      ]);

    // Schema v2 multi-museum manifest; pre-v2 artifacts have no key → Met.
    let museumEntries: MuseumEntry[] = [BUILTIN_MET_ENTRY];
    if (museumsMeta.length) {
      try {
        museumEntries = JSON.parse(museumsMeta[0].value) as MuseumEntry[];
      } catch {
        /* keep the built-in fallback */
      }
    }
    const builtAt = builtAtMeta.length ? builtAtMeta[0].value : undefined;

    // License-TTL mechanism (V&A non-commercial 28-day cap, …): a museum
    // whose license.ttlDays is set expires once the shipped artifact is
    // older than ttlDays - 1 days — its rows are excluded from every search/
    // browse query from here on (see ARCHITECTURE.md "Provenance & the
    // license-TTL mechanism"). No builtAt (pre-v2 artifact) → nothing expires.
    const expiredMuseums = computeExpiredMuseums(museumEntries, builtAt ?? null);

    // --- geometry blob → features per site|floorLabel (S2 map contract) -----
    const features: GalleryFeature[] = blob.length
      ? (
          JSON.parse(new TextDecoder().decode(gunzipSync(blob[0].value))) as {
            features: GalleryFeature[];
          }
        ).features
      : [];
    const geometryByFloor = new Map<string, GalleryFeature[]>();
    const featuresBySite = new Map<string, GalleryFeature[]>();
    for (const f of features) {
      const p = f.properties;
      const key = `${p.site}|${floorLabel(p.floor)}`;
      let list = geometryByFloor.get(key);
      if (!list) geometryByFloor.set(key, (list = []));
      list.push(f);
      let siteList = featuresBySite.get(p.site);
      if (!siteList) featuresBySite.set(p.site, (siteList = []));
      siteList.push(f);
    }

    // --- per-site projection + viewBox + gallery bboxes via MapGeometry -----
    const geometryFn = (site: Site, floor: string) =>
      geometryByFloor.get(`${site}|${floor}`) ?? [];
    const projectors = new Map<string, Projector>();
    const viewBoxBySite = new Map<string, SiteGeometry['viewBox']>();
    const bboxByGallery = new Map<string, [number, number, number, number]>();
    // Living Map closed flags (galleries table has no closed column) and the
    // named place polygons (kind 'amenity' = named, see MapGeometry).
    const closedGalleries = new Set<string>();
    const placeShapes = new Map<string, { site: string; shape: MapShape }>();
    for (const [site, siteFeatures] of featuresBySite) {
      const projector = projectorFromFeatures(siteFeatures);
      if (!projector) continue;
      projectors.set(site, projector);
      const sg = buildSiteGeometry(geometryFn, site as Site);
      viewBoxBySite.set(site, sg.viewBox);
      for (const shapes of sg.shapesByFloor.values()) {
        for (const s of shapes) {
          // Keyed per site: room codes collide across museums with geometry
          // (Met "711" vs Louvre "711").
          if (s.kind === 'gallery') {
            const key = `${site}|${s.id}`;
            if (!bboxByGallery.has(key)) bboxByGallery.set(key, s.bbox);
            if (s.closed) closedGalleries.add(key);
          } else if (s.kind === 'amenity') {
            placeShapes.set(s.id, { site, shape: s });
          }
        }
      }
    }
    const project = (site: string, lat: number, lon: number): [number, number] => {
      const p = projectors.get(site);
      return p ? [p.x(lon), p.y(lat)] : [0, 0];
    };

    // --- rooms ---------------------------------------------------------------
    const rooms = new Map<string, Room>();
    const galleryRooms: Room[] = [];
    for (const g of galleryRows) {
      const [cx, cy] = project(g.site, g.centroidLat, g.centroidLon);
      const siteKey = `${g.site}|${g.galleryNumber}`;
      const room: Room = {
        // Site-scoped id ("{site}:{code}") for non-Met sites; bare Met codes
        // keep deep links/route URLs/e2e stable — see provider.scopedRoomId.
        id: scopedRoomId(g.site, g.galleryNumber),
        name: g.title ?? `Gallery ${g.galleryNumber}`,
        floor: floorNumber(g.floor),
        kind: 'gallery',
        rect: bboxByGallery.get(siteKey) ?? [cx - 6, cy - 5, 12, 10],
        site: g.site as Room['site'],
        // Living Map closed flag (nightly snapshot): the sheet shows the
        // room but offers no DIRECTIONS / I'M HERE for inaccessible rooms.
        ...(closedGalleries.has(siteKey) ? { closed: true } : null),
      };
      rooms.set(room.id, room);
      galleryRooms.push(room);
    }

    const amenityRooms: Room[] = [];
    const amenityNode = new Map<string, string>();
    const nearestNode = (site: string, floor: number, lat: number, lon: number) => {
      // Plain equirectangular distance — independent of the SVG projection.
      const kx = Math.cos((lat * Math.PI) / 180);
      let best: string | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        if (n.site !== site || n.floor !== floor || n.kind === 'door') continue;
        const d = ((n.lat - lat) * 1.007) ** 2 + ((n.lon - lon) * kx) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n.id;
        }
      }
      return best;
    };
    for (const a of amenityRows) {
      const id = `amenity-${a.id}`;
      const floor = floorNumber(a.floor);
      const [cx, cy] = project(a.site, a.lat, a.lon);
      const room: Room = {
        id,
        name: a.name ?? AMENITY_NAMES[a.type] ?? a.type,
        floor,
        kind: (a.type in AMENITY_NAMES ? a.type : 'hall') as RoomKind,
        rect: [cx - 3, cy - 3, 6, 6],
        site: a.site as Room['site'],
      };
      rooms.set(id, room);
      amenityRooms.push(room);
      const node = nearestNode(a.site, floor, a.lat, a.lon);
      if (node) amenityNode.set(id, node);
    }

    // Named place polygons (bar/cafe/shop/restroom/library/… with a name) are
    // tappable map rooms (FloorMap passes id g{geomId}). Register them here so
    // the sheet's DIRECTIONS can route: the endpoint is the nearest non-door
    // graph node at the polygon's centroid — the exact join the amenities
    // table's points already use (no lm_id exists to join on). Closed places
    // get the room identity (sheet copy) but no routing endpoint.
    for (const [siteKey, siteFeatures] of featuresBySite) {
      for (const f of siteFeatures) {
        const hit = placeShapes.get(`g${f.properties.geomId}`);
        if (!hit || hit.site !== siteKey) continue;
        const { shape } = hit;
        const id = shape.id;
        if (rooms.has(id)) continue;
        rooms.set(id, {
          id,
          name: shape.name,
          floor: shape.floorNumeric,
          kind: placeRoomKind(shape.placeType ?? ''),
          rect: shape.bbox,
          site: siteKey as Room['site'],
          ...(shape.closed ? { closed: true } : null),
        });
        if (shape.closed) continue;
        const ring =
          f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
        let lat = 0;
        let lon = 0;
        for (const [rlon, rlat] of ring) {
          lon += rlon;
          lat += rlat;
        }
        const node = nearestNode(siteKey, shape.floorNumeric, lat / ring.length, lon / ring.length);
        if (node) amenityNode.set(id, node);
      }
    }

    const graph = buildRouteGraph(nodes, edges, galleryRows);
    const entrance = amenityRows.find((a) => a.type === 'entrance' && a.site === 'fifthAve');
    const entranceNodeId = entrance
      ? nearestNode('fifthAve', floorNumber(entrance.floor), entrance.lat, entrance.lon)
      : null;

    const provider = new SqliteDataProvider(
      met,
      rooms,
      galleryRooms,
      amenityRooms,
      amenityNode,
      graph,
      geometryByFloor,
      projectors,
      viewBoxBySite,
      entranceNodeId,
      museumEntries,
      museumCol.length > 0,
      builtAt,
      expiredMuseums,
    );
    provider.objectCols = [
      OBJECT_COLS,
      thumbCol.length > 0 ? 'thumbKey' : `'' AS thumbKey`,
      // museum + sourceId arrived together in schema v2 — one detection gates both.
      museumCol.length > 0 ? 'museum' : `'' AS museum`,
      museumCol.length > 0 ? 'sourceId' : `'' AS sourceId`,
    ].join(', ');
    return provider;
  }

  // --- search ----------------------------------------------------------------

  /** Ranked SearchRow ids → full MetObjects, preserving rank order. */
  private hydrate(ids: number[]): MetObject[] {
    if (ids.length === 0) return [];
    const rows = this.met.allSync<ObjectRow>(
      `SELECT ${this.objectCols} FROM objects WHERE objectID IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.objectID, toMetObject(r)]));
    return ids.map((id) => byId.get(id)).filter((o): o is MetObject => o !== undefined);
  }

  /**
   * Digit-bearing queries additionally match accession numbers ("131" →
   * "21.131"): accession is not an objects_fts column, so without this UNION
   * digit queries surface almost nothing. FTS hits (bm25-ranked title/artist
   * relevance) come first; accession-containment hits are appended, deduped.
   */
  private withAccessionMatches(
    query: string,
    ids: number[],
    limit: number,
    museum?: string,
    expiredMuseums?: string[],
  ): number[] {
    if (ids.length >= limit) return ids.slice(0, limit);
    const aq = buildAccessionSearchQuery(query, limit, museum, expiredMuseums);
    if (aq === null) return ids.slice(0, limit);
    const seen = new Set(ids);
    const merged = [...ids];
    for (const r of this.met.allSync<{ objectID: number }>(aq.sql, aq.params)) {
      if (!seen.has(r.objectID)) merged.push(r.objectID);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  /** museum scoping is a no-op unless the artifact's objects table actually has the column. */
  private scopedMuseum(museum: string | undefined): string | undefined {
    return this.hasMuseumColumn ? museum : undefined;
  }

  /** Same no-op-unless-the-column-exists guard as scopedMuseum, for the TTL exclusion list. */
  private scopedExpiredMuseums(): string[] {
    return this.hasMuseumColumn ? this.expiredMuseumIds : [];
  }

  /** Museum registry ids currently hidden by the license-TTL mechanism (see the constructor). */
  expiredMuseums(): string[] {
    return this.expiredMuseumIds;
  }

  /** Gallery rooms with any license-TTL-expired museum's rooms excluded. */
  private visibleGalleryRooms(): Room[] {
    if (this.expiredSiteIds.size === 0) return this.galleryRooms;
    return this.galleryRooms.filter((r) => !r.site || !this.expiredSiteIds.has(r.site));
  }

  searchAutocomplete(query: string, limit = 8, museum?: string): MetObject[] {
    // exact prefix path first; on zero rows, trigram+edit-distance correction
    // over the vocab tables ("harlw" -> harlequin). Caps at top 8.
    const scoped = this.scopedMuseum(museum);
    const expired = this.scopedExpiredMuseums();
    const rows = autocompleteFuzzy(
      (sql, params) => this.met.allSync(sql, params),
      query,
      scoped,
      expired,
    );
    const ids = this.withAccessionMatches(
      query,
      rows.slice(0, limit).map((r) => r.objectID),
      limit,
      scoped,
      expired,
    );
    return this.hydrate(ids);
  }

  searchAll(query: string, filters: SearchFilters = {}): MetObject[] {
    const scopedFilters: SearchFilters = {
      ...(this.hasMuseumColumn ? filters : { ...filters, museum: undefined }),
      expiredMuseums: this.scopedExpiredMuseums(),
    };
    const q = buildFullQuery(query, scopedFilters, { limit: SEARCH_ALL_LIMIT });
    const rows = q === null ? [] : this.met.allSync<{ objectID: number }>(q.sql, q.params);
    // Accession matches join the pool only for unfiltered searches — the
    // accession scan doesn't apply the SQL-level filters.
    const ids = Object.keys(filters).length
      ? rows.map((r) => r.objectID)
      : this.withAccessionMatches(
          query,
          rows.map((r) => r.objectID),
          SEARCH_ALL_LIMIT,
          undefined,
          this.scopedExpiredMuseums(),
        );
    return this.hydrate(ids);
  }

  searchGalleries(query: string, limit = 4): Room[] {
    // Match on the BARE room code (digit queries type "241", never "aic:241");
    // room ids stay site-scoped for everything downstream.
    return matchGalleries(
      this.visibleGalleryRooms().map((room) => ({
        galleryNumber: parseRoomId(room.id).galleryNumber,
        title: room.name,
        room,
      })),
      query,
      limit,
    ).map((hit) => hit.room);
  }

  getObject(objectID: number): MetObject | undefined {
    const expired = this.scopedExpiredMuseums();
    let sql = `SELECT ${this.objectCols} FROM objects WHERE objectID = ?`;
    const params: Array<string | number> = [objectID];
    if (expired.length) {
      sql += ` AND museum NOT IN (${expired.map(() => '?').join(',')})`;
      params.push(...expired);
    }
    const rows = this.met.allSync<ObjectRow>(sql, params);
    return rows.length ? toMetObject(rows[0]) : undefined;
  }

  /** Capped display list in GALLERY_ORDER — counts/positions come from the
   *  full-ordering primitives below, never from this list's length/indices. */
  /**
   * Room-id → SQL scope. Scoped ids ("aic:241") pin the site; BARE Met ids
   * still need a site pin on multi-museum artifacts ("241" is also an AIC
   * code) — Met codes are unique across its two sites, so `site IN (met
   * sites)` is exact. Pre-v2 single-museum artifacts skip the clause.
   */
  private galleryScope(galleryId: string): { where: string; params: Array<string> } {
    const { site, galleryNumber } = parseRoomId(galleryId);
    if (site) return { where: 'galleryNumber = ? AND site = ?', params: [galleryNumber, site] };
    if (!this.hasMuseumColumn) return { where: 'galleryNumber = ?', params: [galleryNumber] };
    const metSites = [...MET_SITE_IDS];
    return {
      where: `galleryNumber = ? AND site IN (${metSites.map(() => '?').join(',')})`,
      params: [galleryNumber, ...metSites],
    };
  }

  objectsInGallery(galleryId: string): MetObject[] {
    const s = this.galleryScope(galleryId);
    const expired = this.scopedExpiredMuseums();
    let sql = `SELECT ${this.objectCols} FROM objects WHERE ${s.where}`;
    const params: Array<string | number> = [...s.params];
    if (expired.length) {
      sql += ` AND museum NOT IN (${expired.map(() => '?').join(',')})`;
      params.push(...expired);
    }
    sql += ` ORDER BY ${GALLERY_ORDER} LIMIT ?`;
    params.push(GALLERY_OBJECTS_LIMIT);
    return this.met.allSync<ObjectRow>(sql, params).map(toMetObject);
  }

  galleryObjectCount(galleryId: string): number {
    const s = this.galleryScope(galleryId);
    return this.met.allSync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM objects WHERE ${s.where}`,
      s.params,
    )[0].c;
  }

  objectGalleryPosition(objectID: number): { position: number; total: number } | undefined {
    const q = buildGalleryPositionQuery(objectID, { scopeByMuseum: this.hasMuseumColumn });
    return this.met.allSync<{ position: number; total: number }>(q.sql, q.params)[0];
  }

  galleryNeighbors(objectID: number): { prevObjectID: number; nextObjectID: number } | undefined {
    const q = buildGalleryNeighborsQuery(objectID, { scopeByMuseum: this.hasMuseumColumn });
    return this.met.allSync<{ prevObjectID: number; nextObjectID: number }>(q.sql, q.params)[0];
  }

  // --- rooms / map -------------------------------------------------------------

  getGallery(id: string): Room | undefined {
    const room = this.rooms.get(id);
    if (room?.site && this.expiredSiteIds.has(room.site)) return undefined;
    return room;
  }

  galleries(): Room[] {
    return this.visibleGalleryRooms();
  }

  museums(): MuseumEntry[] {
    return this.museumEntries;
  }

  amenities(): Room[] {
    return this.amenityRooms;
  }

  /** S2 map contract (components/MapGeometry.ts GeometryProvider). */
  galleriesGeometry(site: Site, floor: string): GalleryFeature[] {
    return this.geometryByFloor.get(`${site}|${floor}`) ?? [];
  }

  // --- routing -------------------------------------------------------------------

  /** Room id → shared/routing endpoint ref (site-scoped gallery key or node id). */
  private endpointRef(id: string): string | null {
    // Gallery rooms resolve through the SITE-SCOPED byGallery key — bare
    // codes are ambiguous once two museums have graphs (Met/Louvre "711").
    const room = this.rooms.get(id);
    if (room?.site) {
      const scoped = `${room.site}|${parseRoomId(id).galleryNumber}`;
      if (this.graph.byGallery.has(scoped)) return scoped;
    }
    if (this.graph.byGallery.has(id)) return id; // legacy bare fallback
    const viaAmenity = this.amenityNode.get(id);
    if (viaAmenity) return viaAmenity;
    if (this.graph.nodeById.has(id)) return id;
    if (id === 'great-hall') return this.entranceNodeId; // stub-era default anchor
    return null;
  }

  private project(site: string, lat: number, lon: number): [number, number] {
    const p = this.projectors.get(site);
    return p ? [p.x(lon), p.y(lat)] : [0, 0];
  }

  private stepRoom(s: SharedRouteStep): Room {
    if (s.gallery) {
      const nodeSite = this.graph.nodeById.get(s.nodeId)?.site;
      const room = this.rooms.get(scopedRoomId(nodeSite, s.gallery));
      if (room) return room;
    }
    const site = this.graph.nodeById.get(s.nodeId)?.site ?? 'fifthAve';
    const [x, y] = this.project(site, s.lat, s.lon);
    const kind: RoomKind =
      s.kind === 'stairs' ? 'stairs' : s.kind === 'elevator' ? 'elevator' : 'hall';
    return {
      id: s.nodeId,
      name: s.name,
      floor: s.floor,
      kind,
      rect: [x - 3, y - 3, 6, 6],
      site: site as Room['site'],
    };
  }

  route(from: string, to: string, opts?: { avoidStairs?: boolean }): Route | undefined {
    const fromRef = this.endpointRef(from);
    const toRef = this.endpointRef(to);
    if (!fromRef || !toRef) return undefined;
    const rr = sharedRoute(this.graph, fromRef, toRef, { avoidStairs: opts?.avoidStairs });
    if (!rr) return undefined;
    const steps = rr.steps.map((s) => ({ room: this.stepRoom(s), instruction: s.instruction }));
    const site = this.graph.nodeById.get(rr.path[0].id)?.site ?? 'fifthAve';
    const view = this.viewBoxBySite.get(site);
    return {
      from: steps[0].room,
      to: steps[steps.length - 1].room,
      steps,
      distance: rr.distanceM,
      ...(view
        ? {
            geo: {
              path: rr.path.map((p) => {
                const [x, y] = this.project(site, p.lat, p.lon);
                return { x, y, floor: p.floor };
              }),
              view,
            },
          }
        : {}),
    };
  }
}
