/**
 * DataProvider — the single data surface the UI talks to.
 *
 * Two implementations:
 *  - StubDataProvider (below) over stub.json — the Gate A mockup dataset.
 *  - SqliteDataProvider (./SqliteDataProvider.ts) over the downloaded
 *    met.sqlite artifact, opened through the ./sqlite seam (native:
 *    expo-sqlite; web: official sqlite-wasm in memory + Cache API).
 *
 * Selection (see ./DataGate.tsx): the app boots with SqliteDataProvider when
 * EXPO_PUBLIC_DATA=real (production builds set this); anything else — notably
 * plain `npm run web` dev and the existing e2e checks — gets the stub.
 */
import { createContext, useContext } from 'react';

import { matchGalleries, type SearchFilters } from '@met/shared/search';
import type { components } from '@met/shared';

import stub from './stub.json';

export interface MetObject {
  objectID: number;
  title: string;
  artist: string;
  date: string;
  medium: string;
  accession: string;
  gallery: string; // Met gallery number, '' if not on view
  dept: string;
  credit: string;
  isHighlight: boolean;
  img: string;
  /**
   * Key prefix of the pre-generated image derivatives in the public Tigris
   * bucket (see ./imageCdn.ts), e.g. "img/35/df74b8631bd3". ''/undefined
   * (stub objects, objects newer than the last thumbnail run, pre-thumbKey
   * met.sqlite artifacts) → components fall back to the server image proxy
   * (web) / direct Met CDN (native).
   */
  thumbKey?: string;
  /**
   * Museum registry id ("met" | "aic" | …; schema v2 meta.museums). undefined
   * on the stub and on pre-v2 met.sqlite artifacts — always treat as 'met'
   * (see objectMuseumId below), never compare directly.
   */
  museum?: string;
  /** Globally-unique site id the object's gallery belongs to (schema v2). */
  site?: string;
  /**
   * Museum-native record id — fills the museum's objectUrlTemplate for the
   * outbound "view on ..." link. undefined on the stub; the Met's sourceId
   * equals String(objectID).
   */
  sourceId?: string;
}

/** Outbound deep link to the object's page on its museum's own site. */
export function objectSourceUrl(o: MetObject, museums: MuseumEntry[]): string | null {
  const m = museums.find((e) => e.id === objectMuseumId(o));
  const template = m?.objectUrlTemplate;
  if (!template) return null;
  return template.replace('{sourceId}', o.sourceId ?? String(o.objectID));
}

/** `object.museum` with the pre-v2/stub convention resolved: undefined = 'met'. */
export function objectMuseumId(o: { museum?: string }): string {
  return o.museum ?? BUILTIN_MET_ENTRY.id;
}

// --- room identity ----------------------------------------------------------
// Room codes COLLIDE across museums (102 codes as of the 6-museum artifact:
// "241" is a Met gallery and an AIC gallery; "711" is Met and Louvre). Room
// ids are therefore site-scoped — "{site}:{code}" — for every non-Met site.
// Met sites keep BARE codes: they predate multi-museum and live in deep links
// (/?focus=131), route URLs (/?nav=131:822) and the e2e suites; within the
// Met the pair (fifthAve, cloisters) never shares a code (canonicalized at
// build). Registry site ids never contain ":".

// Literal (not derived from BUILTIN_MET_ENTRY, which is declared later in
// this module) — the pair is frozen; a unit test asserts they stay in sync.
export const MET_SITE_IDS: ReadonlySet<string> = new Set(['fifthAve', 'cloisters']);

export function scopedRoomId(site: string | undefined, galleryNumber: string): string {
  return !site || MET_SITE_IDS.has(site) ? galleryNumber : `${site}:${galleryNumber}`;
}

export function parseRoomId(id: string): { site?: string; galleryNumber: string } {
  const i = id.indexOf(':');
  return i === -1 ? { galleryNumber: id } : { site: id.slice(0, i), galleryNumber: id.slice(i + 1) };
}

/** All site ids belonging to a museum entry, for room/object site membership checks. */
export function museumSiteIds(museum: MuseumEntry): Set<string> {
  return new Set(museum.sites.map((s) => s.siteId));
}

/** The MuseumEntry that owns a site id (undefined site defaults to 'fifthAve', the
 *  long-standing convention for anchors/rooms predating multi-site data). */
export function museumForSite(museums: MuseumEntry[], site: string | undefined): MuseumEntry | undefined {
  const s = site ?? 'fifthAve';
  return museums.find((m) => m.sites.some((x) => x.siteId === s));
}

/**
 * Best available "last confirmed from source" date for a museum (C3
 * staleness UI): the museum's own `fetchedAt`, falling back to the whole
 * artifact's `builtAt` (every museum in a merged artifact was re-verified at
 * least as of that build) — undefined only for the stub (StubDataProvider
 * has neither), meaning there is nothing honest to show.
 */
export function museumFreshness(museum: MuseumEntry | undefined, data: DataProvider): string | undefined {
  return museum?.fetchedAt ?? data.builtAt;
}

/** Partition rows (search hits, etc.) by whether they belong to the active museum. */
export function partitionByMuseum<T extends { museum?: string }>(
  rows: readonly T[],
  activeMuseumId: string,
): { active: T[]; other: T[] } {
  const active: T[] = [];
  const other: T[] = [];
  for (const r of rows) (objectMuseumId(r) === activeMuseumId ? active : other).push(r);
  return { active, other };
}

/**
 * Stub kinds plus the real amenities-table type vocabulary (met.sqlite
 * `amenities.type`) plus the named-place polygon kinds the Living Map
 * geometry carries beyond the amenities table (library/auditorium/…).
 * UI code must not switch exhaustively on this.
 */
export type RoomKind =
  | 'gallery'
  | 'hall'
  | 'restroom'
  | 'elevator'
  | 'stairs'
  | 'escalator'
  | 'dining'
  | 'water'
  | 'info'
  | 'entrance'
  | 'shop'
  | 'tickets'
  | 'cloakroom'
  | 'firstAid'
  | 'library'
  | 'auditorium'
  | 'classroom'
  | 'changing_room';

export interface Room {
  id: string; // gallery number or amenity id, e.g. '131', 'restroom-1'
  name: string;
  floor: number;
  kind: RoomKind;
  /** [x, y, w, h] in the stub's local schematic coordinate system. */
  rect: [number, number, number, number];
  /**
   * Venue (globally-unique site id) the room belongs to. The stub dataset
   * omits it (all stub rooms are Fifth Avenue); consumers treat undefined as
   * 'fifthAve'. Schema v2 opens the set beyond the Met's two buildings.
   */
  site?: string;
  /**
   * Currently inaccessible per the Met's own live map feed (the Living Map
   * `closed` flag, refreshed nightly). Binary current-state only — the Met
   * publishes no schedule metadata (see docs/DATA.md). Closed rooms stay
   * tappable on the map but offer no DIRECTIONS / I'M HERE actions.
   */
  closed?: boolean;
}

export interface RouteStep {
  room: Room;
  /** Human instruction for this leg, e.g. "Take the elevator to Floor 2". */
  instruction: string;
}

export interface Route {
  from: Room;
  to: Room;
  steps: RouteStep[];
  /** Total path length in stub coordinate units (~meters). */
  distance: number;
  /**
   * Real-geometry overlay payload (routing ⇄ real-provider contract): the
   * graph node path from shared/routing (RouteResult.path) projected into
   * FloorMap's meter space, plus the SVG viewBox of that projection (the real
   * map's MapGeometry buildSiteGeometry().viewBox) — so RoutePolyline overlays
   * the real FloorMap without re-deriving the projection. The stub provider
   * omits it and RoutePolyline falls back to room-center segments.
   */
  geo?: {
    path: { x: number; y: number; floor: number }[];
    view: { x: number; y: number; w: number; h: number };
  };
}

export interface DataProvider {
  /**
   * met.sqlite artifact version, used to cache-bust /api/v1/img URLs.
   * The stub provider reports 'stub', which tells ObjectImage there is no
   * server to proxy through (mockup mode → direct CDN URLs).
   */
  readonly dataVersion: string;
  /**
   * When the current met.sqlite artifact was built (meta.builtAt, schema v2)
   * — the staleness-UI fallback for a museum whose own `fetchedAt` is null
   * (see museumFreshness above). undefined for the stub and pre-v2 artifacts
   * (nothing to fall back to; StalenessBadge then renders nothing).
   */
  readonly builtAt?: string;
  /**
   * Prefix/substring suggestions for the omnibar (objects + rooms). Optional
   * `museum` scopes to one museum registry id at the SQL level (ScopeChips
   * "AT {museum}" selection, schema v2 multi-museum artifacts) — the stub and
   * pre-v2 artifacts ignore it (single museum, nothing to scope).
   */
  searchAutocomplete(query: string, limit?: number, museum?: string): MetObject[];
  /**
   * Gallery rooms matching the query, for the omnibar's room rows: digit
   * queries match gallery numbers (exact first, then prefixes), queries with
   * letters match gallery titles ("dendur" → The Temple of Dendur). Ranking
   * lives in shared/search.ts matchGalleries.
   */
  searchGalleries(query: string, limit?: number): Room[];
  /**
   * Full result list for the All Results screen. Optional SQL-level filters
   * (museum / site / floor / rotation / hasImage) — the stub ignores them;
   * the UI's SearchFilterChips post-filter still applies either way.
   */
  searchAll(query: string, filters?: SearchFilters): MetObject[];
  getObject(objectID: number): MetObject | undefined;
  getGallery(id: string): Room | undefined;
  /**
   * In-room display list, in the canonical gallery ordering (highlights
   * first, then objectID). CAPPED for rendering (SqliteDataProvider stops at
   * 500; the densest gallery holds ~4.5k objects) — never derive counts or
   * positions from it; use the primitives below.
   */
  objectsInGallery(galleryId: string): MetObject[];
  /** TRUE object count of a gallery (objectsInGallery is capped). */
  galleryObjectCount(galleryId: string): number;
  /**
   * 1-based position of an object within the FULL canonical ordering of its
   * gallery + the gallery's true total. undefined when the object is unknown
   * or not on view — callers hide the counter rather than show a wrong one.
   */
  objectGalleryPosition(objectID: number): { position: number; total: number } | undefined;
  /**
   * Previous/next object in the FULL canonical gallery ordering, wrapping
   * around at the true ends (J15 browse loop). Both equal the input in a
   * single-object gallery; undefined when the object is unknown/not on view.
   */
  galleryNeighbors(objectID: number): { prevObjectID: number; nextObjectID: number } | undefined;
  route(from: string, to: string, opts?: { avoidStairs?: boolean }): Route | undefined;
  /** All visitable rooms (galleries + halls). */
  galleries(): Room[];
  /** Restrooms, elevators, stairs. */
  amenities(): Room[];
  /**
   * Museums contained in the artifact (schema v2 meta.museums: identity,
   * sites with entrances + floorOrder, fidelity/capabilities, licensing
   * attribution, freshness). Same shape as GET /api/v1/museums entries.
   * Pre-v2 artifacts and the stub return the built-in Met entry.
   */
  museums(): MuseumEntry[];
  /**
   * Museum registry ids currently hidden by the license-TTL mechanism (a
   * museum whose registry license.ttlDays has lapsed against the shipped
   * artifact's age — see SqliteDataProvider's constructor and
   * ARCHITECTURE.md "Provenance & the license-TTL mechanism"). Every search/
   * browse method already excludes these museums' rows; DataGate reads this
   * to force an immediate version check rather than serving a session that
   * may go on hiding a museum indefinitely. The stub and pre-v2 artifacts
   * return [] (nothing ever expires).
   */
  expiredMuseums(): string[];
}

export type MuseumEntry = components['schemas']['MuseumEntry'];

/** Met manifest entry used when the artifact predates schema v2 (and by the stub). */
export const BUILTIN_MET_ENTRY: MuseumEntry = {
  id: 'met',
  name: 'The Metropolitan Museum of Art',
  shortName: 'The Met',
  city: 'New York',
  country: 'US',
  sites: [
    {
      siteId: 'fifthAve',
      name: 'Fifth Avenue',
      entrance: { lat: 40.7794, lon: -73.9632, floor: '1' },
      floorOrder: ['G', '1', '1M', '2', '3', '4', '5'],
    },
    {
      siteId: 'cloisters',
      name: 'The Cloisters',
      entrance: { lat: 40.8649, lon: -73.9317 },
      floorOrder: ['G', '1'],
    },
  ],
  fidelity: 'routed',
  license: {
    text: 'CC0-1.0',
    images: 'CC0-1.0',
    attribution: 'The Metropolitan Museum of Art Open Access (CC0)',
    termsUrl: 'https://www.metmuseum.org/policies/open-access',
  },
  capabilities: { hasGeometry: true, hasGraph: true, granularity: 'room', languages: ['en'] },
};

interface StubShape {
  floors: number[];
  rooms: Room[];
  nodes: { id: string; floor: number; x: number; y: number }[];
  edges: { a: string; b: string; kind: 'walk' | 'stairs' | 'elevator' }[];
  objects: MetObject[];
}

const data = stub as unknown as StubShape;

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export class StubDataProvider implements DataProvider {
  readonly dataVersion = 'stub';
  private rooms = new Map(data.rooms.map((r) => [r.id, r]));
  private objects = new Map(data.objects.map((o) => [o.objectID, o]));
  private nodes = new Map(data.nodes.map((n) => [n.id, n]));

  // `museum`/`filters.museum` accepted for interface parity; the stub is
  // always single-museum, so there is never anything to scope.
  searchAutocomplete(query: string, limit = 8, _museum?: string): MetObject[] {
    return this.searchAll(query).slice(0, limit);
  }

  searchAll(query: string, _filters?: SearchFilters): MetObject[] {
    const q = norm(query.trim());
    if (!q) return [];
    const scored: { o: MetObject; score: number }[] = [];
    for (const o of data.objects) {
      const title = norm(o.title);
      const artist = norm(o.artist);
      const hay = `${title} ${artist} ${norm(o.dept)} ${norm(o.medium)} ${o.gallery}`;
      let score = -1;
      if (title.startsWith(q)) score = 0;
      else if (title.includes(q)) score = 1;
      else if (artist.includes(q)) score = 2;
      else if (q.split(/\s+/).every((w) => hay.includes(w))) score = 3;
      if (score >= 0) scored.push({ o, score: score - (o.isHighlight ? 0.5 : 0) });
    }
    return scored.sort((a, b) => a.score - b.score).map((s) => s.o);
  }

  searchGalleries(query: string, limit = 4): Room[] {
    // Stub room names embed the number ("Gallery 131 · The Temple of Dendur"),
    // so title matching covers both forms; halls (The Great Hall) included.
    return matchGalleries(
      this.galleries().map((room) => ({ galleryNumber: room.id, title: room.name, room })),
      query,
      limit,
    ).map((hit) => hit.room);
  }

  getObject(objectID: number): MetObject | undefined {
    return this.objects.get(objectID);
  }

  getGallery(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  objectsInGallery(galleryId: string): MetObject[] {
    return data.objects.filter((o) => o.gallery === galleryId);
  }

  galleryObjectCount(galleryId: string): number {
    return this.objectsInGallery(galleryId).length;
  }

  // Stub datasets are tiny — the array IS the full ordering, so the
  // position/neighbor primitives are plain index math over it.
  private galleryIndex(objectID: number): { list: MetObject[]; i: number } | undefined {
    const o = this.objects.get(objectID);
    if (!o?.gallery) return undefined;
    const list = this.objectsInGallery(o.gallery);
    const i = list.findIndex((x) => x.objectID === objectID);
    return i < 0 ? undefined : { list, i };
  }

  objectGalleryPosition(objectID: number): { position: number; total: number } | undefined {
    const hit = this.galleryIndex(objectID);
    return hit ? { position: hit.i + 1, total: hit.list.length } : undefined;
  }

  galleryNeighbors(objectID: number): { prevObjectID: number; nextObjectID: number } | undefined {
    const hit = this.galleryIndex(objectID);
    if (!hit) return undefined;
    const { list, i } = hit;
    return {
      prevObjectID: list[(i - 1 + list.length) % list.length].objectID,
      nextObjectID: list[(i + 1) % list.length].objectID,
    };
  }

  galleries(): Room[] {
    return data.rooms.filter((r) => r.kind === 'gallery' || r.kind === 'hall');
  }

  amenities(): Room[] {
    return data.rooms.filter(
      (r) => r.kind === 'restroom' || r.kind === 'elevator' || r.kind === 'stairs',
    );
  }

  museums(): MuseumEntry[] {
    return [BUILTIN_MET_ENTRY];
  }

  expiredMuseums(): string[] {
    return [];
  }

  route(from: string, to: string, opts?: { avoidStairs?: boolean }): Route | undefined {
    const fromRoom = this.rooms.get(from);
    const toRoom = this.rooms.get(to);
    if (!fromRoom || !toRoom) return undefined;

    // Dijkstra over the stub graph (Euclidean edge weights; fixed cost for
    // floor changes). Tiny graph — no priority queue needed.
    const adj = new Map<string, { id: string; w: number; kind: string }[]>();
    const add = (a: string, b: string, kind: string) => {
      if (opts?.avoidStairs && kind === 'stairs') return;
      const na = this.nodes.get(a)!;
      const nb = this.nodes.get(b)!;
      const w = kind === 'walk' ? Math.hypot(na.x - nb.x, na.y - nb.y) : 15;
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push({ id: b, w, kind });
    };
    for (const e of data.edges) {
      add(e.a, e.b, e.kind);
      add(e.b, e.a, e.kind);
    }

    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { id: string; kind: string }>();
    const visited = new Set<string>();
    while (true) {
      let cur: string | undefined;
      let best = Infinity;
      for (const [id, d] of dist) {
        if (!visited.has(id) && d < best) {
          best = d;
          cur = id;
        }
      }
      if (cur === undefined) return undefined; // unreachable
      if (cur === to) break;
      visited.add(cur);
      for (const { id, w, kind } of adj.get(cur) ?? []) {
        const nd = best + w;
        if (nd < (dist.get(id) ?? Infinity)) {
          dist.set(id, nd);
          prev.set(id, { id: cur, kind });
        }
      }
    }

    const ids: string[] = [to];
    const viaKind = new Map<string, string>();
    for (let cur = to; cur !== from; ) {
      const p = prev.get(cur)!;
      viaKind.set(cur, p.kind);
      ids.unshift(p.id);
      cur = p.id;
    }

    const steps: RouteStep[] = ids.map((id, i) => {
      const room = this.rooms.get(id)!;
      if (i === 0) return { room, instruction: `Start in ${room.name}` };
      const kind = viaKind.get(id);
      if (kind === 'stairs')
        return { room, instruction: `Take the stairs to Floor ${room.floor}` };
      if (kind === 'elevator')
        return { room, instruction: `Take the elevator to Floor ${room.floor}` };
      if (i === ids.length - 1)
        return { room, instruction: `Arrive at ${room.name}` };
      if (room.kind === 'elevator') return { room, instruction: 'Go to the elevator' };
      if (room.kind === 'stairs') return { room, instruction: 'Go to the stairs' };
      return { room, instruction: `Walk through ${room.name}` };
    });

    return { from: fromRoom, to: toRoom, steps, distance: dist.get(to)! };
  }
}

export const DataContext = createContext<DataProvider>(new StubDataProvider());

export function useData(): DataProvider {
  return useContext(DataContext);
}
