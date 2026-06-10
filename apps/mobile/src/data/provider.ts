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

import type { SearchFilters } from '@met/shared/search';

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
}

/**
 * Stub kinds plus the real amenities-table type vocabulary (met.sqlite
 * `amenities.type`). UI code must not switch exhaustively on this.
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
  | 'firstAid';

export interface Room {
  id: string; // gallery number or amenity id, e.g. '131', 'restroom-1'
  name: string;
  floor: number;
  kind: RoomKind;
  /** [x, y, w, h] in the stub's local schematic coordinate system. */
  rect: [number, number, number, number];
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
  /** Prefix/substring suggestions for the omnibar (objects + rooms). */
  searchAutocomplete(query: string, limit?: number): MetObject[];
  /**
   * Full result list for the All Results screen. Optional SQL-level filters
   * (site / floor / rotation / hasImage) — the stub ignores them; the UI's
   * SearchFilterChips post-filter still applies either way.
   */
  searchAll(query: string, filters?: SearchFilters): MetObject[];
  getObject(objectID: number): MetObject | undefined;
  getGallery(id: string): Room | undefined;
  objectsInGallery(galleryId: string): MetObject[];
  route(from: string, to: string, opts?: { avoidStairs?: boolean }): Route | undefined;
  /** All visitable rooms (galleries + halls). */
  galleries(): Room[];
  /** Restrooms, elevators, stairs. */
  amenities(): Room[];
}

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

  searchAutocomplete(query: string, limit = 8): MetObject[] {
    return this.searchAll(query).slice(0, limit);
  }

  searchAll(query: string): MetObject[] {
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

  getObject(objectID: number): MetObject | undefined {
    return this.objects.get(objectID);
  }

  getGallery(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  objectsInGallery(galleryId: string): MetObject[] {
    return data.objects.filter((o) => o.gallery === galleryId);
  }

  galleries(): Room[] {
    return data.rooms.filter((r) => r.kind === 'gallery' || r.kind === 'hall');
  }

  amenities(): Room[] {
    return data.rooms.filter(
      (r) => r.kind === 'restroom' || r.kind === 'elevator' || r.kind === 'stairs',
    );
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
