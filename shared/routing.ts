/**
 * Routing engine for MuseWalk: Dijkstra over the met.sqlite walking
 * graph plus room-grouped instruction templating. Platform-neutral pure
 * functions — callers pass plain `graph_nodes` / `graph_edges` / `galleries`
 * rows (from expo-sqlite on the client, better-sqlite3 on the server/tests).
 *
 * Graph semantics (see data/src/graph.ts, the pipeline that emits the rows):
 *   - space nodes `r…fN` (rooms; `gallery` set for galleries, `name` for
 *     amenities) and `u…fN` (circulation units: stairs/elevator/escalator),
 *     each at the space centroid;
 *   - doorway nodes `d…` sit on the wall crossing; each has two kind='door'
 *     edges to the centroids of the two spaces it joins, carrying the compass
 *     `bearing` door→space — reversed, that is the "exit through the {dir}
 *     door" direction;
 *   - kind='walk' edges link the doorways of one room pairwise (tagged
 *     `room` = the space node id) so paths measure door-to-door walking;
 *   - kind='stairs'|'elevator' edges link the u-nodes of one vertical shaft
 *     across consecutive floors (effort-equivalent lengths).
 *
 * avoidStairs simply removes stairs edges from the search — elevators remain,
 * and the graph eval (data/evals/reports/graph.md) shows every gallery pair
 * stays routable through elevator shafts.
 */

export interface GraphNode {
  id: string;
  lat: number;
  lon: number;
  /** Numeric graph floor: 0 = ground, 1.5 = mezzanine 1M, … */
  floor: number;
  site: string;
  gallery: string | null;
  kind: string | null;
  name: string | null;
}

export interface GraphEdge {
  a: string;
  b: string;
  /** Haversine meters (effort-equivalent for vertical edges). */
  len: number;
  kind: "walk" | "door" | "stairs" | "elevator";
  /** Compass bearing door→space, set on door edges only. */
  bearing: number | null;
  /** Space node id this walk edge crosses, set on walk edges only. */
  room: string | null;
}

export interface GalleryRow {
  galleryNumber: string;
  title: string | null;
  floor: string;
  site: string;
}

export interface RouteOptions {
  avoidStairs?: boolean;
}

export interface RouteStep {
  kind: "start" | "walk" | "stairs" | "elevator" | "arrive";
  instruction: string;
  /** Space node the step stands in (vertical steps: the arrival landing). */
  nodeId: string;
  gallery: string | null;
  /** Display name, e.g. "Gallery 822", "the corridor", "Restroom". */
  name: string;
  floor: number;
  floorLabel: string;
  lat: number;
  lon: number;
}

export interface RouteResult {
  steps: RouteStep[];
  distanceM: number;
  /** Every graph node along the path, for the map polyline. */
  path: Array<{ id: string; lat: number; lon: number; floor: number }>;
  /** Edges traversed, in order (J10 asserts no 'stairs' under avoidStairs). */
  edges: GraphEdge[];
}

export interface RouteGraph {
  nodeById: Map<string, GraphNode>;
  adjacency: Map<string, Array<{ to: string; edge: GraphEdge }>>;
  /** `${doorNodeId}|${spaceNodeId}` → compass bearing door→space. */
  doorBearing: Map<string, number>;
  /** `${gallery}|${site}` → gallery title. */
  galleryTitle: Map<string, string>;
  /** gallery number → space node ids (normally one per gallery). */
  byGallery: Map<string, string[]>;
}

export function buildRouteGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  galleries: GalleryRow[],
): RouteGraph {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Array<{ to: string; edge: GraphEdge }>>();
  const doorBearing = new Map<string, number>();
  const push = (from: string, to: string, edge: GraphEdge) => {
    let list = adjacency.get(from);
    if (!list) adjacency.set(from, (list = []));
    list.push({ to, edge });
  };
  for (const e of edges) {
    push(e.a, e.b, e);
    push(e.b, e.a, e);
    if (e.kind === "door" && e.bearing !== null) doorBearing.set(`${e.a}|${e.b}`, e.bearing);
  }
  const galleryTitle = new Map<string, string>();
  for (const g of galleries) if (g.title) galleryTitle.set(`${g.galleryNumber}|${g.site}`, g.title);
  const byGallery = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.gallery) continue;
    // Two keys per node: the site-scoped "{site}|{gallery}" (exact — room
    // codes collide across museums once two of them have graphs) and the
    // legacy bare code (kept for existing callers/tests; benign even when
    // ambiguous — museums are disconnected components, so multi-source
    // Dijkstra only ever completes within the endpoint's own building).
    for (const key of [`${n.site}|${n.gallery}`, n.gallery]) {
      let list = byGallery.get(key);
      if (!list) byGallery.set(key, (list = []));
      list.push(n.id);
    }
  }
  return { nodeById, adjacency, doorBearing, galleryTitle, byGallery };
}

/** A route endpoint: a gallery number ("822") or a graph node id ("r2591f0"). */
function endpointNodes(g: RouteGraph, ref: string): string[] {
  const byGallery = g.byGallery.get(ref);
  if (byGallery && byGallery.length > 0) return byGallery;
  return g.nodeById.has(ref) ? [ref] : [];
}

// ---------------------------------------------------------------------------
// Dijkstra (binary heap; multi-source → first target popped wins).

interface PathHop {
  id: string;
  /** Edge used to reach this node; undefined for the source. */
  via?: GraphEdge;
}

function dijkstra(
  g: RouteGraph,
  sources: string[],
  targets: string[],
  avoidStairs: boolean,
): { path: PathHop[]; dist: number } | null {
  const targetSet = new Set(targets);
  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; edge: GraphEdge }>();
  const heap: Array<[number, string]> = [];
  const heapPush = (d: number, id: string) => {
    heap.push([d, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): [number, string] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    dist.set(s, 0);
    heapPush(0, s);
  }
  while (heap.length > 0) {
    const [d, id] = heapPop();
    if (d > (dist.get(id) ?? Infinity)) continue; // stale heap entry
    if (targetSet.has(id)) {
      const path: PathHop[] = [];
      let cur: string | undefined = id;
      while (cur !== undefined) {
        const p = prev.get(cur);
        path.unshift({ id: cur, via: p?.edge });
        cur = p?.from;
      }
      return { path, dist: d };
    }
    for (const { to, edge } of g.adjacency.get(id) ?? []) {
      if (avoidStairs && edge.kind === "stairs") continue;
      const nd = d + edge.len;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, { from: id, edge });
        heapPush(nd, to);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instruction templating.

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

function compassOf(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export function floorLabelOf(floor: number): string {
  if (floor === 0) return "G";
  if (floor === 1.5) return "1M";
  return String(floor);
}

/** Display name for a space node: "Gallery 822", amenity name, or corridor. */
function spaceName(n: GraphNode): string {
  if (n.gallery) return /^\d/.test(n.gallery) ? `Gallery ${n.gallery}` : n.gallery;
  if (n.kind === "stairs" || n.kind === "steps") return "the stairs";
  if (n.kind === "elevator") return "the elevator";
  if (n.kind === "escalator") return "the escalator";
  if (n.name) return n.name;
  return "the corridor";
}

/** "The Vélez Blanco Patio: Spanish…, 1450-1700" → "The Vélez Blanco Patio". */
function shortTitle(title: string | undefined): string | null {
  if (!title) return null;
  const s = title.split(":")[0].replace(/,\s*\d.*$/, "").trim();
  return s.length > 0 ? s : null;
}

/** Name plus the gallery's short title in parens, when one exists. */
function nameWithTitle(g: RouteGraph, n: GraphNode): string {
  const name = spaceName(n);
  if (!n.gallery) return name;
  const t = shortTitle(g.galleryTitle.get(`${n.gallery}|${n.site}`));
  return t ? `${name} (${t})` : name;
}

interface SpaceVisit {
  node: GraphNode;
  /** Compass bearing of the entry door as seen from the exited space. */
  enterBearing?: number;
  /** Set when this space was reached by a vertical edge. */
  vertical?: "stairs" | "elevator";
}

/**
 * Collapse the node path into the visited-space sequence. Walk edges name the
 * room they cross; door edges land on space centroids (route endpoints and
 * vertical-shaft entries); vertical edges hop u-nodes across floors.
 * Consecutive spaces with the same display name (chained unnamed corridors)
 * merge into one visit. The entry bearing is resolved against the space
 * actually being exited (which may differ from the merged visit's node).
 */
function spaceSequence(g: RouteGraph, path: PathHop[]): SpaceVisit[] {
  const visits: SpaceVisit[] = [];
  // The space node the path is currently inside — tracked across merges so
  // door-bearing lookups always use the real exited-space id.
  let currentSpace = path[0].id;
  const enterSpace = (id: string, doorId?: string, vertical?: "stairs" | "elevator") => {
    if (id === currentSpace) return;
    const node = g.nodeById.get(id);
    if (!node) return;
    // The door edge bearing points door→space; the door as seen from inside
    // the exited space lies in the opposite direction.
    const raw = doorId !== undefined ? g.doorBearing.get(`${doorId}|${currentSpace}`) : undefined;
    const enterBearing = raw !== undefined ? (raw + 180) % 360 : undefined;
    currentSpace = id;
    const last = visits[visits.length - 1];
    if (last && !vertical && !last.vertical && spaceName(last.node) === spaceName(node)) return;
    visits.push({ node, enterBearing, vertical });
  };
  const first = g.nodeById.get(path[0].id);
  if (first) visits.push({ node: first });
  for (let i = 1; i < path.length; i++) {
    const { id, via } = path[i];
    if (!via) continue;
    if (via.kind === "walk") {
      if (via.room) enterSpace(via.room, path[i - 1].id);
    } else if (via.kind === "door") {
      // door↔space: only the space end is a visit (doorways are not rooms).
      const n = g.nodeById.get(id);
      if (n && n.kind !== "door") enterSpace(id, path[i - 1].id);
    } else {
      enterSpace(id, undefined, via.kind);
    }
  }
  return visits;
}

function makeStep(
  g: RouteGraph,
  kind: RouteStep["kind"],
  instruction: string,
  node: GraphNode,
): RouteStep {
  return {
    kind,
    instruction,
    nodeId: node.id,
    gallery: node.gallery,
    name: spaceName(node),
    floor: node.floor,
    floorLabel: floorLabelOf(node.floor),
    lat: node.lat,
    lon: node.lon,
  };
}

function buildSteps(g: RouteGraph, visits: SpaceVisit[]): RouteStep[] {
  const start = visits[0].node;
  if (visits.length === 1) {
    return [makeStep(g, "arrive", `You're already in ${nameWithTitle(g, start)}`, start)];
  }
  const steps: RouteStep[] = [
    makeStep(
      g,
      "start",
      `Start in ${nameWithTitle(g, start)} — Floor ${floorLabelOf(start.floor)}`,
      start,
    ),
  ];
  for (let i = 1; i < visits.length; i++) {
    const v = visits[i];
    if (v.vertical) {
      // Collapse a multi-floor shaft ride into one step ending at the landing.
      let j = i;
      while (j + 1 < visits.length && visits[j + 1].vertical === v.vertical) j++;
      const landing = visits[j].node;
      const verb = v.vertical === "elevator" ? "elevator" : "stairs";
      steps.push(
        makeStep(g, v.vertical, `Take the ${verb} to Floor ${floorLabelOf(landing.floor)}`, landing),
      );
      i = j;
      continue;
    }
    const prev = visits[i - 1].node;
    const dir = v.enterBearing !== undefined ? `${compassOf(v.enterBearing)} ` : "";
    const last = i === visits.length - 1;
    steps.push(
      makeStep(
        g,
        last ? "arrive" : "walk",
        last
          ? `Exit ${spaceName(prev)} through the ${dir}door — you've arrived at ${nameWithTitle(g, v.node)}`
          : `Exit ${spaceName(prev)} through the ${dir}door into ${nameWithTitle(g, v.node)}`,
        v.node,
      ),
    );
  }
  // Vertical arrival (destination is the landing itself, e.g. an elevator).
  if (steps[steps.length - 1].kind !== "arrive") {
    const final = visits[visits.length - 1].node;
    steps.push(makeStep(g, "arrive", `You've arrived at ${nameWithTitle(g, final)}`, final));
  }
  return steps;
}

/**
 * Shortest route between two endpoints (gallery numbers or node ids), with
 * room-grouped turn-by-turn instructions. Returns null when either endpoint
 * is unknown or unreachable (e.g. cross-site, or avoidStairs cuts the only
 * connection).
 */
export function route(
  g: RouteGraph,
  from: string,
  to: string,
  opts: RouteOptions = {},
): RouteResult | null {
  const sources = endpointNodes(g, from);
  const targets = endpointNodes(g, to);
  if (sources.length === 0 || targets.length === 0) return null;
  const found = dijkstra(g, sources, targets, opts.avoidStairs === true);
  if (!found) return null;
  const visits = spaceSequence(g, found.path);
  return {
    steps: buildSteps(g, visits),
    distanceM: found.dist,
    path: found.path.map(({ id }) => {
      const n = g.nodeById.get(id)!;
      return { id, lat: n.lat, lon: n.lon, floor: n.floor };
    }),
    edges: found.path.slice(1).map((h) => h.via!),
  };
}
