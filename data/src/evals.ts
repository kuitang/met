/**
 * Data evals (Gate B). Five evaluations over the committed snapshots + met.sqlite,
 * each writing a markdown report under data/evals/reports/ and printing one
 * PASS/WARN/FAIL line. Exit code 1 iff any eval FAILs.
 *
 *   coverage  — objects.GalleryNumber ↔ gallery polygons, both-direction orphans,
 *               manual mappings from src/gallery-aliases.json + a zero-pad rule
 *   geometry  — polygon validity, per-floor overlaps, centroid vs features-API
 *               distance distribution, floor inventory
 *   graph     — components per site, 100% random-pair Dijkstra, Great Hall →
 *               Temple of Dendur length sanity, door edges per gallery
 *   gps       — synthetic GPS fixes (entrance / Central Park outlier / 65 m noise
 *               cloud) against a reference resolver that only ever yields
 *               site + wing, never a room; quantifies why room-level is impossible
 *   visual    — per-floor SVG renders (polygons + graph overlay + gallery numbers)
 *               under data/evals/reports/floors/ — the "show your work" artifact
 *
 * Usage: npm run evals   (= tsx src/evals.ts; no network, reads snapshots only)
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import polygonClipping from "polygon-clipping";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(DATA_DIR, "snapshots");
const RAW = path.join(DATA_DIR, "raw", "livingmap");
const REPORTS = path.join(DATA_DIR, "evals", "reports");
const FLOORS_DIR = path.join(REPORTS, "floors");
const DB_PATH = path.join(DATA_DIR, "met.sqlite");
const ALIASES_PATH = path.join(DATA_DIR, "src", "gallery-aliases.json");

// ---------- shared geometry helpers ----------
const D2R = Math.PI / 180;
const LAT0 = 40.78; // local equirectangular scale; both sites, error < 0.02%
const MX = Math.cos(LAT0 * D2R) * 111319.49;
const MY = 110946;
type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[]; // [exterior, ...holes]
const toM = ([lon, lat]: Pt): Pt => [lon * MX, lat * MY];

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
const pointInPolys = (p: Pt, polys: Poly[]): boolean =>
  polys.some((rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((h) => pointInRing(p, h)));

/** Signed shoelace area of one ring relative to its first vertex (avoids fp cancellation). */
function ringArea(ring: Ring): number {
  const [ox, oy] = ring[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
  return a / 2;
}
const polysArea = (polys: Poly[]): number =>
  polys.reduce((s, rings) => s + rings.reduce((r, ring, i) => r + (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0);

/** Area centroid of the largest exterior ring, local-origin shoelace. */
function polysCentroidM(polys: Poly[]): Pt {
  let best: Ring | null = null;
  let bestA = -1;
  for (const rings of polys) {
    const a = Math.abs(ringArea(rings[0]));
    if (a > bestA) {
      bestA = a;
      best = rings[0];
    }
  }
  const ext = best!;
  const [ox, oy] = ext[0];
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < ext.length - 1; i++) {
    const x1 = ext[i][0] - ox,
      y1 = ext[i][1] - oy,
      x2 = ext[i + 1][0] - ox,
      y2 = ext[i + 1][1] - oy;
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) return ext[0];
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

// ---------- input loading ----------
interface ObjectRow {
  objectID: number;
  title: string;
  galleryNumber: string;
  site: string;
}
interface RoomFeature {
  geomId: unknown;
  galleryNumber: string | null;
  name: string | null;
  title: string | null;
  type: string;
  floor: number;
  floorName: string;
  site: "fifthAve" | "cloisters";
  closed: boolean;
  polysM: Poly[]; // meter space
  polysLL: Poly[]; // lon/lat
  area: number;
  centroidM: Pt;
}
interface ApiFeature {
  kind: "gallery" | "section" | "entrance" | "other";
  name: string | null;
  ref: string | null;
  lat: number;
  lon: number;
  floor: number | null;
  site: "fifthAve" | "cloisters";
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

function loadRooms(): RoomFeature[] {
  const gj = JSON.parse(fs.readFileSync(path.join(SNAP, "galleries.geojson"), "utf8"));
  return gj.features.map((f: any): RoomFeature => {
    const polysLL: Poly[] =
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const polysM = polysLL.map((rings) => rings.map((ring) => ring.map((c: Pt) => toM(c))));
    return {
      geomId: f.properties.geomId,
      galleryNumber: f.properties.galleryNumber,
      name: f.properties.name,
      title: f.properties.title,
      type: f.properties.type,
      floor: f.properties.floor,
      floorName: f.properties.floorName,
      site: f.properties.site,
      closed: Boolean(f.properties.closed),
      polysM,
      polysLL,
      area: polysArea(polysM),
      centroidM: polysCentroidM(polysM),
    };
  });
}

function loadApiFeatures(): ApiFeature[] {
  const out: ApiFeature[] = [];
  for (const file of fs.readdirSync(RAW)) {
    if (!/^features-offset\d+\.json$/.test(file)) continue;
    const page = JSON.parse(fs.readFileSync(path.join(RAW, file), "utf8"));
    const text = (arr: unknown): string | null =>
      Array.isArray(arr) ? ((arr.find((e: any) => e?.text)?.text as string) ?? null) : null;
    for (const f of page.data ?? []) {
      const lat = f?.location?.center?.latitude;
      const lon = f?.location?.center?.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      const sub = String(f?.categories?.subcategory?.id ?? "");
      const cat = String(f?.categories?.category?.id ?? "");
      const kind: ApiFeature["kind"] =
        sub === "gallery" ? "gallery" : cat === "building" ? "section" : sub === "entrance" ? "entrance" : "other";
      const floorRaw = f?.location?.floor?.floor;
      out.push({
        kind,
        name: text(f?.label?.name),
        ref: text(f?.label?.reference),
        lat,
        lon,
        floor: floorRaw !== undefined && floorRaw !== null ? Number(floorRaw) : null,
        site: lat > 40.82 ? "cloisters" : "fifthAve",
      });
    }
  }
  return out;
}

function loadObjects(): { rows: ObjectRow[]; meta: any } {
  const rows: ObjectRow[] = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(SNAP, "objects.json.gz"))).toString("utf8"),
  );
  const meta = JSON.parse(fs.readFileSync(path.join(SNAP, "objects-meta.json"), "utf8"));
  return { rows, meta };
}

// ---------- reporting ----------
type Status = "PASS" | "WARN" | "FAIL";
const worse = (a: Status, b: Status): Status =>
  a === "FAIL" || b === "FAIL" ? "FAIL" : a === "WARN" || b === "WARN" ? "WARN" : "PASS";

function writeReport(name: string, title: string, status: Status, body: string[]): void {
  fs.mkdirSync(REPORTS, { recursive: true });
  const head = [
    `# ${title}`,
    "",
    `- Status: **${status}**`,
    `- Generated: ${new Date().toISOString()} by \`data/src/evals.ts\``,
    `- Data version: ${fs.existsSync(path.join(DATA_DIR, "VERSION")) ? fs.readFileSync(path.join(DATA_DIR, "VERSION"), "utf8").trim() : "(no VERSION file)"}`,
    "",
  ];
  fs.writeFileSync(path.join(REPORTS, `${name}.md`), head.concat(body).join("\n") + "\n");
}

// =====================================================================
// 1. COVERAGE — objects.GalleryNumber ↔ gallery polygons
// =====================================================================
function evalCoverage(rooms: RoomFeature[]): Status {
  const { rows: objects, meta } = loadObjects();
  const aliasesRaw = JSON.parse(fs.readFileSync(ALIASES_PATH, "utf8"));
  const aliases = new Map<string, { site: string; polygon: string }>(
    Object.entries(aliasesRaw).filter(([k]) => !k.startsWith("_")) as [string, any][],
  );

  // Polygon lookup: by galleryNumber and by raw name (aliases may target either).
  const polyByKey = new Map<string, RoomFeature>();
  for (const r of rooms) {
    if (r.galleryNumber) polyByKey.set(`${r.site}|${r.galleryNumber}`, r);
    if (r.name) polyByKey.set(`${r.site}|${r.name}`, r);
  }
  const cloistersNums = new Set(
    rooms.filter((r) => r.site === "cloisters" && r.galleryNumber).map((r) => r.galleryNumber),
  );

  type Resolution = { room: RoomFeature; via: "exact" | "alias" | "zeroPad" };
  const resolve = (galleryNumber: string, site: string): Resolution | null => {
    const exact = polyByKey.get(`${site}|${galleryNumber}`);
    if (exact) return { room: exact, via: "exact" };
    const alias = aliases.get(galleryNumber);
    if (alias) {
      const room = polyByKey.get(`${alias.site}|${alias.polygon}`);
      if (room) return { room, via: "alias" };
    }
    // Zero-pad rule: the Met API zero-pads Cloisters galleries ("010"), and the
    // objects pipeline can mis-site them as fifthAve (department string is
    // "Medieval Art and The Cloisters", not "The Cloisters").
    if (/^0\d+$/.test(galleryNumber)) {
      const stripped = galleryNumber.replace(/^0+/, "");
      if (cloistersNums.has(stripped))
        return { room: polyByKey.get(`cloisters|${stripped}`)!, via: "zeroPad" };
    }
    return null;
  };

  let matched = 0;
  const via = { exact: 0, alias: 0, zeroPad: 0 };
  const orphanCounts = new Map<string, number>(); // "site|gallery" -> object count
  for (const o of objects) {
    const r = resolve(o.galleryNumber, o.site);
    if (r) {
      matched++;
      via[r.via]++;
    } else {
      const k = `${o.site}|${o.galleryNumber}`;
      orphanCounts.set(k, (orphanCounts.get(k) ?? 0) + 1);
    }
  }
  const pct = objects.length ? (100 * matched) / objects.length : 0;

  // Reverse direction: gallery polygons with zero objects in the snapshot.
  const usedPolys = new Set<unknown>();
  for (const o of objects) {
    const r = resolve(o.galleryNumber, o.site);
    if (r) usedPolys.add(r.room.geomId);
  }
  const galleryPolys = rooms.filter((r) => r.galleryNumber);
  const emptyGalleries = galleryPolys.filter((r) => !usedPolys.has(r.geomId));

  // met.sqlite consistency cross-check.
  let dbNote = "met.sqlite not found";
  let dbConsistent = true;
  if (fs.existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true });
    // v2 artifacts merge every registry museum — compare the Met's OWN rows
    // against the Met snapshots (whole-artifact counts stopped matching when
    // the second museum landed).
    const metObjects = (
      db.prepare("SELECT count(*) AS n FROM objects WHERE museum='met'").get() as { n: number }
    ).n;
    const metGalleries = (
      db
        .prepare("SELECT count(*) AS n FROM galleries WHERE site IN ('fifthAve','cloisters')")
        .get() as { n: number }
    ).n;
    db.close();
    dbConsistent = metObjects === objects.length && metGalleries === galleryPolys.length;
    dbNote = `met.sqlite Met rows: ${metObjects} objects / ${metGalleries} galleries — ${dbConsistent ? "consistent with snapshots" : "STALE vs snapshots (rebuild with npm -w data run build-db)"}`;
  }

  const partial = meta.rows < 0.9 * meta.searchTotalOnView;
  let status: Status = pct >= 97 ? "PASS" : pct >= 90 ? "WARN" : "FAIL";
  if ([...orphanCounts.values()].some((n) => n >= 50)) status = worse(status, "WARN");
  if (!dbConsistent) status = worse(status, "WARN");
  if (partial) status = worse(status, "WARN");

  const orphanLines = [...orphanCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| ${k.split("|")[1]} | ${k.split("|")[0]} | ${n} |`);
  writeReport("coverage", "Coverage: on-view objects ↔ gallery polygons", status, [
    partial
      ? `> **Partial snapshot**: objects.json.gz holds ${meta.rows} of ${meta.searchTotalOnView} on-view objects (full hydration pending — the Met API WAF throttles well below the published 80 req/s). Percentages below are over the partial set; rerun after the objects pipeline completes.`
      : `Snapshot is complete: ${meta.rows} rows vs ${meta.searchTotalOnView} on-view search total (${meta.skipped.noGallery} drifted off-view, ${meta.skipped.notFound} dead IDs).`,
    "",
    `## Result`,
    "",
    `- Objects with a resolvable gallery polygon: **${matched}/${objects.length} (${pct.toFixed(1)}%)**`,
    `- Resolution: ${via.exact} exact, ${via.alias} via \`src/gallery-aliases.json\`, ${via.zeroPad} via the Cloisters zero-pad rule`,
    `- Distinct orphan gallery numbers (objects with no polygon): ${orphanCounts.size}`,
    `- Gallery polygons with zero objects in this snapshot: ${emptyGalleries.length}/${galleryPolys.length}${partial ? " (expected high while the snapshot is partial)" : ""}`,
    `- ${dbNote}`,
    "",
    `## Orphan gallery numbers (objects → no polygon)`,
    "",
    ...(orphanLines.length
      ? ["| GalleryNumber | site (per objects pipeline) | objects |", "|---|---|---|", ...orphanLines]
      : ["None — every object's GalleryNumber resolves to a polygon."]),
    "",
    `## Mechanism`,
    "",
    "Resolution order: exact `(site, galleryNumber)` match → manual alias from",
    "`data/src/gallery-aliases.json` (covers Living Map's named exhibition polygons,",
    "the 746 North/South split, and the Petrie Court Café) → zero-pad rule",
    "(`010` → Cloisters `10`; also corrects the site, since the merged department is",
    "named 'Medieval Art and The Cloisters'). New orphans found here should be added",
    "to the aliases file.",
    "",
    `## Empty gallery polygons (no objects in snapshot)`,
    "",
    emptyGalleries.length
      ? emptyGalleries
          .slice(0, 60)
          .map((r) => `${r.site}:${r.galleryNumber}`)
          .join(", ") + (emptyGalleries.length > 60 ? ", …" : "")
      : "None.",
  ]);
  console.log(
    `${status} coverage: ${matched}/${objects.length} objects (${pct.toFixed(1)}%) resolve to a polygon; ` +
      `${orphanCounts.size} orphan gallery numbers${partial ? " [PARTIAL objects snapshot]" : ""}`,
  );
  return status;
}

// =====================================================================
// 2. GEOMETRY — validity, overlaps, centroid vs features API, floors
// =====================================================================
function evalGeometry(rooms: RoomFeature[], apiFeatures: ApiFeature[]): Status {
  // Validity: closed rings, >=4 points, non-trivial area, finite coords.
  const invalid: string[] = [];
  for (const r of rooms) {
    const label = `${r.site}:${r.galleryNumber ?? r.name ?? r.geomId} (f${r.floor})`;
    for (const rings of r.polysLL) {
      for (const ring of rings) {
        if (ring.length < 4) invalid.push(`${label}: ring with ${ring.length} points`);
        const [f0, l0] = [ring[0], ring[ring.length - 1]];
        if (f0[0] !== l0[0] || f0[1] !== l0[1]) invalid.push(`${label}: unclosed ring`);
        if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
          invalid.push(`${label}: non-finite coordinate`);
      }
    }
    if (r.area < 0.5) invalid.push(`${label}: degenerate area ${r.area.toFixed(3)} m²`);
  }

  // Per-floor pairwise overlap, bbox-prefiltered. type=floor polygons are the
  // floor-plate backdrop and contain every room by design — excluded.
  interface Boxed {
    r: RoomFeature;
    bb: [number, number, number, number];
  }
  const byFloor = new Map<string, Boxed[]>();
  for (const r of rooms) {
    if (r.type === "floor") continue;
    const k = `${r.site}|${r.floor}`;
    let l = byFloor.get(k);
    if (!l) byFloor.set(k, (l = []));
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const rings of r.polysM)
      for (const [x, y] of rings[0]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    l.push({ r, bb: [x0, y0, x1, y1] });
  }
  const OVERLAP_M2 = 1.0; // ignore sliver overlaps below 1 m² (shared-wall digitization noise)
  const overlaps: { a: RoomFeature; b: RoomFeature; m2: number }[] = [];
  let clipErrors = 0;
  for (const list of byFloor.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i],
          B = list[j];
        if (A.bb[2] < B.bb[0] || B.bb[2] < A.bb[0] || A.bb[3] < B.bb[1] || B.bb[3] < A.bb[1]) continue;
        try {
          const inter = polygonClipping.intersection(
            A.r.polysM as any,
            B.r.polysM as any,
          ) as unknown as Poly[];
          const m2 = polysArea(inter);
          if (m2 > OVERLAP_M2) overlaps.push({ a: A.r, b: B.r, m2 });
        } catch {
          clipErrors++;
        }
      }
  }

  // Centroid vs features-API center, matched on (site, name, floor).
  const featByKey = new Map<string, ApiFeature>();
  for (const f of apiFeatures)
    if (f.kind === "gallery" && f.name) featByKey.set(`${f.site}|${f.name}|${f.floor}`, f);
  const dists: number[] = [];
  const far: string[] = [];
  let matchedFeats = 0;
  const galleryPolys = rooms.filter((r) => r.galleryNumber);
  for (const r of galleryPolys) {
    const f = featByKey.get(`${r.site}|${r.galleryNumber}|${r.floor}`);
    if (!f) continue;
    matchedFeats++;
    const cLL: Pt = [r.centroidM[0] / MX, r.centroidM[1] / MY];
    const d = haversine(cLL[1], cLL[0], f.lat, f.lon);
    dists.push(d);
    if (d > 25) far.push(`${r.site}:${r.galleryNumber} f${r.floor}: ${d.toFixed(1)} m`);
  }
  dists.sort((a, b) => a - b);
  const q = (p: number) => dists[Math.min(dists.length - 1, Math.floor(dists.length * p))] ?? NaN;

  // Floor inventory vs Living Map's published floors.
  const floorsBySite = new Map<string, Set<string>>();
  for (const r of rooms) {
    let s = floorsBySite.get(r.site);
    if (!s) floorsBySite.set(r.site, (s = new Set()));
    s.add(r.floorName);
  }
  const fifthFloors = floorsBySite.get("fifthAve") ?? new Set();
  const cloistersFloors = floorsBySite.get("cloisters") ?? new Set();

  let status: Status = "PASS";
  if (invalid.length > 0) status = "FAIL";
  if (overlaps.length > 10 || clipErrors > 0) status = worse(status, "WARN");
  if (q(0.9) > 20 || matchedFeats < 0.9 * galleryPolys.length) status = worse(status, "WARN");
  if (fifthFloors.size < 7 || cloistersFloors.size < 2) status = worse(status, "FAIL");

  writeReport("geometry", "Geometry sanity: polygons, overlaps, centroids, floors", status, [
    `## Polygon validity`,
    "",
    `- Room polygons checked: ${rooms.length} (${galleryPolys.length} galleries)`,
    `- Invalid: **${invalid.length}**${invalid.length ? "\n" + invalid.map((s) => `  - ${s}`).join("\n") : ""}`,
    "",
    `## Per-floor overlaps (> ${OVERLAP_M2} m², ${clipErrors} clipping errors)`,
    "",
    `- Overlapping pairs: **${overlaps.length}**`,
    ...overlaps
      .sort((a, b) => b.m2 - a.m2)
      .slice(0, 25)
      .map(
        (o) =>
          `  - ${o.a.site} f${o.a.floor}: ${o.a.galleryNumber ?? o.a.name ?? o.a.type} ∩ ${
            o.b.galleryNumber ?? o.b.name ?? o.b.type
          } = ${o.m2.toFixed(1)} m²`,
      ),
    "",
    `## Polygon centroid vs features-API center`,
    "",
    `- Matched (site, gallery, floor): ${matchedFeats}/${galleryPolys.length} polygons (features API lists ${apiFeatures.filter((f) => f.kind === "gallery").length} galleries)`,
    `- Distance: p50 ${q(0.5).toFixed(1)} m · p90 ${q(0.9).toFixed(1)} m · max ${q(1).toFixed(1)} m`,
    `- Pairs > 25 m: ${far.length}${far.length ? "\n" + far.map((s) => `  - ${s}`).join("\n") : ""}`,
    "",
    "Centroids and the API's label points measure different things (label points are",
    "placed for cartographic readability, often off-center in L-shaped rooms), so a",
    "few-meter spread is expected; large distances would indicate a stitching or",
    "centroid bug.",
    "",
    `## Floor inventory`,
    "",
    `- Fifth Ave: ${[...fifthFloors].sort().join(", ")} (expect 7: G, 1, 1M, 2, 3, 4, 5)`,
    `- Cloisters: ${[...cloistersFloors].sort().join(", ")} (expect 2)`,
  ]);
  console.log(
    `${status} geometry: ${invalid.length} invalid polygons, ${overlaps.length} overlap pairs >${OVERLAP_M2} m², ` +
      `centroid-vs-API p50 ${q(0.5).toFixed(1)} m / p90 ${q(0.9).toFixed(1)} m / max ${q(1).toFixed(1)} m (${matchedFeats} matched)`,
  );
  return status;
}

// =====================================================================
// 3. GRAPH — connectivity, random-pair routing, landmark route, doors
// =====================================================================
function evalGraph(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): Status {
  const { nodes, edges } = graph;
  const adj = new Map<string, { to: string; len: number }[]>();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ to: e.b, len: e.len });
    adj.get(e.b)!.push({ to: e.a, len: e.len });
  }

  // Components per site.
  const comp = new Map<string, number>();
  let c = 0;
  for (const n of nodes) {
    if (comp.has(n.id)) continue;
    const stack = [n.id];
    comp.set(n.id, c);
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
  const compsBySite = new Map<string, Set<number>>();
  for (const n of nodes) {
    let s = compsBySite.get(n.site);
    if (!s) compsBySite.set(n.site, (s = new Set()));
    s.add(comp.get(n.id)!);
  }

  // Dijkstra with a binary heap.
  function dijkstra(src: string, dst: string): { dist: number; hops: number } | null {
    const dist = new Map<string, number>([[src, 0]]);
    const prev = new Map<string, string>();
    const heap: [number, string][] = [[0, src]];
    const pop = (): [number, string] | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1,
            r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };
    const push = (d: number, id: string) => {
      heap.push([d, id]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const done = new Set<string>();
    for (;;) {
      const top = pop();
      if (!top) return null;
      const [d, u] = top;
      if (done.has(u)) continue;
      done.add(u);
      if (u === dst) {
        let hops = 0;
        let cur = dst;
        while (prev.has(cur)) {
          cur = prev.get(cur)!;
          hops++;
        }
        return { dist: d, hops };
      }
      for (const { to, len } of adj.get(u) ?? []) {
        const nd = d + len;
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          prev.set(to, u);
          push(nd, to);
        }
      }
    }
  }

  // 100% random-pair routing over same-site gallery pairs (seeded).
  const galleryNodes = nodes.filter((n) => n.gallery);
  let rngState = 42;
  const rng = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const PAIRS = 500;
  let ok = 0;
  const failures: string[] = [];
  const lens: number[] = [];
  for (let i = 0; i < PAIRS; i++) {
    const a = galleryNodes[Math.floor(rng() * galleryNodes.length)];
    const sameSite = galleryNodes.filter((g) => g.site === a.site);
    const b = sameSite[Math.floor(rng() * sameSite.length)];
    const r = dijkstra(a.id, b.id);
    if (r) {
      ok++;
      lens.push(r.dist);
    } else failures.push(`${a.site}:${a.gallery} -> ${b.gallery}`);
  }
  lens.sort((x, y) => x - y);
  const q = (p: number) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? NaN;

  // Great Hall -> Temple of Dendur (gallery 131). Great Hall has no gallery
  // number; anchor it as the nearest floor-1 fifthAve room node to the
  // features-API "The Great Hall" section center.
  const GH = { lat: 40.779178173, lon: -73.962853333 };
  let ghNode: GraphNode | null = null;
  let ghD = Infinity;
  for (const n of nodes) {
    if (n.site !== "fifthAve" || n.floor !== 1 || n.kind) continue;
    const d = haversine(n.lat, n.lon, GH.lat, GH.lon);
    if (d < ghD) {
      ghD = d;
      ghNode = n;
    }
  }
  const dendur = nodes.find((n) => n.gallery === "131" && n.site === "fifthAve");
  let landmark = "Great Hall or gallery 131 node not found";
  let landmarkOk = false;
  let route: { dist: number; hops: number } | null = null;
  let straight = NaN;
  if (ghNode && dendur) {
    route = dijkstra(ghNode.id, dendur.id);
    straight = haversine(ghNode.lat, ghNode.lon, dendur.lat, dendur.lon);
    if (route) {
      // Sanity: path length must be >= straight line and not absurdly indirect.
      landmarkOk = route.dist >= straight * 0.95 && route.dist <= Math.max(3.5 * straight, straight + 150);
      landmark =
        `Great Hall (node ${ghNode.id}, ${ghD.toFixed(0)} m from the section center) -> gallery 131 ` +
        `(Temple of Dendur): **${route.dist.toFixed(0)} m walked / ${straight.toFixed(0)} m straight-line** ` +
        `(ratio ${(route.dist / straight).toFixed(2)}, ${route.hops} hops, ≈ ${(route.dist / 80).toFixed(1)} min at 80 m/min)`;
    } else landmark = "Great Hall -> gallery 131: NO PATH";
  }

  // Door edges per gallery.
  const doorCount = new Map<string, number>();
  const anyCount = new Map<string, number>();
  for (const e of edges) {
    for (const end of [e.a, e.b]) {
      anyCount.set(end, (anyCount.get(end) ?? 0) + 1);
      if (e.kind === "door") doorCount.set(end, (doorCount.get(end) ?? 0) + 1);
    }
  }
  const noDoor = galleryNodes.filter((n) => !(doorCount.get(n.id)! > 0));
  const noEdge = galleryNodes.filter((n) => !(anyCount.get(n.id)! > 0));

  const fifthComps = compsBySite.get("fifthAve")?.size ?? 0;
  const cloComps = compsBySite.get("cloisters")?.size ?? 0;
  let status: Status = "PASS";
  if (ok < PAIRS || noEdge.length > 0 || !landmarkOk) status = "FAIL";
  if (fifthComps > 1 || cloComps > 1) status = worse(status, "WARN"); // graph.ts already guarantees galleries in main comp
  if (noDoor.length > 0) status = worse(status, "WARN");

  writeReport("graph", "Graph connectivity & routing sanity", status, [
    `## Inventory`,
    "",
    `- Nodes: ${nodes.length} (${galleryNodes.length} galleries), edges: ${edges.length} ` +
      `(${edges.filter((e) => e.kind === "door").length} door, ${edges.filter((e) => e.kind === "walk").length} walk, ` +
      `${edges.filter((e) => e.kind === "stairs").length} stairs, ${edges.filter((e) => e.kind === "elevator").length} elevator)`,
    "",
    `## Connected components`,
    "",
    `- fifthAve: ${fifthComps} component(s); cloisters: ${cloComps} component(s)`,
    "",
    `## Random-pair routing (${PAIRS} seeded same-site gallery pairs)`,
    "",
    `- Success: **${ok}/${PAIRS}**${failures.length ? "\n- Failures:\n" + failures.map((s) => `  - ${s}`).join("\n") : ""}`,
    `- Path length: p50 ${q(0.5).toFixed(0)} m · p95 ${q(0.95).toFixed(0)} m · max ${q(1).toFixed(0)} m`,
    "",
    `## Landmark route`,
    "",
    `- ${landmark}`,
    `- Sanity bound: walked ∈ [0.95×, max(3.5×, +150 m)] of straight-line → ${landmarkOk ? "OK" : "**VIOLATED**"}`,
    "",
    `## Door edges per gallery`,
    "",
    `- Galleries with ≥1 door edge: ${galleryNodes.length - noDoor.length}/${galleryNodes.length}`,
    `- Galleries with NO door edge (connected via repair walk edges only): ${noDoor.length}` +
      (noDoor.length
        ? "\n" + noDoor.map((n) => `  - ${n.site}:${n.gallery} (f${n.floor})`).join("\n")
        : ""),
    `- Galleries with no edges at all: ${noEdge.length}`,
  ]);
  console.log(
    `${status} graph: ${ok}/${PAIRS} pairs routable, fifthAve ${fifthComps} comp / cloisters ${cloComps} comp, ` +
      `GreatHall->Dendur ${route ? route.dist.toFixed(0) + " m (" + (route.dist / straight).toFixed(2) + "x straight)" : "NO PATH"}, ` +
      `${noDoor.length} galleries without a door edge`,
  );
  return status;
}

// =====================================================================
// 4. GPS — synthetic fixes against the reference resolver
// =====================================================================
function evalGps(rooms: RoomFeature[], apiFeatures: ApiFeature[]): Status {
  // Reference resolver, mirroring the design shared/positioning.ts implements:
  // GPS only ever yields {atMuseum, site, wing hint} — NEVER a room (browser
  // indoor error is 30–100 m and carries no floor). Outliers (> 200 m from the
  // building or accuracy worse than 300 m) are ignored.
  const siteBounds = new Map<string, [number, number, number, number]>(); // [lonMin, latMin, lonMax, latMax]
  for (const r of rooms) {
    const bb = siteBounds.get(r.site) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (const rings of r.polysLL)
      for (const [lon, lat] of rings[0]) {
        bb[0] = Math.min(bb[0], lon);
        bb[1] = Math.min(bb[1], lat);
        bb[2] = Math.max(bb[2], lon);
        bb[3] = Math.max(bb[3], lat);
      }
    siteBounds.set(r.site, bb);
  }
  const sections = apiFeatures.filter((f) => f.kind === "section" && f.name);
  const distToBounds = (lat: number, lon: number, bb: [number, number, number, number]): number => {
    const clampedLon = Math.max(bb[0], Math.min(bb[2], lon));
    const clampedLat = Math.max(bb[1], Math.min(bb[3], lat));
    return haversine(lat, lon, clampedLat, clampedLon);
  };
  interface Fix {
    lat: number;
    lon: number;
    accuracy: number;
  }
  interface Resolved {
    atMuseum: boolean;
    site?: string;
    wing?: string;
    // deliberately NO room/gallery field — wing-level is the resolver's ceiling
  }
  const resolve = (fix: Fix): Resolved => {
    if (fix.accuracy > 300) return { atMuseum: false };
    let bestSite: string | null = null;
    let bestD = Infinity;
    for (const [site, bb] of siteBounds) {
      const d = distToBounds(fix.lat, fix.lon, bb);
      if (d < bestD) {
        bestD = d;
        bestSite = site;
      }
    }
    if (bestSite === null || bestD > 200) return { atMuseum: false };
    let wing: string | undefined;
    let wd = Infinity;
    for (const s of sections) {
      if (s.site !== bestSite) continue;
      const d = haversine(fix.lat, fix.lon, s.lat, s.lon);
      if (d < wd) {
        wd = d;
        wing = s.name!;
      }
    }
    return { atMuseum: true, site: bestSite, wing };
  };

  // Case 1: Fifth Ave entrance fix (J1 coordinates).
  const entrance = resolve({ lat: 40.7794, lon: -73.9632, accuracy: 40 });
  const c1Ok = entrance.atMuseum && entrance.site === "fifthAve" && !!entrance.wing;

  // Case 2: Central Park outlier, 800 m accuracy.
  const outlier = resolve({ lat: 40.7794, lon: -73.97, accuracy: 800 });
  const outlier2 = resolve({ lat: 40.7794, lon: -73.97, accuracy: 50 }); // plausible accuracy, wrong place
  const c2Ok = !outlier.atMuseum && !outlier2.atMuseum;

  // Case 3: 65 m-noise cloud around a point inside the Great Hall.
  const TRUE = { lat: 40.779178173, lon: -73.962853333 };
  let rngState = 7;
  const rng = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const SIGMA = 32.5; // ~95% of fixes within 65 m (the measured iOS WiFi error)
  const N = 200;
  const wingVotes = new Map<string, number>();
  let atMuseumCount = 0;
  // Quantify why room-level is impossible: which rooms would naive
  // point-in-polygon claim, across all floors (GPS has no floor signal)?
  const roomClaims = new Map<string, number>(); // smallest containing room per floor
  let trueRoomHits = 0;
  const fifthRooms = rooms.filter((r) => r.site === "fifthAve");
  // ground truth: the smallest floor-1 room containing TRUE
  const trueM = toM([TRUE.lon, TRUE.lat]);
  let trueRoom: RoomFeature | null = null;
  for (const r of fifthRooms)
    if (r.floor === 1 && (trueRoom === null || r.area < trueRoom.area) && pointInPolys(trueM, r.polysM))
      trueRoom = r;
  for (let i = 0; i < N; i++) {
    const fix: Fix = {
      lat: TRUE.lat + (gauss() * SIGMA) / MY,
      lon: TRUE.lon + (gauss() * SIGMA) / MX,
      accuracy: 65,
    };
    const res = resolve(fix);
    if (res.atMuseum) {
      atMuseumCount++;
      if (res.wing) wingVotes.set(res.wing, (wingVotes.get(res.wing) ?? 0) + 1);
    }
    const pM = toM([fix.lon, fix.lat]);
    let smallestPerFloor = new Map<number, RoomFeature>();
    for (const r of fifthRooms) {
      const cur = smallestPerFloor.get(r.floor);
      if ((cur === undefined || r.area < cur.area) && pointInPolys(pM, r.polysM))
        smallestPerFloor.set(r.floor, r);
    }
    for (const [fl, r] of smallestPerFloor) {
      const k = `f${fl}:${r.galleryNumber ?? r.name ?? r.type}`;
      roomClaims.set(k, (roomClaims.get(k) ?? 0) + 1);
      if (trueRoom && fl === 1 && r === trueRoom) trueRoomHits++;
    }
  }
  const topWings = [...wingVotes.entries()].sort((a, b) => b[1] - a[1]);
  const modalWingPct = topWings.length ? (100 * topWings[0][1]) / N : 0;
  const c3Ok = atMuseumCount >= 0.9 * N && modalWingPct >= 50 && roomClaims.size >= 5;

  const status: Status = c1Ok && c2Ok && c3Ok ? "PASS" : "FAIL";
  writeReport("gps", "GPS mapping: synthetic fixes vs the wing-level resolver", status, [
    "The resolver under test is the reference implementation of the positioning",
    "design: GPS may only yield `{atMuseum, site, wing}` — its output type has no",
    "room field, so a room-level claim is impossible by construction. The cases",
    "verify the *data* supports this design and quantify why room-level would be",
    "wrong if attempted.",
    "",
    `## Case 1 — Fifth Ave entrance fix (40.7794, -73.9632, ±40 m) — ${c1Ok ? "OK" : "**FAIL**"}`,
    "",
    `- Resolved: atMuseum=${entrance.atMuseum}, site=${entrance.site}, wing="${entrance.wing}"`,
    "",
    `## Case 2 — Central Park outlier (40.7794, -73.97) — ${c2Ok ? "OK" : "**FAIL**"}`,
    "",
    `- ±800 m accuracy → atMuseum=${outlier.atMuseum} (rejected: accuracy > 300 m)`,
    `- ±50 m accuracy, ~300 m from the building → atMuseum=${outlier2.atMuseum} (rejected: > 200 m outside)`,
    "",
    `## Case 3 — ${N} fixes, Gaussian σ=${SIGMA} m (≈65 m 95% error) around the Great Hall — ${c3Ok ? "OK" : "**FAIL**"}`,
    "",
    `- Resolved at-museum: ${atMuseumCount}/${N}`,
    `- Wing votes: ${topWings.slice(0, 5).map(([w, n]) => `"${w}" ${n}`).join(" · ")} (modal ${modalWingPct.toFixed(0)}%)`,
    `- **Why never room-level**: naive smallest-room point-in-polygon over the same fixes`,
    `  claims **${roomClaims.size} distinct rooms across floors** (GPS has no floor signal);`,
    `  the true room (${trueRoom ? (trueRoom.galleryNumber ?? trueRoom.name ?? trueRoom.type) : "?"}, floor 1) is hit on only ` +
      `${((100 * trueRoomHits) / N).toFixed(0)}% of fixes.`,
    "",
    `Top rooms a naive room-level resolver would have claimed:`,
    "",
    ...[...roomClaims.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, n]) => `- ${k}: ${n} fixes`),
    "",
    "Assertions: ≥90% of cloud fixes resolve at-museum, modal wing ≥50%, and the",
    "naive room claim set has ≥5 distinct rooms (demonstrating room-level GPS would",
    "be majority-wrong, which is why the resolver caps at wing level).",
  ]);
  console.log(
    `${status} gps: entrance->"${entrance.wing}" ok=${c1Ok}, outlier rejected=${c2Ok}, ` +
      `cloud modal wing ${modalWingPct.toFixed(0)}% ("${topWings[0]?.[0] ?? "?"}"), ` +
      `naive room-claim spread ${roomClaims.size} rooms, true room only ${((100 * trueRoomHits) / N).toFixed(0)}%`,
  );
  return status;
}

// =====================================================================
// 5. VISUAL — per-floor SVG: polygons + graph overlay + gallery numbers
// =====================================================================
function evalVisual(rooms: RoomFeature[], graph: { nodes: GraphNode[]; edges: GraphEdge[] }): Status {
  fs.mkdirSync(FLOORS_DIR, { recursive: true });
  const FILL: Record<string, string> = {
    gallery: "#f7efe0",
    exhibition: "#fbe3e3",
    corridor: "#f2f2f2",
    vista: "#eef3f7",
  };
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // shared per-site bounds so all floors of a site align
  const bounds = new Map<string, [number, number, number, number]>();
  for (const r of rooms) {
    const bb = bounds.get(r.site) ?? [Infinity, Infinity, -Infinity, -Infinity];
    for (const rings of r.polysM)
      for (const [x, y] of rings[0]) {
        bb[0] = Math.min(bb[0], x);
        bb[1] = Math.min(bb[1], y);
        bb[2] = Math.max(bb[2], x);
        bb[3] = Math.max(bb[3], y);
      }
    bounds.set(r.site, bb);
  }
  const floors = [...new Set(rooms.map((r) => `${r.site}|${r.floor}`))].sort();
  const written: { file: string; site: string; floorName: string; rooms: number; edges: number }[] = [];
  for (const key of floors) {
    const [site, floorStr] = key.split("|");
    const floor = Number(floorStr);
    const floorRooms = rooms.filter((r) => r.site === site && r.floor === floor);
    const bb = bounds.get(site)!;
    const PAD = 10;
    const SCALE = site === "fifthAve" ? 3.2 : 4.5; // px per meter
    const W = Math.max(720, Math.ceil((bb[2] - bb[0] + 2 * PAD) * SCALE)); // min width fits the legend
    const H = Math.ceil((bb[3] - bb[1] + 2 * PAD) * SCALE);
    const X = (x: number) => ((x - bb[0] + PAD) * SCALE).toFixed(1);
    const Y = (y: number) => ((bb[3] - y + PAD) * SCALE).toFixed(1); // north up
    const els: string[] = [];
    for (const r of floorRooms.sort((a, b) => b.area - a.area)) {
      const d = r.polysM
        .map((rings) =>
          rings.map((ring) => "M" + ring.map(([x, y]) => `${X(x)},${Y(y)}`).join("L") + "Z").join(""),
        )
        .join("");
      const fill = r.galleryNumber ? (FILL[r.type] ?? FILL.gallery) : (FILL[r.type] ?? "#e9e9e9");
      els.push(
        `<path d="${d}" fill="${fill}" stroke="#888" stroke-width="0.6" fill-rule="evenodd"${
          r.closed ? ' stroke-dasharray="3,2" opacity="0.55"' : ""
        }/>`,
      );
    }
    // graph edges on this floor
    let edgeCount = 0;
    for (const e of graph.edges) {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b || a.site !== site || a.floor !== floor || b.floor !== floor) continue;
      if (e.kind !== "walk" && e.kind !== "door") continue;
      const [ax, ay] = toM([a.lon, a.lat]);
      const [bx, by] = toM([b.lon, b.lat]);
      els.push(
        `<line x1="${X(ax)}" y1="${Y(ay)}" x2="${X(bx)}" y2="${Y(by)}" stroke="${
          e.kind === "door" ? "#e4002b" : "#3a7bd5"
        }" stroke-width="${e.kind === "door" ? 0.9 : 0.5}" opacity="0.55"/>`,
      );
      edgeCount++;
    }
    // nodes: doors as dots, vertical units as markers
    for (const n of graph.nodes) {
      if (n.site !== site || n.floor !== floor) continue;
      const [x, y] = toM([n.lon, n.lat]);
      if (n.kind === "door")
        els.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="1.3" fill="#e4002b" opacity="0.8"/>`);
      else if (n.kind === "elevator")
        els.push(`<rect x="${(Number(X(x)) - 3).toFixed(1)}" y="${(Number(Y(y)) - 3).toFixed(1)}" width="6" height="6" fill="#7a4dc9"><title>elevator</title></rect>`);
      else if (n.kind === "stairs" || n.kind === "steps" || n.kind === "escalator")
        els.push(
          `<path d="M${(Number(X(x)) - 3.5).toFixed(1)},${(Number(Y(y)) + 3).toFixed(1)} l3.5,-6 l3.5,6 Z" fill="#2c9c5a"><title>${n.kind}</title></path>`,
        );
    }
    // gallery number labels last (on top)
    for (const r of floorRooms) {
      if (!r.galleryNumber) continue;
      const [cx, cy] = r.centroidM;
      const label = r.galleryNumber.length > 8 ? (r.galleryNumber.match(/\d+/)?.[0] ?? "EX") : r.galleryNumber;
      els.push(
        `<text x="${X(cx)}" y="${Y(cy)}" font-size="${Math.min(9, Math.max(5, Math.sqrt(r.area) / 2.5))}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#222">${label}</text>`,
      );
    }
    const floorName = floorRooms[0]?.floorName ?? `Floor ${floor}`;
    const legend =
      `<g font-family="Helvetica,Arial,sans-serif" font-size="11">` +
      `<text x="12" y="18" font-size="14" font-weight="bold">The Met ${site === "fifthAve" ? "Fifth Avenue" : "Cloisters"} — ${floorName}</text>` +
      `<text x="12" y="34">■ gallery <tspan fill="#888">(grey: non-gallery rooms)</tspan> · <tspan fill="#e4002b">red: doorway nodes/edges</tspan> · <tspan fill="#3a7bd5">blue: within-room walk edges</tspan> · <tspan fill="#2c9c5a">▲ stairs</tspan> · <tspan fill="#7a4dc9">■ elevator</tspan></text></g>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="white"/>${legend}${els.join("")}</svg>`;
    const file = `${site}-f${String(floor).replace(".", "_")}.svg`;
    fs.writeFileSync(path.join(FLOORS_DIR, file), svg);
    written.push({ file, site, floorName, rooms: floorRooms.length, edges: edgeCount });
  }
  const status: Status = written.length >= 9 && written.every((w) => w.rooms > 0) ? "PASS" : "FAIL";
  writeReport("visual", "Visual diff: per-floor SVG renders", status, [
    "Human-reviewable renders of the decoded geometry with the derived routing",
    "graph overlaid. Red dots/edges are doorway nodes and door connections; blue",
    "edges are within-room door-to-door walking; triangles/squares are stair and",
    "elevator shafts; labels are gallery numbers placed at polygon centroids.",
    "",
    "| File | Site | Floor | Rooms | Graph edges drawn |",
    "|---|---|---|---|---|",
    ...written.map(
      (w) => `| [floors/${w.file}](floors/${w.file}) | ${w.site} | ${w.floorName} | ${w.rooms} | ${w.edges} |`,
    ),
  ]);
  console.log(
    `${status} visual: ${written.length} floor SVGs -> data/evals/reports/floors/ (` +
      written.map((w) => `${w.site.slice(0, 5)}:${w.floorName.replace("Floor ", "")}`).join(", ") +
      ")",
  );
  return status;
}

// ---------- main ----------
function main(): void {
  const rooms = loadRooms();
  const apiFeatures = loadApiFeatures();
  const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = JSON.parse(
    fs.readFileSync(path.join(SNAP, "graph.json"), "utf8"),
  );
  const statuses = [
    evalCoverage(rooms),
    evalGeometry(rooms, apiFeatures),
    evalGraph(graph),
    evalGps(rooms, apiFeatures),
    evalVisual(rooms, graph),
  ];
  const overall = statuses.reduce(worse, "PASS");
  console.log(`\noverall: ${overall} (reports in data/evals/reports/)`);
  if (overall === "FAIL") process.exit(1);
}

main();
