/**
 * Louvre geometry + routing graph from OpenStreetMap indoor mapping (D7).
 *
 * One-time ETL, Living-Map discipline: the Overpass extract was fetched ONCE
 * (2026-07-05, bbox 48.8590,2.3330,48.8630,2.3400 — palais du Louvre) and is
 * committed at data/raw/louvre/osm/overpass-indoor.json; this script never
 * touches the network. Data © OpenStreetMap contributors, ODbL — the decoded
 * geometry ships openly inside met.sqlite with attribution (ARCHITECTURE.md
 * "Data provenance").
 *
 * Emits (data/museums/louvre/snapshots/):
 *   galleries.geojson — room/corridor/area polygons; galleryNumber = the plan
 *     tool's salle code where an OSM room could be matched, else null
 *     (backdrop). floor/floorName are the plan's niveau labels "-1|0|1|2" as
 *     STRINGS (the client's floorLabel() passes string floors through, so the
 *     Met's numeric 0→"G" convention never fires for Louvre features).
 *   amenities.geojson  — restrooms/dining/shops/elevators/entrances/info points.
 *   graph.json         — nodes/edges in data/src/graph.ts's exact shape
 *                        (rooms r{wayId}, units u{wayId}f{floor}, doors d{n};
 *                        walk/door/stairs/elevator edges, door bearings).
 *   geometry-meta.json — headline match-rate + graph numbers for evals-louvre.
 *
 * WHY A STANDALONE SCRIPT instead of generalizing data/src/graph.ts: the Met
 * pipeline is welded to Living Map's tile encoding (MVT decode, door barrier
 * LINES, per-tile stitching, shaft union-find across floors) and its output
 * must stay byte-identical. The OSM source is structurally different in ways
 * that delete most of that code rather than parameterize it:
 *   - doors are NODES that are shared VERTICES of the room ways they join, so
 *     the door adapter synthesizes the wall direction from the containing
 *     way's adjacent segments and reuses the Met's perpendicular-probe idea
 *     (same offsets/cluster tunables) — no barrier lines needed;
 *   - vertical circulation carries explicit level lists (room=stairs /
 *     highway=elevator with level="-1;-0.5;0"), so shafts are given, not
 *     inferred by polygon-overlap union-find.
 *
 * SALLE MATCHING (the headline metric): the plan tool's salle codes
 * (data/raw/louvre/plan/, parsed by lib/louvre-plan.ts — 389 rooms, 376 real
 * "Salle N" codes + 13 internal-key rooms) are matched against OSM rooms by
 *   1. code extraction from ref / alt_name / name ("Salle 711", ref=714,
 *      alt_name="716") — OSM predates the Louvre's 2019-2021 renumbering in
 *      most wings (Sully/Richelieu rooms still carry old numbers like
 *      "Salle 17", which match no current plan code and are ignored), so
 *      code matches concentrate in Denon's 7xx/8xx/9xx wings;
 *   2. normalized-name equality (case/diacritics/punctuation folded) between
 *      OSM name/alt_name parts and plan title segments ("Salle des Sept-
 *      Mètres" ↔ "Salle 709 - Salle des Sept-Mètres");
 *   both validated against the plan floor via the OSM-level window below;
 *   ambiguous name matches (e.g. "Grande Galerie" ↔ plan 710/712/716 thirds)
 *   are DROPPED, never guessed — codes are only ever copied from the plan.
 *
 * OSM LEVEL → PLAN NIVEAU: OSM maps the palace's real half-levels (entresol
 * -0.5, Assyrie mezzanine 0.25/0.5, Hall Napoléon -2, 2.25 attic galleries…);
 * the plan flattens them to 4 niveaux. Windows measured from the code+name
 * matches (violations are reported by the verification step):
 *   level < -0.3 → "-1"   |   -0.3 ≤ level < 0.7 → "0"
 *   0.7 ≤ level < 1.7 → "1"   |   level ≥ 1.7 → "2"
 * Matched rooms always take the PLAN's floor; the window only (a) validates
 * matches and (b) assigns floors to unmatched backdrop.
 *
 * Usage: npm -w data run geometry:louvre   (tsx src/geometry-osm.ts; no network)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlanSalles, type PlanSalle } from "./lib/louvre-plan.ts";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OSM_FILE = path.join(DATA_DIR, "raw", "louvre", "osm", "overpass-indoor.json");
const PLAN_DIR = path.join(DATA_DIR, "raw", "louvre", "plan");
const SNAP = path.join(DATA_DIR, "museums", "louvre", "snapshots");
const SITE = "louvre";

// Tunables — same values as data/src/graph.ts (meters).
const PROBE_OFFSETS_M = [0.4, 0.8, 1.5, 2.5];
const DOOR_CLUSTER_M = 3;
const STAIRS_M_PER_LEVEL = 15;
const ELEVATOR_M_PER_LEVEL = 25;
const REPAIR_GAP_M = 1.25;

// Local equirectangular meters at the Louvre (48.861°N).
const D2R = Math.PI / 180;
const LAT0 = 48.861;
const MX = Math.cos(LAT0 * D2R) * 111319.49;
const MY = 111207; // meridian degree length at 48.9°N
type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[]; // [exterior, ...holes]
const toM = ([lon, lat]: Pt): Pt => [lon * MX, lat * MY];
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- polygon helpers (meter space; same algorithms as graph.ts) ----------
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

function ringArea(ring: Ring): number {
  const [ox, oy] = ring[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
  return a / 2;
}
const polysArea = (polys: Poly[]): number =>
  polys.reduce((s, rings) => s + Math.abs(ringArea(rings[0])), 0);

function polysCentroid(polys: Poly[]): Pt {
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

// ---------- OSM parsing ----------
interface OsmEl {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: Array<{ type: string; ref: number; role: string }>;
  tags?: Record<string, string>;
}

/** level="−1;−0.5" lists and the lone "0-2" range → sorted numbers. */
function parseLevels(raw: string | undefined): number[] {
  if (!raw) return [];
  const out = new Set<number>();
  for (const tok of raw.split(";")) {
    const t = tok.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      out.add(Number(t));
      continue;
    }
    const m = t.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (let l = Math.ceil(a); l <= Math.floor(b); l++) out.add(l);
      out.add(a);
      out.add(b);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** OSM level → plan niveau label (see header; matched rooms use the plan's floor). */
function planFloorOf(level: number): string {
  if (level < -0.3) return "-1";
  if (level < 0.7) return "0";
  if (level < 1.7) return "1";
  return "2";
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Name variants for matching: the normalized string plus copies with the
 * leading article ("La Tête de feuilles" ↔ plan "Tête de feuilles") and the
 * "Salle de la/du/des" prefix folded ("Salle de la Vénus de Milo" ↔ the plan's
 * parenthetical "(Vénus de Milo)"). Pure normalization — no token guessing.
 */
function nameVariants(s: string): string[] {
  const n = norm(s);
  const out = new Set<string>([n]);
  const salle = n.replace(/^(?:salle|salon|salles) (?:de la |de l |du |des |de )?/, "");
  out.add(salle);
  for (const v of [...out]) out.add(v.replace(/^(?:la |le |les |l )/, ""));
  return [...out].filter((v) => v.length >= 4);
}

/**
 * Hand-verified OSM-name → salle-code aliases for the few rooms whose OSM and
 * plan spellings diverge beyond normalization (the Met's gallery-aliases.json
 * precedent). Each pair was checked against both sources by hand; aliases are
 * still floor-validated like every other match.
 */
const NAME_ALIASES: Record<string, string> = {
  // OSM "Salle du Code de Hammourabi" / plan 227 "Salle du code d'Hammurabi"
  "salle du code de hammourabi": "227",
  // OSM "Antiquité Égyptienne - Les Animaux et les Dieux" / plan 318 "Animaux et dieux"
  "les animaux et les dieux": "318",
  // OSM "Les Travaux et les Champs" / plan 333 "Les travaux des champs"
  "les travaux et les champs": "333",
  // OSM "Salle des Caryatides" / plan 348 — the Louvre's own pages title salle
  // 348 "Salle des Cariatides"; the plan JSON uses the thematic title only
  "salle des caryatides": "348",
  // OSM "Crypte Girardon" / plan 104 "Crypte François Girardon (1628-1715)"
  "crypte girardon": "104",
  // OSM "La \"Bottega\" des Della Robbia" / plan 163 "La Botega des Della Robbia"
  "la bottega des della robbia": "163",
  // OSM "Arts de l'Islam : vers 700-1000" (the pavilion's upper level, -0.5) /
  // plan 185 "Arts de l'Islam - De 632 à 1000" — same "…to 1000" room; the
  // pavilion's lower level (OSM -2, "de 1000 à 1800") spans plan 186+187 and
  // stays unmatched (ambiguous)
  "arts de l islam vers 700 1000": "185",
};

/** Numeric salle-code candidates in a tag value ("Salle 711", "716", "227 bis"). */
function codeCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const part of value.split(";")) {
    const bare = part.trim().match(/^(\d{1,3})(?:\s*(bis|b))?$/i);
    if (bare) {
      out.add(bare[1] + (bare[2]?.toLowerCase() === "bis" ? "bis" : ""));
      continue;
    }
    const re = /salle\s+(\d{1,3})(?:\s*(bis)\b)?/gi;
    let m;
    while ((m = re.exec(part))) out.add(m[1] + (m[2] ? "bis" : ""));
  }
  return [...out];
}

// ---------- space / unit model ----------
type SpaceKind = "room" | "stairs" | "elevator";
interface Space {
  id: string; // graph node id (rooms) / unit id base (vertical)
  osmId: number;
  kind: SpaceKind;
  osmType: string; // room|corridor|area (indoor=) or elevator
  tags: Record<string, string>;
  roomTag: string | null;
  levels: number[];
  name: string | null;
  gallery: string | null;
  planTitle: string | null;
  matchVia: "code" | "name" | null;
  type: string; // geojson type vocabulary
  planFloor: string; // "-1"|"0"|"1"|"2"
  floorNum: number;
  polysLL: Poly[];
  polysM: Poly[];
  area: number;
  centroidM: Pt;
  centroidLL: Pt; // [lon, lat]
  /** vertical units: node id per plan floor. */
  unitFloors?: Map<string, string>;
}

function main(): void {
  const osm: { elements: OsmEl[] } = JSON.parse(fs.readFileSync(OSM_FILE, "utf8"));
  const plan = loadPlanSalles(PLAN_DIR);
  const nodesById = new Map<number, OsmEl>();
  const waysById = new Map<number, OsmEl>();
  for (const e of osm.elements) {
    if (e.type === "node") nodesById.set(e.id, e);
    else if (e.type === "way") waysById.set(e.id, e);
  }
  const t = (e: OsmEl, k: string): string | undefined => e.tags?.[k];

  const ringOf = (way: OsmEl): Ring | null => {
    const pts: Ring = [];
    for (const nid of way.nodes ?? []) {
      const n = nodesById.get(nid);
      if (!n || n.lat === undefined || n.lon === undefined) return null;
      pts.push([round7(n.lon), round7(n.lat)]);
    }
    if (pts.length < 4) return null;
    const [f, l] = [pts[0], pts[pts.length - 1]];
    if (f[0] !== l[0] || f[1] !== l[1]) pts.push(f);
    return pts;
  };

  // ---- 1. spaces + vertical units from indoor ways/relations -----------------
  const spaces: Space[] = [];
  const spaceByOsmId = new Map<number, Space>();
  const mkSpace = (
    el: OsmEl,
    polysLL: Poly[],
    kind: SpaceKind,
    osmType: string,
  ): Space | null => {
    if (polysLL.length === 0) return null;
    const polysM = polysLL.map((rings) => rings.map((ring) => ring.map((c) => toM(c))));
    // OSM micro-slivers (sub-0.5 m² niches/artifacts) are not rooms
    if (polysArea(polysM) < 0.5) return null;
    const levels = parseLevels(t(el, "level"));
    const cM = polysCentroid(polysM);
    const centroidLL: Pt = [round7(cM[0] / MX), round7(cM[1] / MY)];
    const planFloor = planFloorOf(levels[0] ?? 0);
    const sp: Space = {
      id: `${el.type === "relation" ? "rl" : "r"}${el.id}`,
      osmId: el.id,
      kind,
      osmType,
      tags: el.tags ?? {},
      roomTag: t(el, "room") ?? null,
      levels,
      name: t(el, "name") ?? null,
      gallery: null,
      planTitle: null,
      matchVia: null,
      type: osmType === "corridor" ? "corridor" : "gallery", // refined below
      planFloor,
      floorNum: Number(planFloor),
      polysLL,
      polysM,
      area: polysArea(polysM),
      centroidM: cM,
      centroidLL,
    };
    spaces.push(sp);
    if (el.type === "way") spaceByOsmId.set(el.id, sp);
    return sp;
  };

  const isStairsSpace = (el: OsmEl): boolean =>
    t(el, "room") === "stairs" ||
    t(el, "stairs") === "yes" ||
    /^escalier\b/i.test(t(el, "name") ?? "") ||
    /^escalator\b/i.test(t(el, "name") ?? "");

  for (const el of osm.elements) {
    if (el.type === "node") continue;
    const indoor = t(el, "indoor");
    const isElevator = t(el, "highway") === "elevator";
    if (!isElevator && !["room", "corridor", "area"].includes(indoor ?? "")) continue;
    let polysLL: Poly[] = [];
    if (el.type === "way") {
      const ring = ringOf(el);
      if (!ring) continue;
      polysLL = [[ring]];
    } else {
      // 3 multipolygon relations (indoor=area): outer rings minus inner.
      const outers: Ring[] = [];
      const inners: Ring[] = [];
      for (const m of el.members ?? []) {
        if (m.type !== "way") continue;
        const w = waysById.get(m.ref);
        if (!w) continue;
        const ring = ringOf(w);
        if (ring) (m.role === "inner" ? inners : outers).push(ring);
      }
      polysLL = outers.map((o) => [o, ...inners.filter((i) => pointInRing(toM(i[0]), o.map(toM)))]);
    }
    const kind: SpaceKind = isElevator ? "elevator" : isStairsSpace(el) ? "stairs" : "room";
    mkSpace(el, polysLL, kind, isElevator ? "elevator" : indoor!);
  }

  // ---- 2. salle matching -----------------------------------------------------
  // Plan name index: normalized title segments → codes. A plan title like
  // "Salle 220 - Jean Jacques Caffieri (1725-1792) et Jean-Baptiste Pigalle
  // (1714-1785)" indexes the full title, each " - " segment, paren-stripped
  // segments, parenthetical CONTENTS ("Vénus de Milo"), and " et "-joined
  // halves — every one an exact literal from the plan, never a guess.
  // Two tiers: full-title equality (A) outranks segment equality (B), so
  // "Mésopotamie" still binds to salle 228 ("Salle 228 - Mésopotamie") even
  // though 230's title contains a "Mésopotamie" segment.
  const planNameIndexA = new Map<string, Set<string>>();
  const planNameIndexB = new Map<string, Set<string>>();
  const addName = (index: Map<string, Set<string>>, raw: string, code: string) => {
    for (const v of nameVariants(raw)) {
      let s = index.get(v);
      if (!s) index.set(v, (s = new Set()));
      s.add(code);
    }
  };
  for (const [code, s] of plan) {
    for (const part of s.title.split(" / ")) {
      addName(planNameIndexA, part, code);
      const rest = part.replace(/^Salle\s+\d+\s*(?:bis)?\s*-\s*/i, "");
      addName(planNameIndexA, rest, code);
      // parentheticals first (they may contain " - "), then segment splits
      for (const m of rest.matchAll(/\(([^)]+)\)/g)) addName(planNameIndexB, m[1], code);
      const noParen = rest.replace(/\s*\([^)]*\)/g, "").trim();
      addName(planNameIndexA, noParen, code);
      for (const seg of noParen.split(" - ")) {
        addName(planNameIndexB, seg, code);
        for (const half of seg.split(/\s+et\s+/i)) if (half.split(/\s+/).length >= 2) addName(planNameIndexB, half, code);
        // thematic split "Dieux et héros du monde grec antique : Apollon, …"
        for (const half of seg.split(" : ")) addName(planNameIndexB, half, code);
      }
    }
  }

  // floor validation: any of the space's OSM levels must window to the plan floor
  const floorCompatible = (sp: Space, code: string): boolean => {
    const pf = plan.get(code)!.floor;
    if (sp.levels.length === 0) return true;
    return sp.levels.some((l) => planFloorOf(l) === pf);
  };

  const codeAssign = new Map<string, Space[]>(); // code -> spaces
  const floorRejected: string[] = [];
  // pass 1: explicit codes (ref / alt_name / name)
  for (const sp of spaces) {
    const tags = sp.tags;
    const cands = new Set<string>([
      ...codeCandidates(tags.ref),
      ...codeCandidates(tags.alt_name),
      ...codeCandidates(tags.name),
    ]);
    const valid = [...cands].filter((c) => plan.has(c));
    for (const c of valid) {
      if (!floorCompatible(sp, c)) {
        floorRejected.push(`${sp.id} code ${c} (levels ${sp.levels.join(";")} vs plan floor ${plan.get(c)!.floor})`);
        continue;
      }
      if (sp.gallery === null) {
        sp.gallery = c;
        sp.matchVia = "code";
        let l = codeAssign.get(c);
        if (!l) codeAssign.set(c, (l = []));
        l.push(sp);
      }
    }
  }
  // pass 2: unambiguous normalized-name matches (aliases first, then variants
  // of the OSM name and each of its " - " segments against the plan index)
  let nameAmbiguous = 0;
  for (const sp of spaces) {
    if (sp.gallery !== null) continue;
    const tags = sp.tags;
    const names = [tags.name, ...(tags.alt_name ?? "").split(";")].filter(Boolean) as string[];
    const lookups = new Set<string>();
    for (const nm of names) {
      for (const v of nameVariants(nm)) lookups.add(v);
      // OSM lists co-hung sculptors etc. with " - " and ","
      for (const seg of nm.split(/ - |,/)) for (const v of nameVariants(seg)) lookups.add(v);
    }
    const assign = (c: string) => {
      sp.gallery = c;
      sp.matchVia = "name";
      let l = codeAssign.get(c);
      if (!l) codeAssign.set(c, (l = []));
      l.push(sp);
    };
    let done = false;
    for (const v of lookups) {
      const alias = NAME_ALIASES[v];
      if (alias && plan.has(alias) && floorCompatible(sp, alias)) {
        assign(alias);
        done = true;
        break;
      }
    }
    if (done) continue;
    // tier A (full-title equality) first; only if empty, tier B (segments).
    // Unambiguous iff exactly one code survives the floor filter.
    for (const index of [planNameIndexA, planNameIndexB]) {
      const codes = new Set<string>();
      for (const v of lookups) for (const c of index.get(v) ?? []) if (floorCompatible(sp, c)) codes.add(c);
      if (codes.size === 1) {
        assign([...codes][0]);
        break;
      }
      if (codes.size > 1) {
        nameAmbiguous++;
        break;
      }
    }
  }
  // matched spaces adopt the plan's floor + title
  for (const [code, sps] of codeAssign) {
    const s = plan.get(code)!;
    for (const sp of sps) {
      sp.planTitle = s.title;
      sp.planFloor = s.floor;
      sp.floorNum = Number(s.floor);
    }
  }

  // geojson type vocabulary (Met Living-Map values where they exist)
  for (const sp of spaces) {
    if (sp.kind !== "room") continue;
    const rt = sp.roomTag;
    sp.type =
      rt === "toilets" ? "toilet"
      : rt === "restaurant" ? "restaurant"
      : rt === "shop" ? "shop"
      : rt === "auditorium" ? "auditorium"
      : sp.osmType === "corridor" ? "corridor"
      : sp.gallery !== null || rt === "collection" ? "gallery"
      : sp.osmType === "area" ? "corridor" // open walkable zones
      : sp.name !== null ? "gallery"
      : "corridor";
  }

  // ---- 3. vertical unit nodes (one per plan floor spanned) -------------------
  for (const sp of spaces) {
    if (sp.kind === "room") continue;
    const floors = [...new Set(sp.levels.map(planFloorOf))].sort((a, b) => Number(a) - Number(b));
    sp.unitFloors = new Map(floors.map((f) => [f, `u${sp.osmId}f${f}`]));
  }

  // ---- 4. doors: shared-vertex wall direction + perpendicular probe ----------
  const wayMembership = new Map<number, OsmEl[]>(); // nodeId -> indoor space/unit ways
  for (const w of osm.elements) {
    if (w.type !== "way" || !spaceByOsmId.has(w.id)) continue;
    for (const nid of w.nodes ?? []) {
      let l = wayMembership.get(nid);
      if (!l) wayMembership.set(nid, (l = []));
      l.push(w);
    }
  }

  interface Doorway {
    a: Space;
    b: Space;
    levels: number[];
    midsM: Pt[];
  }
  const doorways = new Map<string, Doorway[]>();
  let doorsProbed = 0;
  let doorsTwoSided = 0;
  let doorsNoWall = 0;
  const levelSetOf = (sp: Space): number[] => (sp.levels.length ? sp.levels : [0]);

  for (const el of osm.elements) {
    if (el.type !== "node" || !t(el, "door")) continue;
    doorsProbed++;
    const containing = wayMembership.get(el.id) ?? [];
    // wall direction from the first containing way's segments adjacent to this node
    let dir: Pt | null = null;
    for (const w of containing) {
      const idx = (w.nodes ?? []).indexOf(el.id);
      if (idx < 0) continue;
      const nb = (i: number): Pt | null => {
        const nn = nodesById.get(w.nodes![((i % w.nodes!.length) + w.nodes!.length) % w.nodes!.length]);
        return nn && nn.lat !== undefined ? toM([nn.lon!, nn.lat]) : null;
      };
      const prev = nb(idx === 0 ? w.nodes!.length - 2 : idx - 1); // rings repeat the first node
      const next = nb(idx === w.nodes!.length - 1 ? 1 : idx + 1);
      if (prev && next) {
        const d: Pt = [next[0] - prev[0], next[1] - prev[1]];
        const L = Math.hypot(d[0], d[1]);
        if (L > 0.01) {
          dir = [d[0] / L, d[1] / L];
          break;
        }
      }
    }
    if (!dir) {
      doorsNoWall++;
      continue;
    }
    const doorLevels = parseLevels(t(el, "level"));
    const levels =
      doorLevels.length > 0
        ? doorLevels
        : [...new Set(containing.flatMap((w) => parseLevels(w.tags?.level)))];
    const mid = toM([el.lon!, el.lat!]);
    const nx = -dir[1];
    const ny = dir[0];
    const levelOk = (sp: Space): boolean => {
      const ls = levelSetOf(sp);
      return levels.length === 0 || levels.some((l) => ls.includes(l));
    };
    const probe = (sign: 1 | -1): Space | null => {
      for (const off of PROBE_OFFSETS_M) {
        const pt: Pt = [mid[0] + sign * nx * off, mid[1] + sign * ny * off];
        let best: Space | null = null;
        for (const sp of spaces)
          if (levelOk(sp) && (best === null || sp.area < best.area) && pointInPolys(pt, sp.polysM))
            best = sp;
        if (best) return best;
      }
      return null;
    };
    const s1 = probe(1);
    const s2 = probe(-1);
    if (!s1 || !s2 || s1 === s2) continue;
    doorsTwoSided++;
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
    if (!placed) clusters.push({ a: sa, b: sb, levels, midsM: [mid] });
  }

  // ---- 5. graph nodes + edges -------------------------------------------------
  interface GNode {
    id: string;
    lat: number;
    lon: number;
    floor: number;
    site: string;
    gallery?: string;
    kind?: string;
    name?: string;
  }
  interface GEdge {
    a: string;
    b: string;
    len: number;
    kind: "walk" | "door" | "stairs" | "elevator";
    bearing?: number;
    room?: string;
  }
  const gnodes: GNode[] = [];
  const gedges: GEdge[] = [];

  // space nodes (rooms); vertical units emit one node per plan floor
  const walkable = (sp: Space): boolean => sp.kind !== "room" || sp.type !== "floor";
  for (const sp of spaces) {
    if (!walkable(sp)) continue;
    if (sp.kind === "room") {
      gnodes.push({
        id: sp.id,
        lat: sp.centroidLL[1],
        lon: sp.centroidLL[0],
        floor: sp.floorNum,
        site: SITE,
        ...(sp.gallery !== null ? { gallery: sp.gallery } : {}),
        ...(sp.name !== null && sp.gallery === null ? { name: sp.name } : {}),
      });
    } else {
      for (const [floor, id] of sp.unitFloors!) {
        gnodes.push({
          id,
          lat: sp.centroidLL[1],
          lon: sp.centroidLL[0],
          floor: Number(floor),
          site: SITE,
          kind: sp.kind,
          // a matched unit (e.g. Escalier Daru's Winged Victory landing)
          // carries its plan code on the node at the plan's own floor
          ...(sp.gallery !== null && floor === sp.planFloor ? { gallery: sp.gallery } : {}),
          ...(sp.name !== null && (sp.gallery === null || floor !== sp.planFloor)
            ? { name: sp.name }
            : {}),
        });
      }
    }
  }

  // vertical edges within each unit (consecutive plan floors)
  let vertEdges = 0;
  for (const sp of spaces) {
    if (sp.kind === "room" || !sp.unitFloors) continue;
    const floors = [...sp.unitFloors.keys()].sort((a, b) => Number(a) - Number(b));
    for (let i = 0; i + 1 < floors.length; i++) {
      const perLevel = sp.kind === "elevator" ? ELEVATOR_M_PER_LEVEL : STAIRS_M_PER_LEVEL;
      gedges.push({
        a: sp.unitFloors.get(floors[i])!,
        b: sp.unitFloors.get(floors[i + 1])!,
        len:
          Math.round(perLevel * Math.abs(Number(floors[i + 1]) - Number(floors[i])) * 10) / 10,
        kind: sp.kind === "elevator" ? "elevator" : "stairs",
      });
      vertEdges++;
    }
  }

  // door nodes + door edges + within-space walk edges
  const nodeIdFor = (sp: Space, doorLevels: number[]): string => {
    if (sp.kind === "room") return sp.id;
    // attach to the unit's node on the door's plan floor (fall back to first)
    for (const l of doorLevels) {
      const id = sp.unitFloors!.get(planFloorOf(l));
      if (id) return id;
    }
    return sp.unitFloors!.values().next().value!;
  };
  const doorNodes: GNode[] = [];
  const doorsOfSpace = new Map<string, { doorId: string; m: Pt }[]>();
  let doorSeq = 0;
  for (const clusters of doorways.values()) {
    for (const c of clusters) {
      const mx = c.midsM.reduce((s, p) => s + p[0], 0) / c.midsM.length;
      const my = c.midsM.reduce((s, p) => s + p[1], 0) / c.midsM.length;
      const doorLL: Pt = [round7(mx / MX), round7(my / MY)];
      const aId = nodeIdFor(c.a, c.levels);
      const bId = nodeIdFor(c.b, c.levels);
      const floorNum =
        c.levels.length > 0 ? Number(planFloorOf(c.levels[0])) : c.a.floorNum;
      const door: GNode = {
        id: `d${doorSeq++}`,
        lat: doorLL[1],
        lon: doorLL[0],
        floor: floorNum,
        site: SITE,
        kind: "door",
      };
      doorNodes.push(door);
      for (const [sp, spId] of [
        [c.a, aId],
        [c.b, bId],
      ] as Array<[Space, string]>) {
        const [lon, lat] = sp.centroidLL;
        const bearing =
          (Math.atan2((lon - doorLL[0]) * MX, (lat - doorLL[1]) * MY) / D2R + 360) % 360;
        gedges.push({
          a: door.id,
          b: spId,
          len: Math.round(haversine(doorLL[1], doorLL[0], lat, lon) * 10) / 10,
          kind: "door",
          bearing: Math.round(bearing),
        });
        let l = doorsOfSpace.get(spId);
        if (!l) doorsOfSpace.set(spId, (l = []));
        l.push({ doorId: door.id, m: [mx, my] });
      }
    }
  }
  let walkEdges = 0;
  for (const [spaceId, drs] of doorsOfSpace) {
    for (let i = 0; i < drs.length; i++)
      for (let j = i + 1; j < drs.length; j++) {
        gedges.push({
          a: drs[i].doorId,
          b: drs[j].doorId,
          len: Math.round(Math.hypot(drs[i].m[0] - drs[j].m[0], drs[i].m[1] - drs[j].m[1]) * 10) / 10,
          kind: "walk",
          room: spaceId,
        });
        walkEdges++;
      }
  }

  // every vertical-unit FLOOR node needs a same-floor room connection: door
  // probes cover most stairs, but OSM elevator shafts often carry no door
  // node at all — without this an elevator's upper landing dangles off its
  // shaft and avoid-stairs routing starves. Bridge each doorless unit floor
  // node to the nearest touching walkable room on that plan floor.
  let unitBridges = 0;
  for (const sp of spaces) {
    if (sp.kind === "room" || !sp.unitFloors) continue;
    for (const [floor, unitId] of sp.unitFloors) {
      if (doorsOfSpace.has(unitId)) continue;
      let best: { o: Space; gap: number } | null = null;
      for (const o of spaces) {
        if (o.kind !== "room" || !walkable(o) || o.planFloor !== floor) continue;
        const gap = polysGap(sp.polysM, o.polysM);
        if (gap <= REPAIR_GAP_M && (!best || gap < best.gap)) best = { o, gap };
      }
      if (best) {
        gedges.push({
          a: unitId,
          b: best.o.id,
          len:
            Math.round(
              Math.max(
                2,
                haversine(sp.centroidLL[1], sp.centroidLL[0], best.o.centroidLL[1], best.o.centroidLL[0]),
              ) * 10,
            ) / 10,
          kind: "walk",
        });
        unitBridges++;
      }
    }
  }

  // steps ways with level tags: direct stairs edges between the spaces
  // containing the way's endpoints on the two levels
  let stepsEdges = 0;
  for (const el of osm.elements) {
    if (el.type !== "way" || t(el, "highway") !== "steps") continue;
    const levels = parseLevels(t(el, "level"));
    if (levels.length < 2 || !el.nodes || el.nodes.length < 2) continue;
    const lo = levels[0];
    const hi = levels[levels.length - 1];
    const endA = nodesById.get(el.nodes[0]);
    const endB = nodesById.get(el.nodes[el.nodes.length - 1]);
    if (!endA?.lat || !endB?.lat) continue;
    const findSpace = (level: number): Space | null => {
      let best: Space | null = null;
      for (const p of [toM([endA.lon!, endA.lat!]), toM([endB.lon!, endB.lat!])]) {
        for (const sp of spaces) {
          if (!walkable(sp) || !levelSetOf(sp).includes(level)) continue;
          if ((best === null || sp.area < best.area) && pointInPolys(p, sp.polysM)) best = sp;
        }
        if (best) break;
      }
      return best;
    };
    const sLo = findSpace(lo);
    const sHi = findSpace(hi);
    if (!sLo || !sHi || sLo === sHi) continue;
    const aId = nodeIdFor(sLo, [lo]);
    const bId = nodeIdFor(sHi, [hi]);
    if (aId === bId) continue;
    const dFloors = Math.abs(Number(planFloorOf(hi)) - Number(planFloorOf(lo)));
    const horiz = haversine(sLo.centroidLL[1], sLo.centroidLL[0], sHi.centroidLL[1], sHi.centroidLL[0]);
    // grand staircases are mapped as several parallel flights — dedupe by pair
    if (gedges.some((e) => (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId))) continue;
    gedges.push({
      a: aId,
      b: bId,
      len: Math.round((horiz + STAIRS_M_PER_LEVEL * dFloors) * 10) / 10,
      kind: dFloors > 0 ? "stairs" : "walk",
    });
    stepsEdges++;
  }

  // ---- 6. connectivity repair (same-plan-floor touching boundaries) ----------
  const adj = new Map<string, { to: string; len: number }[]>();
  const addAdj = (e: GEdge) => {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ to: e.b, len: e.len });
    adj.get(e.b)!.push({ to: e.a, len: e.len });
  };
  for (const e of gedges) addAdj(e);
  const allIds = new Set(gnodes.map((n) => n.id).concat(doorNodes.map((n) => n.id)));
  const componentOf = (): Map<string, number> => {
    const comp = new Map<string, number>();
    let c = 0;
    for (const id of allIds) {
      if (comp.has(id)) continue;
      const stack = [id];
      comp.set(id, c);
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

  // space lookup for repair: room spaces by plan floor
  const roomsByFloor = new Map<string, Space[]>();
  for (const sp of spaces) {
    if (sp.kind !== "room" || !walkable(sp)) continue;
    let l = roomsByFloor.get(sp.planFloor);
    if (!l) roomsByFloor.set(sp.planFloor, (l = []));
    l.push(sp);
  }
  const spaceByNodeId = new Map<string, Space>();
  for (const sp of spaces) {
    if (sp.kind === "room") spaceByNodeId.set(sp.id, sp);
    else for (const id of sp.unitFloors!.values()) spaceByNodeId.set(id, sp);
  }
  // Repair runs to FIXPOINT (unlike the Met's 3 passes): OSM's floor-2
  // paintings wings are door-sparse enfilades, so the connected region must be
  // allowed to grow room-by-touching-room until stable. The rule stays
  // conservative — a stray room only ever bridges to an ALREADY-main-connected
  // neighbor within REPAIR_GAP_M; stray blocks never merge with each other.
  let repaired = 0;
  for (let pass = 0; pass < 200; pass++) {
    const comp = componentOf();
    const sizeOf = new Map<number, number>();
    for (const c of comp.values()) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    let main = -1;
    for (const [c, n] of sizeOf) if (main === -1 || n > sizeOf.get(main)!) main = c;
    let added = 0;
    for (const sp of spaces) {
      if (sp.kind !== "room" || !walkable(sp)) continue;
      if (comp.get(sp.id) === main) continue;
      let best: { sp: Space; gap: number } | null = null;
      for (const o of roomsByFloor.get(sp.planFloor) ?? []) {
        if (comp.get(o.id) !== main) continue;
        const gap = polysGap(sp.polysM, o.polysM);
        if (gap <= REPAIR_GAP_M && (!best || gap < best.gap)) best = { sp: o, gap };
      }
      if (best) {
        const e: GEdge = {
          a: sp.id,
          b: best.sp.id,
          len:
            Math.round(
              haversine(sp.centroidLL[1], sp.centroidLL[0], best.sp.centroidLL[1], best.sp.centroidLL[0]) * 10,
            ) / 10,
          kind: "walk",
        };
        gedges.push(e);
        addAdj(e);
        added++;
        repaired++;
      }
    }
    if (added === 0) break;
  }

  // ---- 7. drop zero-gallery stray components (routing dead weight) -----------
  {
    const comp = componentOf();
    const galleriesInComp = new Map<number, number>();
    const sizeOf = new Map<number, number>();
    for (const n of gnodes) {
      const c = comp.get(n.id)!;
      sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
      if (n.gallery) galleriesInComp.set(c, (galleriesInComp.get(c) ?? 0) + 1);
    }
    let main = -1;
    for (const [c, n] of sizeOf) if (main === -1 || n > sizeOf.get(main)!) main = c;
    const keepComp = new Set<number>([main]);
    for (const [c, g] of galleriesInComp) if (g > 0) keepComp.add(c);
    const gone = new Set<string>();
    for (const n of gnodes) if (!keepComp.has(comp.get(n.id)!)) gone.add(n.id);
    if (gone.size > 0) {
      for (let i = gnodes.length - 1; i >= 0; i--) if (gone.has(gnodes[i].id)) gnodes.splice(i, 1);
      for (let i = gedges.length - 1; i >= 0; i--)
        if (gone.has(gedges[i].a) || gone.has(gedges[i].b)) gedges.splice(i, 1);
      const liveDoors = new Set<string>();
      for (const e of gedges) {
        if (e.a.startsWith("d")) liveDoors.add(e.a);
        if (e.b.startsWith("d")) liveDoors.add(e.b);
      }
      for (let i = doorNodes.length - 1; i >= 0; i--)
        if (!liveDoors.has(doorNodes[i].id)) doorNodes.splice(i, 1);
      console.log(`dropped ${gone.size} nodes in zero-gallery stray components`);
    }
  }

  // ---- 8. emit snapshots -------------------------------------------------------
  // galleries.geojson: one feature per matched code (MultiPolygon merge) +
  // unmatched walkable rooms/corridors/areas as backdrop. Vertical units are
  // included only when they carry a plan code (display rooms like the Escalier
  // Daru landing); plain shafts stay graph-only, like the Met's.
  const galleryFeatures: object[] = [];
  const emitted = new Set<string>();
  for (const sp of spaces) {
    if (!walkable(sp)) continue;
    if (sp.kind !== "room" && sp.gallery === null) continue;
    let polys = sp.polysLL;
    let name = sp.name;
    if (sp.gallery !== null) {
      if (emitted.has(sp.gallery)) continue;
      emitted.add(sp.gallery);
      const siblings = codeAssign.get(sp.gallery)!;
      polys = siblings.flatMap((s) => s.polysLL);
      name = siblings.map((s) => s.name).find((n) => n !== null) ?? null;
    }
    galleryFeatures.push({
      type: "Feature",
      geometry:
        polys.length === 1
          ? { type: "Polygon", coordinates: polys[0] }
          : { type: "MultiPolygon", coordinates: polys },
      properties: {
        osmId: sp.osmId,
        galleryNumber: sp.gallery,
        name,
        title: sp.planTitle ?? name,
        type: sp.kind !== "room" ? "stairs" : sp.type,
        // STRING floor labels: the plan's niveau vocabulary (see header)
        floor: sp.planFloor,
        floorName: sp.planFloor,
        site: SITE,
        closed: false,
      },
    });
  }

  // amenities.geojson
  const amenityFeatures: object[] = [];
  const pushAmenity = (kind: string, name: string | null, lon: number, lat: number, floor: string) =>
    amenityFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [round7(lon), round7(lat)] },
      properties: {
        kind,
        name,
        floor,
        floorName: floor,
        lat: round7(lat),
        lon: round7(lon),
        site: SITE,
        closed: false,
      },
    });
  for (const sp of spaces) {
    const amenity = sp.tags.amenity ?? "";
    const amenityKind =
      sp.roomTag === "toilets" || amenity === "toilets" ? "restroom"
      : sp.roomTag === "restaurant" || ["cafe", "restaurant", "fast_food"].includes(amenity) ? "dining"
      : sp.roomTag === "shop" || sp.tags.shop ? "shop"
      : amenity === "reception_desk" ? "information"
      : null;
    if (amenityKind) pushAmenity(amenityKind, sp.name, sp.centroidLL[0], sp.centroidLL[1], sp.planFloor);
    if (sp.kind === "elevator")
      for (const floor of sp.unitFloors!.keys())
        pushAmenity("elevator", sp.name, sp.centroidLL[0], sp.centroidLL[1], floor);
  }
  for (const el of osm.elements) {
    if (el.type !== "node" || t(el, "entrance") !== "main") continue;
    const lv = parseLevels(t(el, "level"));
    pushAmenity(
      "entrance",
      t(el, "name") ?? null,
      el.lon!,
      el.lat!,
      lv.length ? planFloorOf(lv[0]) : "0",
    );
  }

  const nodes = [...gnodes, ...doorNodes];
  fs.mkdirSync(SNAP, { recursive: true });
  const write = (name: string, data: object) => {
    const file = path.join(SNAP, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    console.log(`wrote ${file}`);
  };
  write("galleries.geojson", { type: "FeatureCollection", features: galleryFeatures });
  write("amenities.geojson", { type: "FeatureCollection", features: amenityFeatures });
  write("graph.json", { nodes, edges: gedges });

  // ---- 9. report + meta ---------------------------------------------------------
  const matchedCodes = [...codeAssign.keys()];
  const realSalles = [...plan.values()].filter((s) => /^\d+(bis)?$/.test(s.galleryNumber) && Number(s.galleryNumber.replace("bis", "")) < 1000);
  const matchedReal = matchedCodes.filter((c) => realSalles.some((s) => s.galleryNumber === c));
  const arksTotal = [...plan.values()].reduce((s, p) => s + p.arks.size, 0);
  const arksMatched = matchedCodes.reduce((s, c) => s + plan.get(c)!.arks.size, 0);
  const perFloor: Record<string, { plan: number; matched: number }> = {};
  for (const s of plan.values()) {
    const e = (perFloor[s.floor] ??= { plan: 0, matched: 0 });
    e.plan++;
    if (codeAssign.has(s.galleryNumber)) e.matched++;
  }
  const viaCounts = { code: 0, name: 0 };
  for (const sps of codeAssign.values()) for (const sp of sps) viaCounts[sp.matchVia!]++;
  const meta = {
    generatedBy: "data/src/geometry-osm.ts",
    source: "OpenStreetMap via Overpass (2026-07-05 extract, committed raw)",
    license: "ODbL — © OpenStreetMap contributors",
    salleMatch: {
      planCodes: plan.size,
      planRealSalles: realSalles.length,
      matchedCodes: matchedCodes.length,
      matchedRealSalles: matchedReal.length,
      matchedOsmSpaces: [...codeAssign.values()].reduce((s, l) => s + l.length, 0),
      via: viaCounts,
      nameAmbiguousDropped: nameAmbiguous,
      floorRejected: floorRejected.length,
      arksTotal,
      arksMatched,
      perFloor,
    },
    osm: {
      spaces: spaces.length,
      walkableRooms: spaces.filter((s) => s.kind === "room").length,
      stairsUnits: spaces.filter((s) => s.kind === "stairs").length,
      elevatorUnits: spaces.filter((s) => s.kind === "elevator").length,
      doorsProbed,
      doorsTwoSided,
      doorsNoWall,
    },
    graph: {
      nodes: nodes.length,
      doorNodes: doorNodes.length,
      edges: gedges.length,
      walkEdges,
      vertEdges,
      stepsEdges,
      unitBridges,
      repairEdges: repaired,
    },
  };
  fs.writeFileSync(path.join(SNAP, "geometry-meta.json"), JSON.stringify(meta, null, 2) + "\n");

  console.log(
    `\nsalle match: ${matchedCodes.length}/${plan.size} plan codes ` +
      `(${matchedReal.length}/${realSalles.length} numbered salles; ` +
      `${((100 * arksMatched) / arksTotal).toFixed(1)}% of ${arksTotal} on-view arks) ` +
      `via ${viaCounts.code} code + ${viaCounts.name} name matches; ` +
      `${nameAmbiguous} ambiguous name matches dropped; ${floorRejected.length} floor-rejected`,
  );
  console.log(`per floor:`, perFloor);
  console.log(
    `doors: ${doorsTwoSided}/${doorsProbed} two-sided (${doorsNoWall} without a wall way); ` +
      `graph: ${nodes.length} nodes / ${gedges.length} edges ` +
      `(${walkEdges} walk, ${vertEdges} vertical, ${stepsEdges} steps, ${repaired} repair)`,
  );
  if (floorRejected.length)
    console.log(`floor-rejected code matches:\n  ` + floorRejected.slice(0, 20).join("\n  "));

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`SANITY FAIL: ${msg}`);
    console.log(`  OK: ${msg}`);
  };
  assert(matchedCodes.length >= 150, `>=150 salle codes matched (got ${matchedCodes.length})`);
  assert(doorsTwoSided >= 400, `>=400 two-sided doors (got ${doorsTwoSided})`);
  const joconde = galleryFeatures.find((f: any) => f.properties.galleryNumber === "711");
  assert(!!joconde, "salle 711 (Joconde) has a polygon");
  const venus = galleryFeatures.find((f: any) => f.properties.galleryNumber === "345");
  assert(!!venus, "salle 345 (Venus de Milo) has a polygon");
}

main();
