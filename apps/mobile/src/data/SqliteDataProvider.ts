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
  type GalleryFeature,
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
import { buildAutocompleteQuery, buildFullQuery, type SearchFilters } from '@met/shared/search';

import type { DataProvider, MetObject, Room, RoomKind, Route } from './provider';
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
  isHighlight: number;
  imageUrl: string;
}

const OBJECT_COLS =
  'objectID, accession, title, artist, period, classification, medium, galleryNumber, isHighlight, imageUrl';

function toMetObject(r: ObjectRow): MetObject {
  return {
    objectID: r.objectID,
    title: r.title,
    artist: r.artist,
    date: r.period,
    medium: r.medium,
    accession: r.accession,
    gallery: r.galleryNumber,
    dept: r.classification,
    credit: '',
    isHighlight: r.isHighlight === 1,
    img: r.imageUrl,
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

function floorNumber(label: string): number {
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
  ) {
    this.dataVersion = met.dataVersion;
  }

  static async create(met: MetDb): Promise<SqliteDataProvider> {
    const [galleryRows, amenityRows, nodes, edges, blob] = await Promise.all([
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
    ]);

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
    for (const [site, siteFeatures] of featuresBySite) {
      const projector = projectorFromFeatures(siteFeatures);
      if (!projector) continue;
      projectors.set(site, projector);
      const sg = buildSiteGeometry(geometryFn, site as Site);
      viewBoxBySite.set(site, sg.viewBox);
      for (const shapes of sg.shapesByFloor.values()) {
        for (const s of shapes) {
          if (s.kind === 'gallery' && !bboxByGallery.has(s.id)) bboxByGallery.set(s.id, s.bbox);
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
      const room: Room = {
        id: g.galleryNumber,
        name: g.title ?? `Gallery ${g.galleryNumber}`,
        floor: floorNumber(g.floor),
        kind: 'gallery',
        rect: bboxByGallery.get(g.galleryNumber) ?? [cx - 6, cy - 5, 12, 10],
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
      };
      rooms.set(id, room);
      amenityRooms.push(room);
      const node = nearestNode(a.site, floor, a.lat, a.lon);
      if (node) amenityNode.set(id, node);
    }

    const graph = buildRouteGraph(nodes, edges, galleryRows);
    const entrance = amenityRows.find((a) => a.type === 'entrance' && a.site === 'fifthAve');
    const entranceNodeId = entrance
      ? nearestNode('fifthAve', floorNumber(entrance.floor), entrance.lat, entrance.lon)
      : null;

    return new SqliteDataProvider(
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
    );
  }

  // --- search ----------------------------------------------------------------

  /** Ranked SearchRow ids → full MetObjects, preserving rank order. */
  private hydrate(ids: number[]): MetObject[] {
    if (ids.length === 0) return [];
    const rows = this.met.allSync<ObjectRow>(
      `SELECT ${OBJECT_COLS} FROM objects WHERE objectID IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.objectID, toMetObject(r)]));
    return ids.map((id) => byId.get(id)).filter((o): o is MetObject => o !== undefined);
  }

  searchAutocomplete(query: string, limit = 8): MetObject[] {
    const q = buildAutocompleteQuery(query); // builder caps at top 8
    if (q === null) return [];
    const rows = this.met.allSync<{ objectID: number }>(q.sql, q.params);
    return this.hydrate(rows.slice(0, limit).map((r) => r.objectID));
  }

  searchAll(query: string, filters: SearchFilters = {}): MetObject[] {
    const q = buildFullQuery(query, filters, { limit: SEARCH_ALL_LIMIT });
    if (q === null) return [];
    const rows = this.met.allSync<{ objectID: number }>(q.sql, q.params);
    return this.hydrate(rows.map((r) => r.objectID));
  }

  getObject(objectID: number): MetObject | undefined {
    const rows = this.met.allSync<ObjectRow>(
      `SELECT ${OBJECT_COLS} FROM objects WHERE objectID = ?`,
      [objectID],
    );
    return rows.length ? toMetObject(rows[0]) : undefined;
  }

  objectsInGallery(galleryId: string): MetObject[] {
    return this.met
      .allSync<ObjectRow>(
        `SELECT ${OBJECT_COLS} FROM objects WHERE galleryNumber = ?
         ORDER BY isHighlight DESC, objectID LIMIT ?`,
        [galleryId, GALLERY_OBJECTS_LIMIT],
      )
      .map(toMetObject);
  }

  // --- rooms / map -------------------------------------------------------------

  getGallery(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  galleries(): Room[] {
    return this.galleryRooms;
  }

  amenities(): Room[] {
    return this.amenityRooms;
  }

  /** S2 map contract (components/MapGeometry.ts GeometryProvider). */
  galleriesGeometry(site: Site, floor: string): GalleryFeature[] {
    return this.geometryByFloor.get(`${site}|${floor}`) ?? [];
  }

  // --- routing -------------------------------------------------------------------

  /** Room id → shared/routing endpoint ref (gallery number or node id). */
  private endpointRef(id: string): string | null {
    if (this.graph.byGallery.has(id)) return id;
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
      const room = this.rooms.get(s.gallery);
      if (room) return room;
    }
    const site = this.graph.nodeById.get(s.nodeId)?.site ?? 'fifthAve';
    const [x, y] = this.project(site, s.lat, s.lon);
    const kind: RoomKind =
      s.kind === 'stairs' ? 'stairs' : s.kind === 'elevator' ? 'elevator' : 'hall';
    return { id: s.nodeId, name: s.name, floor: s.floor, kind, rect: [x - 3, y - 3, 6, 6] };
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
