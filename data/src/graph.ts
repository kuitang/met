/**
 * Graph pipeline → data/snapshots/graph.json
 *
 * The Living Map tiles do NOT contain a wayfinding graph (the 7 `route|walking`
 * lines are static showcase paths; live A→B routing is injected per-request and
 * never tiled). The routing graph is therefore DERIVED from structure that *is*
 * tiled, reading only the committed raw cache under data/raw/livingmap/ (no network):
 *
 *   nodes = walkable spaces: room polygons (gallery/exhibition/corridor/...) from
 *           galleries.geojson + circulation units (lift/stairs/escalator/steps
 *           polygons decoded from the z18 tiles — they are carved out of the floor
 *           plate and are NOT inside any room polygon, verified empirically)
 *   door nodes = `barrier` lines of type door|threshold: probe each line segment's
 *           midpoint perpendicular on both sides (0.4→2.5 m, smallest containing
 *           space wins) → the two spaces it connects; cluster segments joining the
 *           same pair within DOOR_CLUSTER_M into one doorway = one node at the
 *           crossing point. Each doorway gets two kind="door" edges to its two
 *           spaces' centroid nodes (carrying the compass bearing door→space, for
 *           "exit through the {dir} door"), and every room links its own doorways
 *           pairwise with kind="walk" edges (tagged with the room id) so path
 *           lengths measure real door-to-door walking, not centroid detours.
 *   stairs/elevator edges = vertical shafts: lift/stairs units grouped across
 *           floors by horizontal polygon overlap/near-touch (union-find, gap ≤
 *           SHAFT_GAP_M — measured: 120/132 units overlap their cross-floor twin,
 *           while centroids drift up to tens of meters because each floor draws
 *           its own flight footprint); consecutive floors of a shaft are linked
 *           (len = effort-equivalent meters per level).
 *
 * Edge lengths are haversine meters (straight-line within a room — slightly
 * optimistic for concave corridors; centroid spokes only at route endpoints).
 *
 * Inline verification (run `npm -w data run graph`): connected components per site,
 * Dijkstra success on random gallery pairs, Great Hall → gallery 822 plausibility,
 * reachability of every gallery holding on-view objects (objects.json.gz).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import polygonClipping from "polygon-clipping";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_TILES = path.join(DATA_DIR, "raw", "livingmap", "tiles", "18");
const SNAP = path.join(DATA_DIR, "snapshots");

const Z = 18;
const EXTENT = 4096;
const WORLD = 2 ** Z * EXTENT;

// Tunables (all meters).
const PROBE_OFFSETS_M = [0.4, 0.8, 1.5, 2.5]; // perpendicular probe distances from a door segment
const DOOR_CLUSTER_M = 3; // door segments joining the same room pair within this radius = one doorway
const SHAFT_GAP_M = 0.75; // max horizontal polygon gap between cross-floor units of one shaft
const STAIRS_M_PER_LEVEL = 15; // effort-equivalent length of one level by stairs
const ELEVATOR_M_PER_LEVEL = 25; // includes average wait; tune in Phase 2 if needed
const REPAIR_GAP_M = 1.25; // max polygon gap (≈ wall thickness) for fallback walk edges between touching spaces

// Room types a visitor can walk through (galleries.geojson `type`).
const WALKABLE_ROOM_TYPES = new Set([
  "gallery", "exhibition", "corridor", "vista", "shop", "restaurant", "cafe", "bar",
  "library", "auditorium", "classroom", "cloakroom", "tickets", "toilet", "changing_room",
]);
const UNIT_TYPES = new Set(["lift", "stairs", "escalator", "steps"]);

// ---------- projection helpers ----------
const D2R = Math.PI / 180;
const LAT0 = 40.78; // local equirectangular scale (both sites; scale error < 0.02% at Cloisters)
const MX = Math.cos(LAT0 * D2R) * 111319.49;
const MY = 110946;
type Pt = [number, number];
const toLonLat = (wx: number, wy: number): Pt => [
  (wx / WORLD) * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / WORLD))) * 180) / Math.PI,
];
const toM = ([lon, lat]: Pt): Pt => [lon * MX, lat * MY]; // origin-free: only differences are used
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- polygon helpers (meter space) ----------
type Ring = Pt[];
type Poly = Ring[]; // [exterior, ...holes]

function pointInRing(p: Pt, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pointInPolys = (p: Pt, polys: Poly[]): boolean =>
  polys.some((rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((h) => pointInRing(p, h)));

function polysArea(polys: Poly[]): number {
  let total = 0;
  for (const rings of polys) {
    const ext = rings[0];
    const [ox, oy] = ext[0]; // local origin: avoids fp cancellation at ~6e6 m magnitudes
    let a = 0;
    for (let i = 0; i < ext.length - 1; i++)
      a += (ext[i][0] - ox) * (ext[i + 1][1] - oy) - (ext[i + 1][0] - ox) * (ext[i][1] - oy);
    total += Math.abs(a / 2);
  }
  return total;
}

/** Area centroid of the largest polygon (robust for L-shaped rooms vs vertex mean). */
function polysCentroid(polys: Poly[]): Pt {
  let best: Ring | null = null;
  let bestA = -1;
  for (const rings of polys) {
    const ext = rings[0];
    const [ox, oy] = ext[0];
    let a = 0;
    for (let i = 0; i < ext.length - 1; i++)
      a += (ext[i][0] - ox) * (ext[i + 1][1] - oy) - (ext[i + 1][0] - ox) * (ext[i][1] - oy);
    if (Math.abs(a) > bestA) {
      bestA = Math.abs(a);
      best = ext;
    }
  }
  const ext = best!;
  // Compute relative to a local origin: at raw magnitudes (~6e6 m from lon/lat scaling) the
  // shoelace cross-products cancel catastrophically and small rooms get centroids km off.
  const [ox, oy] = ext[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ext.length - 1; i++) {
    const x1 = ext[i][0] - ox;
    const y1 = ext[i][1] - oy;
    const x2 = ext[i + 1][0] - ox;
    const y2 = ext[i + 1][1] - oy;
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) return ext[0];
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

/** Min distance between two polygon sets' exterior boundaries (vertex-to-segment, symmetric). */
function polysGap(a: Poly[], b: Poly[]): number {
  let min = Infinity;
  const vertsToEdges = (vs: Poly[], es: Poly[]) => {
    for (const rings of vs)
      for (const p of rings[0])
        for (const rings2 of es) {
          const ring = rings2[0];
          for (let i = 0; i + 1 < ring.length; i++) {
            min = Math.min(min, pointSegDist(p, ring[i], ring[i + 1]));
            if (min === 0) return;
          }
        }
  };
  vertsToEdges(a, b);
  vertsToEdges(b, a);
  return min;
}
function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ---------- node model ----------
interface Space {
  id: string;
  kind: "room" | "lift" | "stairs" | "escalator" | "steps";
  site: "fifthAve" | "cloisters";
  floor: number; // floor_level: G=0, 1, 1M=1.5, 2, 3, 4, 5
  gallery: string | null;
  name: string | null;
  polysM: Poly[]; // meter space
  area: number;
  centroidLL: Pt; // [lon, lat]
}

function main(): void {
  // ---- 1. rooms from the committed snapshot ----
  const gj = JSON.parse(fs.readFileSync(path.join(SNAP, "galleries.geojson"), "utf8"));
  const spaces: Space[] = [];
  for (const f of gj.features) {
    const p = f.properties;
    if (!WALKABLE_ROOM_TYPES.has(p.type)) continue;
    const polysLL: Poly[] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const polysM = polysLL.map((rings) => rings.map((ring) => ring.map((c: Pt) => toM(c))));
    const cM = polysCentroid(polysM);
    spaces.push({
      id: `r${p.geomId}f${p.floor}`,
      kind: "room",
      site: p.site,
      floor: p.floor,
      gallery: p.galleryNumber ?? null,
      name: p.title ?? p.name ?? null,
      polysM,
      area: polysArea(polysM),
      centroidLL: [round7(cM[0] / MX), round7(cM[1] / MY)],
    });
  }

  // ---- 2. decode cached z18 tiles: door/threshold segments + circulation unit polygons ----
  interface UnitAccum {
    type: string;
    site: Space["site"];
    floor: number;
    name: string | null;
    pieces: Poly[][]; // per-tile MultiPolygon pieces in WORLD units (buffered, overlap-stitchable)
  }
  const doorSegs = new Map<string, Map<string, { a: Pt; b: Pt }>>(); // site|floor -> segKey -> world seg
  const units = new Map<string, UnitAccum>(); // geom_id|floor_id
  for (const xDir of fs.readdirSync(RAW_TILES)) {
    for (const yFile of fs.readdirSync(path.join(RAW_TILES, xDir))) {
      if (!yFile.endsWith(".pbf")) continue;
      const tx = Number(xDir);
      const ty = Number(yFile.replace(".pbf", ""));
      const vt = new VectorTile(new PbfReader(fs.readFileSync(path.join(RAW_TILES, xDir, yFile))));
      const layer = vt.layers["indoor"];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties as Record<string, unknown>;
        const site: Space["site"] = p.location_name === "The Met Cloisters" ? "cloisters" : "fifthAve";
        const floor = Number(p.floor_level);
        if (p.category === "barrier" && (p.type === "door" || p.type === "threshold") && f.type === 2) {
          const fk = `${site}|${floor}`;
          let m = doorSegs.get(fk);
          if (!m) doorSegs.set(fk, (m = new Map()));
          for (const line of f.loadGeometry()) {
            const w = line.map((pt) => [tx * EXTENT + pt.x, ty * EXTENT + pt.y] as Pt);
            for (let j = 0; j + 1 < w.length; j++) {
              const [a, b] = [w[j], w[j + 1]];
              const ka = `${Math.round(a[0])},${Math.round(a[1])}`;
              const kb = `${Math.round(b[0])},${Math.round(b[1])}`;
              if (ka === kb) continue;
              m.set(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, { a, b });
            }
          }
        } else if (p.category === "unit" && UNIT_TYPES.has(String(p.type)) && f.type === 3) {
          const id = `${p.geom_id}|${p.floor_id}`;
          let u = units.get(id);
          if (!u)
            units.set(
              id,
              (u = {
                type: String(p.type),
                site,
                floor,
                name: (p.name as string) ?? null,
                pieces: [],
              })
            );
          const rings: Ring[] = [];
          for (const ringRaw of f.loadGeometry()) {
            const world: Ring = ringRaw.map((pt) => [tx * EXTENT + pt.x, ty * EXTENT + pt.y]);
            if (world.length >= 3) {
              const [f0, l0] = [world[0], world[world.length - 1]];
              if (f0[0] !== l0[0] || f0[1] !== l0[1]) world.push(f0);
              rings.push(world);
            }
          }
          if (rings.length > 0) u.pieces.push([rings]); // shaft-scale: treat all rings as one polygon
        }
      }
    }
  }

  // unit pieces (world) -> stitched meter polygons -> Space nodes
  for (const [id, u] of units) {
    let merged: Poly[];
    if (u.pieces.length === 1) merged = u.pieces[0];
    else {
      try {
        merged = polygonClipping.union(...(u.pieces as [Poly[], ...Poly[][]])) as unknown as Poly[];
      } catch {
        merged = u.pieces.flat();
      }
    }
    const polysM = merged.map((rings) => rings.map((ring) => ring.map(([wx, wy]) => toM(toLonLat(wx, wy)))));
    const cM = polysCentroid(polysM);
    spaces.push({
      id: `u${id.replace("|", "f")}`,
      kind: u.type as Space["kind"],
      site: u.site,
      floor: u.floor,
      gallery: null,
      name: u.name,
      polysM,
      area: polysArea(polysM),
      centroidLL: [round7(cM[0] / MX), round7(cM[1] / MY)],
    });
  }

  const byFloor = new Map<string, Space[]>();
  for (const s of spaces) {
    const k = `${s.site}|${s.floor}`;
    let l = byFloor.get(k);
    if (!l) byFloor.set(k, (l = []));
    l.push(s);
  }
  console.log(
    `spaces: ${spaces.length} (rooms ${spaces.filter((s) => s.kind === "room").length}, units ${
      spaces.filter((s) => s.kind !== "room").length
    }); door segments: ${[...doorSegs.values()].reduce((n, m) => n + m.size, 0)}`
  );

  // ---- 3. door edges: probe both sides of every segment, cluster per room pair ----
  interface Doorway {
    a: Space;
    b: Space;
    midsM: Pt[];
  }
  const doorways = new Map<string, Doorway[]>(); // pairKey -> doorway clusters
  let segsTwoSided = 0;
  for (const [fk, m] of doorSegs) {
    const floorSpaces = byFloor.get(fk) ?? [];
    for (const { a, b } of m.values()) {
      const aM = toM(toLonLat(a[0], a[1]));
      const bM = toM(toLonLat(b[0], b[1]));
      const L = Math.hypot(bM[0] - aM[0], bM[1] - aM[1]);
      if (L < 0.05) continue;
      const mid: Pt = [(aM[0] + bM[0]) / 2, (aM[1] + bM[1]) / 2];
      const nx = -(bM[1] - aM[1]) / L;
      const ny = (bM[0] - aM[0]) / L;
      const probe = (sign: 1 | -1): Space | null => {
        for (const off of PROBE_OFFSETS_M) {
          const pt: Pt = [mid[0] + sign * nx * off, mid[1] + sign * ny * off];
          let best: Space | null = null;
          for (const s of floorSpaces)
            if ((best === null || s.area < best.area) && pointInPolys(pt, s.polysM)) best = s;
          if (best) return best;
        }
        return null;
      };
      const s1 = probe(1);
      const s2 = probe(-1);
      if (!s1 || !s2 || s1 === s2) continue;
      segsTwoSided++;
      const [sa, sb] = s1.id < s2.id ? [s1, s2] : [s2, s1];
      const pk = `${sa.id}|${sb.id}`;
      let clusters = doorways.get(pk);
      if (!clusters) doorways.set(pk, (clusters = []));
      let placed = false;
      for (const c of clusters) {
        if (c.midsM.some((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1]) <= DOOR_CLUSTER_M)) {
          c.midsM.push(mid);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ a: sa, b: sb, midsM: [mid] });
    }
  }

  interface Edge {
    a: string;
    b: string;
    len: number;
    kind: "walk" | "stairs" | "elevator" | "door";
    bearing?: number; // kind=door only: compass bearing door -> space centroid ("head {dir} into …")
    room?: string; // kind=walk within a room: the space being crossed
  }
  interface DoorNode {
    id: string;
    ll: Pt; // [lon, lat]
    floor: number;
    site: Space["site"];
  }
  const edges: Edge[] = [];
  const doorNodes: DoorNode[] = [];
  const doorsOfSpace = new Map<string, { door: DoorNode; m: Pt }[]>();
  let doorSeq = 0;
  for (const clusters of doorways.values()) {
    for (const c of clusters) {
      const mx = c.midsM.reduce((s, p) => s + p[0], 0) / c.midsM.length;
      const my = c.midsM.reduce((s, p) => s + p[1], 0) / c.midsM.length;
      const doorLL: Pt = [round7(mx / MX), round7(my / MY)];
      const door: DoorNode = { id: `d${doorSeq++}`, ll: doorLL, floor: c.a.floor, site: c.a.site };
      doorNodes.push(door);
      for (const sp of [c.a, c.b]) {
        const [lon, lat] = sp.centroidLL;
        const bearing = (Math.atan2((lon - doorLL[0]) * MX, (lat - doorLL[1]) * MY) / D2R + 360) % 360;
        edges.push({
          a: door.id,
          b: sp.id,
          len: Math.round(haversine(doorLL[1], doorLL[0], lat, lon) * 10) / 10,
          kind: "door",
          bearing: Math.round(bearing),
        });
        let l = doorsOfSpace.get(sp.id);
        if (!l) doorsOfSpace.set(sp.id, (l = []));
        l.push({ door, m: [mx, my] });
      }
    }
  }
  // within-space walk edges: pairwise between a space's doorways (straight-line crossing)
  let walkEdges = 0;
  for (const [spaceId, drs] of doorsOfSpace) {
    for (let i = 0; i < drs.length; i++)
      for (let j = i + 1; j < drs.length; j++) {
        const len = Math.hypot(drs[i].m[0] - drs[j].m[0], drs[i].m[1] - drs[j].m[1]);
        edges.push({
          a: drs[i].door.id,
          b: drs[j].door.id,
          len: Math.round(len * 10) / 10,
          kind: "walk",
          room: spaceId,
        });
        walkEdges++;
      }
  }
  console.log(
    `door probing: ${segsTwoSided} two-sided segments -> ${doorNodes.length} doorway nodes, ` +
      `${doorNodes.length * 2} door edges, ${walkEdges} within-room walk edges`
  );

  // ---- 4. vertical shafts: union-find over lift/stairs units across floors ----
  const vertUnits = spaces.filter((s) => s.kind === "lift" || s.kind === "stairs");
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const u of vertUnits) parent.set(u.id, u.id);
  for (let i = 0; i < vertUnits.length; i++)
    for (let j = i + 1; j < vertUnits.length; j++) {
      const a = vertUnits[i];
      const b = vertUnits[j];
      if (a.kind !== b.kind || a.site !== b.site || a.floor === b.floor) continue;
      if (polysGap(a.polysM, b.polysM) <= SHAFT_GAP_M) parent.set(find(a.id), find(b.id));
    }
  const shafts = new Map<string, Space[]>();
  for (const u of vertUnits) {
    const r = find(u.id);
    let l = shafts.get(r);
    if (!l) shafts.set(r, (l = []));
    l.push(u);
  }
  let vertEdges = 0;
  let singletonShafts = 0;
  for (const members of shafts.values()) {
    const floors = [...members].sort((a, b) => a.floor - b.floor);
    if (floors.length === 1) {
      singletonShafts++;
      continue;
    }
    for (let i = 0; i + 1 < floors.length; i++) {
      const a = floors[i];
      const b = floors[i + 1];
      if (a.floor === b.floor) continue; // same-floor twins of one shaft: door edges already join them
      const perLevel = a.kind === "lift" ? ELEVATOR_M_PER_LEVEL : STAIRS_M_PER_LEVEL;
      edges.push({
        a: a.id,
        b: b.id,
        len: Math.round(perLevel * Math.abs(b.floor - a.floor) * 10) / 10,
        kind: a.kind === "lift" ? "elevator" : "stairs",
      });
      vertEdges++;
    }
  }
  console.log(
    `vertical: ${shafts.size} shafts (${singletonShafts} single-floor, no edge) -> ${vertEdges} stairs/elevator edges`
  );

  // ---- 5. connectivity repair: bridge fragments to the nearest touching space ----
  const adj = new Map<string, { to: string; len: number }[]>();
  const addAdj = (e: Edge) => {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ to: e.b, len: e.len });
    adj.get(e.b)!.push({ to: e.a, len: e.len });
  };
  for (const e of edges) addAdj(e);
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const componentOf = (): Map<string, number> => {
    const comp = new Map<string, number>();
    let c = 0;
    for (const s of spaces) {
      if (comp.has(s.id)) continue;
      const stack = [s.id];
      comp.set(s.id, c);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const { to } of adj.get(cur) ?? [])
          if (!comp.has(to)) {
            comp.set(to, c);
            stack.push(to);
          }
      }
      c++;
    }
    return comp;
  };

  let repaired = 0;
  for (let pass = 0; pass < 3; pass++) {
    const comp = componentOf();
    const sizeOf = new Map<number, number>();
    for (const c of comp.values()) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    const mainComp = new Map<string, number>(); // site -> biggest component id
    for (const s of spaces) {
      const c = comp.get(s.id)!;
      const cur = mainComp.get(s.site);
      if (cur === undefined || sizeOf.get(c)! > sizeOf.get(cur)!) mainComp.set(s.site, c);
    }
    let added = 0;
    for (const s of spaces) {
      if (comp.get(s.id) === mainComp.get(s.site)) continue;
      // nearest same-floor space in the main component whose boundary nearly touches ours
      let best: { sp: Space; gap: number } | null = null;
      for (const o of byFloor.get(`${s.site}|${s.floor}`) ?? []) {
        if (comp.get(o.id) !== mainComp.get(s.site)) continue;
        const gap = polysGap(s.polysM, o.polysM);
        if (gap <= REPAIR_GAP_M && (!best || gap < best.gap)) best = { sp: o, gap };
      }
      if (best) {
        const [lonA, latA] = s.centroidLL;
        const [lonB, latB] = best.sp.centroidLL;
        const e: Edge = {
          a: s.id,
          b: best.sp.id,
          len: Math.round(haversine(latA, lonA, latB, lonB) * 10) / 10,
          kind: "walk",
        };
        edges.push(e);
        addAdj(e);
        added++;
        repaired++;
      }
    }
    if (added === 0) break;
  }
  console.log(`repair: ${repaired} walk edges added (touching-boundary bridge, gap <= ${REPAIR_GAP_M} m)`);

  // ---- 6. drop nodes outside their site's main component (routing dead weight), then emit ----
  {
    const comp = componentOf();
    const sizeOf = new Map<number, number>();
    for (const c of comp.values()) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    const mainOf = new Map<string, number>();
    for (const s of spaces) {
      const c = comp.get(s.id)!;
      const cur = mainOf.get(s.site);
      if (cur === undefined || sizeOf.get(c)! > sizeOf.get(cur)!) mainOf.set(s.site, c);
    }
    const dropped = spaces.filter((s) => comp.get(s.id) !== mainOf.get(s.site));
    const droppedGalleries = dropped.filter((s) => s.gallery);
    if (droppedGalleries.length > 0)
      throw new Error(
        `refusing to drop disconnected GALLERIES: ${droppedGalleries.map((s) => s.gallery).join(", ")}`
      );
    if (dropped.length > 0) {
      console.log(
        `dropping ${dropped.length} disconnected non-gallery space(s): ${dropped
          .map((s) => `${s.id}(${s.kind === "room" ? "room" : s.kind} f${s.floor} ${s.site})`)
          .join(", ")}`
      );
      const gone = new Set(dropped.map((s) => s.id));
      for (let i = spaces.length - 1; i >= 0; i--) if (gone.has(spaces[i].id)) spaces.splice(i, 1);
      // door nodes attach to two spaces; doors of dropped spaces only exist if both ends dropped
      for (let i = edges.length - 1; i >= 0; i--)
        if (gone.has(edges[i].a) || gone.has(edges[i].b)) edges.splice(i, 1);
      const liveDoorIds = new Set<string>();
      for (const e of edges) {
        if (e.a.startsWith("d")) liveDoorIds.add(e.a);
        if (e.b.startsWith("d")) liveDoorIds.add(e.b);
      }
      for (let i = doorNodes.length - 1; i >= 0; i--)
        if (!liveDoorIds.has(doorNodes[i].id)) doorNodes.splice(i, 1);
    }
  }
  const nodes = [
    ...spaces.map((s) => ({
      id: s.id,
      lat: s.centroidLL[1],
      lon: s.centroidLL[0],
      floor: s.floor,
      site: s.site,
      ...(s.gallery !== null ? { gallery: s.gallery } : {}),
      ...(s.kind !== "room" ? { kind: s.kind === "lift" ? "elevator" : s.kind } : {}),
      ...(s.name !== null && s.gallery === null ? { name: s.name } : {}),
    })),
    ...doorNodes.map((d) => ({
      id: d.id,
      lat: d.ll[1],
      lon: d.ll[0],
      floor: d.floor,
      site: d.site,
      kind: "door",
    })),
  ];
  const out = { nodes, edges };
  const outFile = path.join(SNAP, "graph.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`wrote ${outFile}: ${nodes.length} nodes, ${edges.length} edges`);

  // ================= VERIFICATION =================
  const comp = componentOf();
  const compSizes = new Map<number, { n: number; site: string; galleries: number }>();
  for (const s of spaces) {
    const c = comp.get(s.id)!;
    let e = compSizes.get(c);
    if (!e) compSizes.set(c, (e = { n: 0, site: s.site, galleries: 0 }));
    e.n++;
    if (s.gallery) e.galleries++;
  }
  console.log("\ncomponents per site:");
  for (const site of ["fifthAve", "cloisters"]) {
    const cs = [...compSizes.values()].filter((c) => c.site === site).sort((a, b) => b.n - a.n);
    console.log(
      `  ${site}: ${cs.length} components, sizes [${cs
        .slice(0, 8)
        .map((c) => `${c.n}${c.galleries ? `(${c.galleries}g)` : ""}`)
        .join(", ")}${cs.length > 8 ? ", ..." : ""}]`
    );
  }
  const mainCompId = new Map<string, number>();
  for (const [c, e] of compSizes) {
    const cur = mainCompId.get(e.site);
    if (cur === undefined || e.n > compSizes.get(cur)!.n) mainCompId.set(e.site, c);
  }
  const inMain = (s: Space) => comp.get(s.id) === mainCompId.get(s.site);

  // stragglers: galleries not in their site's main component
  const strayGalleries = spaces.filter((s) => s.gallery && !inMain(s));
  console.log(
    `  galleries outside main component: ${strayGalleries.length}` +
      (strayGalleries.length
        ? ` -> ${strayGalleries.map((s) => `${s.site}:${s.gallery}(f${s.floor})`).join(", ")}`
        : "")
  );

  // ---- Dijkstra (simple array-scan PQ; moves to shared/ in Phase 2) ----
  function dijkstra(src: string, dst: string): { dist: number; path: string[] } | null {
    const dist = new Map<string, number>([[src, 0]]);
    const prev = new Map<string, string>();
    const heap: [number, string][] = [[0, src]];
    const done = new Set<string>();
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i; // O(n) pop: fine at <1k nodes
      const [d, u] = heap.splice(bi, 1)[0];
      if (done.has(u)) continue;
      done.add(u);
      if (u === dst) {
        const pathIds = [dst];
        let cur = dst;
        while (prev.has(cur)) pathIds.unshift((cur = prev.get(cur)!));
        return { dist: d, path: pathIds };
      }
      for (const { to, len } of adj.get(u) ?? []) {
        const nd = d + len;
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          prev.set(to, u);
          heap.push([nd, to]);
        }
      }
    }
    return null;
  }

  // 200 random gallery pairs (same site)
  const galleryNodes = spaces.filter((s) => s.gallery);
  let ok = 0;
  let failed = 0;
  let rngState = 42;
  const rng = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pairDists: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = galleryNodes[Math.floor(rng() * galleryNodes.length)];
    const sameSite = galleryNodes.filter((g) => g.site === a.site);
    const b = sameSite[Math.floor(rng() * sameSite.length)];
    const r = dijkstra(a.id, b.id);
    if (r) {
      ok++;
      pairDists.push(r.dist);
    } else failed++;
  }
  pairDists.sort((x, y) => x - y);
  const q = (p: number) => pairDists[Math.floor(pairDists.length * p)]?.toFixed(0);
  console.log(
    `\nDijkstra on 200 random same-site gallery pairs: ${ok} ok, ${failed} failed ` +
      `(path length m: p50 ${q(0.5)}, p95 ${q(0.95)}, max ${pairDists[pairDists.length - 1]?.toFixed(0)})`
  );

  // Great Hall -> gallery 822. The Great Hall has no room label in the tiles (it is an unlabeled
  // corridor polygon); identify it via the features-API "The Great Hall" building|section center
  // (feature a29e5baa..., 40.779178, -73.962853, floor 1) -> point-in-polygon.
  const GH_PROBE: Pt = toM([-73.962853333, 40.779178173]);
  let greatHall: Space | null = null;
  for (const s of byFloor.get("fifthAve|1") ?? [])
    if ((greatHall === null || s.area < greatHall.area) && pointInPolys(GH_PROBE, s.polysM)) greatHall = s;
  const g822 = spaces.find((s) => s.gallery === "822" && s.site === "fifthAve");
  if (greatHall && g822) {
    const r = dijkstra(greatHall.id, g822.id);
    if (r) {
      const mins = r.dist / 80; // ~80 m/min museum walking pace
      const edgeByPair = new Map<string, Edge>();
      for (const e of edges) {
        edgeByPair.set(`${e.a}|${e.b}`, e);
        edgeByPair.set(`${e.b}|${e.a}`, e);
      }
      const label = (id: string): string | null => {
        const s = spaceById.get(id);
        if (!s) return null;
        return s.gallery ?? (s.kind !== "room" ? `[${s.kind} f${s.floor}]` : `(${s.name ?? "corridor"})`);
      };
      const seq: string[] = [];
      for (let i = 0; i < r.path.length; i++) {
        const own = label(r.path[i]);
        if (own) seq.push(own);
        if (i + 1 < r.path.length) {
          const e = edgeByPair.get(`${r.path[i]}|${r.path[i + 1]}`);
          if (e?.kind === "walk" && e.room) {
            const crossed = label(e.room);
            if (crossed && seq[seq.length - 1] !== crossed) seq.push(crossed);
          }
        }
      }
      console.log(
        `Great Hall (${greatHall.id}, "${greatHall.name ?? "unlabeled"}", ${Math.round(
          greatHall.area
        )} m²) -> 822: ${r.dist.toFixed(0)} m ≈ ${mins.toFixed(1)} min, ${r.path.length} hops:\n  ` +
          seq.join(" -> ")
      );
    } else console.log("Great Hall -> 822: NO PATH");
  } else console.log(`Great Hall probe failed: hall=${greatHall?.id}, 822=${g822?.id}`);

  // reachability of galleries holding on-view objects (objects.json.gz snapshot)
  const objFile = path.join(SNAP, "objects.json.gz");
  let objectGalleryReport = "objects.json.gz not present; skipped object reachability";
  if (fs.existsSync(objFile)) {
    const objs = JSON.parse(zlib.gunzipSync(fs.readFileSync(objFile)).toString()) as {
      galleryNumber?: string;
      site?: string;
    }[];
    const wanted = new Map<string, string>(); // gallery -> site
    for (const o of objs) if (o.galleryNumber) wanted.set(o.galleryNumber, o.site ?? "fifthAve");
    let reachable = 0;
    const missing: string[] = [];
    for (const [g, site] of wanted) {
      const node = spaces.find((s) => s.gallery === g && s.site === site);
      if (node && inMain(node)) reachable++;
      else missing.push(`${site}:${g}${node ? "(disconnected)" : "(no polygon)"}`);
    }
    objectGalleryReport =
      `object-holding galleries reachable: ${reachable}/${wanted.size}` +
      (missing.length ? ` missing: ${missing.join(", ")}` : "");
  }
  console.log(objectGalleryReport);

  // hard gates
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`VERIFY FAIL: ${msg}`);
    console.log(`  OK: ${msg}`);
  };
  assert(failed === 0, `all 200 random gallery pairs routable (failed ${failed})`);
  assert(strayGalleries.length === 0, "every gallery polygon is in its site's main component");
}

main();
