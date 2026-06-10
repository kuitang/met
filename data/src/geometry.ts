/**
 * Geometry pipeline: fetch the Living Map tile pyramid (z17+z18, Fifth Ave + Cloisters),
 * decode MVT via @mapbox/vector-tile, stitch features across tile boundaries, and emit
 *   data/snapshots/galleries.geojson  — category=room polygons (galleryNumber/title/floor/site/closed)
 *   data/snapshots/routes.geojson     — category=route type=walking linestrings (+floor/site)
 *   data/snapshots/amenities.geojson  — facility points from the features API (restrooms, dining, elevators, ...)
 *
 * Raw responses are cached under data/raw/livingmap/ and NEVER refetched once cached
 * (404/empty responses leave a `.empty` marker). Network fetches are throttled to ~4 req/s.
 *
 * Source: Living Map production endpoints backing the Met's official map (maps.metmuseum.org).
 * Unofficial; one-time ETL — re-decoding always runs from the committed raw cache.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import polygonClipping from "polygon-clipping";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(DATA_DIR, "raw", "livingmap");
const SNAP = path.join(DATA_DIR, "snapshots");

const TILE_URL = (z: number, x: number, y: number) =>
  `https://prod.cdn.livingmap.com/tiles/the_met/${z}/${x}/${y}.pbf?lang=en-GB`;
const FEATURES_URL = (offset: number) =>
  `https://map-api.prod.livingmap.com/v1/maps/the_met/features?lang=en-GB&limit=500&offset=${offset}`;
const STYLES_URL =
  "https://map-api.prod.livingmap.com/v1/maps/the_met/styles/styles.json?lang=en-GB";

// Generous bounding boxes around each building.
const SITES = {
  fifthAve: { latMin: 40.776, latMax: 40.783, lonMin: -73.9665, lonMax: -73.959 },
  cloisters: { latMin: 40.862, latMax: 40.868, lonMin: -73.934, lonMax: -73.928 },
} as const;
type SiteName = keyof typeof SITES;

// ---------- slippy-map math ----------
const D2R = Math.PI / 180;
function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
  return Math.floor(((1 - Math.asinh(Math.tan(lat * D2R)) / Math.PI) / 2) * 2 ** z);
}
/** world tile-units (x*extent+u) at zoom z -> [lon, lat] */
function worldToLonLat(wx: number, wy: number, z: number, extent: number): [number, number] {
  const n = 2 ** z * extent;
  const lon = (wx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n))) * 180) / Math.PI;
  return [round7(lon), round7(lat)];
}
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

function tileRange(site: SiteName, z: number) {
  const b = SITES[site];
  const x0 = lonToTileX(b.lonMin, z);
  const x1 = lonToTileX(b.lonMax, z);
  const y0 = latToTileY(b.latMax, z); // y grows southward
  const y1 = latToTileY(b.latMin, z);
  const tiles: { z: number; x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
  return tiles;
}

// ---------- polite cached fetcher ----------
const THROTTLE_MS = 250; // ~4 req/s
let lastRequestAt = 0;
let networkFetches = 0;
let cacheHits = 0;

async function politeFetch(url: string): Promise<Response> {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  networkFetches++;
  return fetch(url, { headers: { "user-agent": "met-navigator-etl (one-time geometry snapshot)" } });
}

/** Returns cached or freshly fetched bytes; null if the resource is 404/empty (cached as a .empty marker). */
async function fetchCached(url: string, file: string): Promise<Buffer | null> {
  const marker = file + ".empty";
  if (fs.existsSync(file)) {
    cacheHits++;
    return fs.readFileSync(file);
  }
  if (fs.existsSync(marker)) {
    cacheHits++;
    return null;
  }
  const res = await politeFetch(url);
  if (res.status === 404 || res.status === 204) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "");
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (buf.length === 0) {
    fs.writeFileSync(marker, "");
    return null;
  }
  fs.writeFileSync(file, buf);
  return buf;
}

// ---------- geometry helpers (world tile-unit space) ----------
type Pt = [number, number];
type Ring = Pt[];

function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Quantize route vertices to a 1-tile-unit grid (~2 cm at z18) so clip points computed
 * in adjacent tiles compare equal when deduping/chaining route segments.
 */
const qz = (v: number) => Math.round(v);
const keyOf = (p: Pt) => `${qz(p[0])},${qz(p[1])}`;

/** Group rings into polygons: exterior = positive signed area in y-down tile space. */
function ringsToPolygons(rings: Ring[]): Ring[][] {
  const exteriors: { ring: Ring; holes: Ring[] }[] = [];
  const holes: Ring[] = [];
  for (const r of rings) {
    if (signedArea(r) > 0) exteriors.push({ ring: r, holes: [] });
    else holes.push(r);
  }
  for (const h of holes) {
    const p = h[0];
    let assigned = false;
    for (const e of exteriors) {
      if (pointInRing(p, e.ring)) {
        e.holes.push(h);
        assigned = true;
        break;
      }
    }
    if (!assigned && exteriors.length > 0) exteriors[0].holes.push(h);
  }
  return exteriors.map((e) => [e.ring, ...e.holes]);
}

function pointInRing(p: Pt, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- decode + stitch ----------
const EMIT_Z = 18; // assemble final geometry from the finest fetched zoom

type PolyCoords = Ring[][]; // MultiPolygon-shaped: polygons -> rings -> points
interface RoomAccum {
  props: Record<string, unknown>;
  site: SiteName;
  // one MultiPolygon per contributing tile, raw (incl. the tile's 64-unit buffer), world coords;
  // adjacent tiles' pieces overlap in the buffer, so a polygon union stitches them seamlessly
  pieces: PolyCoords[];
}
interface RouteAccum {
  props: Record<string, unknown>;
  site: SiteName;
  // undirected segments clipped to exact tile boxes, world coords
  segments: Map<string, [Pt, Pt]>;
}

function siteOf(props: Record<string, unknown>): SiteName {
  return props.location_name === "The Met Cloisters" ? "cloisters" : "fifthAve";
}

/** Clip one line segment to a box (Liang–Barsky). Returns null if fully outside. */
function clipSegToBox(a: Pt, b: Pt, xMin: number, yMin: number, xMax: number, yMax: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - xMin],
    [dx, xMax - a[0]],
    [-dy, a[1] - yMin],
    [dy, yMax - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

const segKey = (a: Pt, b: Pt) => {
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

async function main(): Promise<void> {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(SNAP, { recursive: true });

  // 1. features API (paged) + styles, cached
  const featurePages: unknown[] = [];
  let offset = 0;
  for (;;) {
    const buf = await fetchCached(FEATURES_URL(offset), path.join(RAW, `features-offset${offset}.json`));
    if (!buf) break;
    const page = JSON.parse(buf.toString("utf8"));
    const feats = page.features ?? page.data ?? page;
    featurePages.push(...(Array.isArray(feats) ? feats : []));
    if (!Array.isArray(feats) || feats.length < 500) break;
    offset += 500;
  }
  await fetchCached(STYLES_URL, path.join(RAW, "styles.json"));
  console.log(`features API: ${featurePages.length} features`);

  // 2. tiles for both sites at z17 and z18, cached
  const tiles: { z: number; x: number; y: number }[] = [];
  for (const site of Object.keys(SITES) as SiteName[])
    for (const z of [17, 18]) tiles.push(...tileRange(site, z));
  const tileBufs = new Map<string, Buffer>();
  for (const t of tiles) {
    const file = path.join(RAW, "tiles", String(t.z), String(t.x), `${t.y}.pbf`);
    const buf = await fetchCached(TILE_URL(t.z, t.x, t.y), file);
    if (buf) tileBufs.set(`${t.z}/${t.x}/${t.y}`, buf);
  }
  console.log(
    `tiles: ${tiles.length} requested, ${tileBufs.size} non-empty (network ${networkFetches}, cache hits ${cacheHits})`
  );

  // 3. decode z18 tiles, accumulate rooms + routes keyed by geom_id|floor
  const rooms = new Map<string, RoomAccum>();
  const routes = new Map<string, RouteAccum>();
  let extent = 4096;
  for (const [key, buf] of tileBufs) {
    const [z, x, y] = key.split("/").map(Number);
    if (z !== EMIT_Z) continue;
    const vt = new VectorTile(new PbfReader(buf));
    const layer = vt.layers["indoor"];
    if (!layer) continue;
    extent = layer.extent;
    const xMin = x * extent;
    const yMin = y * extent;
    const xMax = xMin + extent;
    const yMax = yMin + extent;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties as Record<string, unknown>;
      const id = `${p.geom_id}|${p.floor_id}`;
      if (p.category === "room" && f.type === 3) {
        const geom = f.loadGeometry();
        let acc = rooms.get(id);
        if (!acc) rooms.set(id, (acc = { props: p, site: siteOf(p), pieces: [] }));
        const rings: Ring[] = [];
        for (const ringRaw of geom) {
          const world: Ring = ringRaw.map((pt) => [x * extent + pt.x, y * extent + pt.y]);
          if (world.length >= 3) {
            const [fx, fy] = world[0];
            const [lx, ly] = world[world.length - 1];
            if (fx !== lx || fy !== ly) world.push([fx, fy]); // close ring
            rings.push(world);
          }
        }
        if (rings.length > 0) acc.pieces.push(ringsToPolygons(rings));
      } else if (p.category === "route" && p.type === "walking" && f.type === 2) {
        const geom = f.loadGeometry();
        let acc = routes.get(id);
        if (!acc) routes.set(id, (acc = { props: p, site: siteOf(p), segments: new Map() }));
        for (const lineRaw of geom) {
          const world: Ring = lineRaw.map((pt) => [x * extent + pt.x, y * extent + pt.y]);
          for (let j = 0; j + 1 < world.length; j++) {
            const seg = clipSegToBox(world[j], world[j + 1], xMin, yMin, xMax, yMax);
            if (!seg) continue;
            const [a, b] = seg;
            if (keyOf(a) === keyOf(b)) continue;
            routes.get(id)!.segments.set(segKey(a, b), [
              [qz(a[0]), qz(a[1])],
              [qz(b[0]), qz(b[1])],
            ]);
          }
        }
      }
    }
  }

  // 4a. galleries.geojson — union multi-tile rooms (overlapping buffered pieces stitch seamlessly)
  let multiPieceRooms = 0;
  let unionFallbacks = 0;
  const galleryFeatures: object[] = [];
  for (const acc of rooms.values()) {
    let merged: PolyCoords;
    if (acc.pieces.length === 1) {
      merged = acc.pieces[0];
    } else {
      multiPieceRooms++;
      try {
        merged = polygonClipping.union(
          ...(acc.pieces as [PolyCoords, ...PolyCoords[]])
        ) as unknown as PolyCoords;
      } catch {
        unionFallbacks++;
        merged = acc.pieces.flat().map((rings) => rings) as PolyCoords; // seamed fallback
      }
    }
    const polys = merged.map((poly) =>
      poly.map((ring) => {
        const ll = ring.map(([wx, wy]) => worldToLonLat(wx, wy, EMIT_Z, extent));
        const [f0, l0] = [ll[0], ll[ll.length - 1]];
        if (f0[0] !== l0[0] || f0[1] !== l0[1]) ll.push(f0); // close per GeoJSON
        return ll;
      })
    );
    if (polys.length === 0) continue;
    const p = acc.props;
    galleryFeatures.push({
      type: "Feature",
      geometry:
        polys.length === 1
          ? { type: "Polygon", coordinates: polys[0] }
          : { type: "MultiPolygon", coordinates: polys },
      properties: {
        geomId: p.geom_id,
        lmId: p.lm_id,
        galleryNumber: p.type === "gallery" || p.type === "exhibition" ? (p.name ?? null) : null,
        name: p.name ?? null,
        title: p.popup_header ?? null,
        type: p.type, // gallery | exhibition | corridor | toilet | restaurant | shop | ...
        floor: Number(p.floor_level),
        floorName: p.floor_name,
        site: acc.site,
        closed: p.closed ?? false,
      },
    });
  }

  // 4b. routes.geojson — chain deduped segments into polylines
  const routeFeatures: object[] = [];
  for (const acc of routes.values()) {
    const adjacency = new Map<string, Pt[]>();
    const used = new Set<string>();
    const addAdj = (from: Pt, to: Pt) => {
      const k = keyOf(from);
      let l = adjacency.get(k);
      if (!l) adjacency.set(k, (l = []));
      l.push(to);
    };
    for (const [a, b] of acc.segments.values()) {
      addAdj(a, b);
      addAdj(b, a);
    }
    const lines: Pt[][] = [];
    const walk = (start: Pt) => {
      const line: Pt[] = [start];
      let cur = start;
      for (;;) {
        const nexts = (adjacency.get(keyOf(cur)) ?? []).filter((n) => !used.has(segKey(cur, n)));
        if (nexts.length === 0) break;
        const next = nexts[0];
        used.add(segKey(cur, next));
        line.push(next);
        cur = next;
      }
      if (line.length >= 2) lines.push(line);
    };
    // start at odd-degree endpoints first, then mop up cycles
    for (const [k, neigh] of adjacency) {
      if (neigh.length % 2 === 1) {
        const start = neigh.length > 0 ? ([Number(k.split(",")[0]), Number(k.split(",")[1])] as Pt) : null;
        if (start) walk(start);
      }
    }
    for (const [a, b] of acc.segments.values()) {
      if (!used.has(segKey(a, b))) walk(a);
    }
    if (lines.length === 0) continue;
    // Weld parts whose endpoints nearly touch (clip points from adjacent tiles can
    // disagree by <1 tile unit; anything under ~8 units ≈ 18 cm is the same point).
    const WELD = 8;
    const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= WELD;
    for (let i = 0; i < lines.length; i++) {
      for (let j = lines.length - 1; j > i; j--) {
        const a = lines[i];
        const b = lines[j];
        let joined: Pt[] | null = null;
        if (near(a[a.length - 1], b[0])) joined = [...a, ...b.slice(1)];
        else if (near(a[a.length - 1], b[b.length - 1])) joined = [...a, ...b.slice(0, -1).reverse()];
        else if (near(a[0], b[b.length - 1])) joined = [...b, ...a.slice(1)];
        else if (near(a[0], b[0])) joined = [...b.slice(1).reverse(), ...a];
        if (joined) {
          lines[i] = joined;
          lines.splice(j, 1);
          j = lines.length; // restart inner scan against the grown line
        }
      }
    }
    const coords = lines.map((line) => line.map(([wx, wy]) => worldToLonLat(wx, wy, EMIT_Z, extent)));
    const p = acc.props;
    routeFeatures.push({
      type: "Feature",
      geometry:
        coords.length === 1
          ? { type: "LineString", coordinates: coords[0] }
          : { type: "MultiLineString", coordinates: coords },
      properties: {
        geomId: p.geom_id,
        lmId: p.lm_id,
        floor: Number(p.floor_level),
        floorName: p.floor_name,
        site: acc.site,
      },
    });
  }

  // 4c. amenities.geojson — facility features from the features API.
  // Features API shape: { id, label:{name:[{lang,text}],reference:[...]}, categories:{category:{id},subcategory:{id}},
  //   location:{center:{latitude,longitude}, floor:{floor:"2.0", name:[{text}]}}, is_temporarily_closed }
  const AMENITY_KINDS: Record<string, string> = {
    toilet: "restroom",
    changing_room: "restroom",
    restaurant: "dining",
    cafe: "dining",
    bar: "dining",
    lift: "elevator",
    escalator: "escalator",
    information: "information",
    tickets: "tickets",
    drinking_water: "water",
    cloakroom: "cloakroom",
    shop: "shop",
    entrance: "entrance",
    defibrillator: "firstAid",
  };
  const text = (arr: unknown): string | null =>
    Array.isArray(arr) ? ((arr.find((e: any) => e?.text)?.text as string) ?? null) : null;
  const amenityFeatures: object[] = [];
  for (const raw of featurePages as Record<string, any>[]) {
    const kind = AMENITY_KINDS[String(raw?.categories?.subcategory?.id ?? "")];
    if (!kind) continue;
    const lat = raw?.location?.center?.latitude;
    const lon = raw?.location?.center?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const floorRaw = raw?.location?.floor?.floor;
    amenityFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [round7(lon), round7(lat)] },
      properties: {
        kind,
        name: text(raw?.label?.name) ?? text(raw?.label?.reference),
        floor: floorRaw !== undefined && floorRaw !== null ? Number(floorRaw) : null,
        floorName: text(raw?.location?.floor?.name),
        lat: round7(lat),
        lon: round7(lon),
        // features API has no site field; the two buildings are ~9.6 km apart, split at 40.82°N
        site: lat > 40.82 ? "cloisters" : "fifthAve",
        lmId: raw?.id ?? null,
        closed: raw?.is_temporarily_closed ?? false,
      },
    });
  }

  const write = (name: string, features: object[]) => {
    const file = path.join(SNAP, name);
    fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }, null, 1));
    console.log(`wrote ${file} (${features.length} features)`);
  };
  write("galleries.geojson", galleryFeatures);
  write("routes.geojson", routeFeatures);
  write("amenities.geojson", amenityFeatures);

  // 5. sanity checks
  const galleries = galleryFeatures.filter((f: any) => f.properties.galleryNumber !== null);
  const perFloor = new Map<string, number>();
  for (const f of galleries as any[]) {
    const k = `${f.properties.site} ${f.properties.floorName}`;
    perFloor.set(k, (perFloor.get(k) ?? 0) + 1);
  }
  console.log("\nGallery polygons per site/floor:");
  for (const [k, n] of [...perFloor].sort()) console.log(`  ${k}: ${n}`);
  console.log(`  TOTAL gallery polygons: ${galleries.length}`);
  console.log(`  room polygons (all types): ${galleryFeatures.length}`);
  console.log(`  route features: ${routeFeatures.length}; amenities: ${amenityFeatures.length}`);
  console.log(`  rooms spanning multiple tiles (unioned): ${multiPieceRooms}; union fallbacks: ${unionFallbacks}`);

  const fifthGalleryFloors = new Set(
    (galleries as any[]).filter((f) => f.properties.site === "fifthAve").map((f) => f.properties.floorName)
  );
  const fifthRoomFloors = new Set(
    (galleryFeatures as any[]).filter((f) => f.properties.site === "fifthAve").map((f) => f.properties.floorName)
  );
  const g131 = (galleries as any[]).find(
    (f) => f.properties.galleryNumber === "131" && f.properties.site === "fifthAve"
  );
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`SANITY FAIL: ${msg}`);
    console.log(`  OK: ${msg}`);
  };
  assert(galleries.length >= 440, `>=440 gallery polygons (got ${galleries.length})`);
  // Ground truth (features API, verified): galleries sit on 6 Fifth-Ave floors (G,1,1M,2,3,5) —
  // Floor 4 exists but holds no galleries (dining/members rooms only). Room polygons span all 7 floors.
  assert(
    fifthGalleryFloors.size >= 6,
    `Fifth Ave galleries on >=6 floors (got ${fifthGalleryFloors.size}: ${[...fifthGalleryFloors].join(", ")})`
  );
  assert(
    fifthRoomFloors.size >= 7,
    `Fifth Ave room polygons on >=7 floors (got ${fifthRoomFloors.size}: ${[...fifthRoomFloors].join(", ")})`
  );
  assert(
    (galleries as any[]).some((f) => f.properties.site === "cloisters"),
    "Cloisters galleries present"
  );
  assert(!!g131, "gallery 131 polygon exists");
  assert(
    String(g131.properties.title ?? "").includes("Dendur"),
    `gallery 131 title mentions Dendur (title: ${g131.properties.title})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
