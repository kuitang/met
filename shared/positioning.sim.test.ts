/**
 * Positioning-fusion scenario simulator (user-mandated test program).
 *
 * The gate-confirmed fusion semantics are validated by EXECUTING timelines —
 * setAnchor at t=0, walk N rooms over M minutes via synthetic GPS fixes with
 * realistic 40–100 m noise sampled around REAL gallery centroids from the
 * committed met.sqlite graph fixture, locator reopens, manual overrides —
 * through the real state machine (shared/positioning.ts), with the clock
 * mocked as explicit `at` timestamps (the machine is pure; time only enters
 * through inputs).
 *
 * Semantic matrix asserted below:
 *   1. fresh-GPS-supersedes-stale-manual (freshness beats precision)
 *   2. superseded anchor's floor retained as assumedFloor, "(assumed)" label
 *   3. decay flips room→wing exactly at ROOM_ANCHOR_DECAY_MS
 *   4. GPS NEVER produces a room claim at any noise level (500-fix property loop)
 *   5. fresh manual beats everything
 *   6. off-route fires exactly once per deviation (on the real 131→822 route)
 *
 * The run prints a scenario trace table so it doubles as documentation:
 *   npx vitest run --root shared positioning.sim
 */
import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GPS_MAX_CONFIDENCE,
  ROOM_ANCHOR_DECAY_MS,
  anchorLevel,
  applyInput,
  effectiveConfidence,
  initialRouteProgress,
  onRouteAnchor,
  resolveGpsArea,
  type Anchor,
  type GpsFix,
  type PositionInput,
  type RouteSignal,
} from "./positioning.ts";
import {
  buildRouteGraph,
  route,
  type GalleryRow,
  type GraphEdge,
  type GraphNode,
} from "./routing.ts";

/* ---------------------------------------------------------------------- */
/* Real geometry: gallery centroids out of the committed graph fixture.    */

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(fileURLToPath(new URL("./fixtures/met-graph.json.gz", import.meta.url))),
  ).toString("utf8"),
) as { nodes: GraphNode[]; edges: GraphEdge[]; galleries: GalleryRow[] };

const ENTRANCE = { lat: 40.7794, lon: -73.9632 }; // Fifth Ave / Great Hall

const D2R = Math.PI / 180;
function metersFromEntrance(lat: number, lon: number): number {
  const kx = 111_320 * Math.cos(ENTRANCE.lat * D2R);
  return Math.hypot((lat - ENTRANCE.lat) * 110_540, (lon - ENTRANCE.lon) * kx);
}

/** Space nodes (gallery centroids) — the real coordinates fixes sample around. */
const galleryNodes = fixture.nodes.filter((n) => n.gallery !== null && n.kind === null);

/** A deterministic walk: fifth-Ave floor-1 galleries within GPS range of the
 *  entrance, nearest-first — “the user wanders a wing for a few minutes”. */
const walkPath = galleryNodes
  .filter(
    (n) => n.site === "fifthAve" && n.floor === 1 && metersFromEntrance(n.lat, n.lon) < 150,
  )
  .sort(
    (a, b) => metersFromEntrance(a.lat, a.lon) - metersFromEntrance(b.lat, b.lon),
  )
  .slice(0, 8);

/* ---------------------------------------------------------------------- */
/* Deterministic noise (mulberry32) → reproducible "GPS" fixes.            */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fix `noiseM` meters from a true position, in a random direction. */
function noisyFix(
  trueLat: number,
  trueLon: number,
  noiseM: number,
  accuracyM: number,
  rng: () => number,
): GpsFix {
  const theta = rng() * 2 * Math.PI;
  const dNorth = Math.cos(theta) * noiseM;
  const dEast = Math.sin(theta) * noiseM;
  return {
    lat: trueLat + dNorth / 110_540,
    lon: trueLon + dEast / (111_320 * Math.cos(trueLat * D2R)),
    accuracyM,
  };
}

/* ---------------------------------------------------------------------- */
/* The simulator: a timeline of events folded through the real machine.    */

interface SimEvent {
  /** Mocked clock, ms since scenario start. */
  t: number;
  what: string;
  input: PositionInput;
}

interface TraceRow {
  t: string;
  event: string;
  anchor: string;
  level: string;
  conf: string;
}

function mmss(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2)}:${String(s % 60).padStart(2, "0")}`;
}

function describeAnchor(a: Anchor | undefined, now: number): Pick<TraceRow, "anchor" | "level" | "conf"> {
  if (!a) return { anchor: "(none)", level: "-", conf: "-" };
  return {
    anchor: a.kind === "room" ? `Gallery ${a.gallery} (fl ${a.floor}, ${a.source})` : a.label,
    level: anchorLevel(a, now),
    conf: effectiveConfidence(a, now).toFixed(2),
  };
}

function runScenario(events: SimEvent[]): { anchors: (Anchor | undefined)[]; trace: TraceRow[] } {
  const anchors: (Anchor | undefined)[] = [];
  const trace: TraceRow[] = [];
  let current: Anchor | undefined;
  for (const e of events) {
    current = applyInput(current, e.input);
    anchors.push(current);
    trace.push({ t: mmss(e.t), event: e.what, ...describeAnchor(current, e.t) });
  }
  return { anchors, trace };
}

function printTrace(title: string, trace: TraceRow[]): void {
  const cols: (keyof TraceRow)[] = ["t", "event", "anchor", "level", "conf"];
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...trace.map((r) => r[c].length))]),
  ) as Record<keyof TraceRow, number>;
  const line = (r: Record<keyof TraceRow, string>) =>
    cols.map((c) => r[c].padEnd(width[c])).join("  ");
  console.log(`\n${title}`);
  console.log(line({ t: "t", event: "event", anchor: "anchor", level: "level", conf: "conf" }));
  console.log(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of trace) console.log(line(r));
}

/* ---------------------------------------------------------------------- */

describe("scenario: manual anchor → 6-minute walk on real centroids → locator reopen → override", () => {
  expect(walkPath.length).toBeGreaterThanOrEqual(5); // enough real rooms to walk

  const rng = mulberry32(0x5eed);
  const MIN = 60_000;
  const gpsAt = (t: number, node: GraphNode, note: string): SimEvent => ({
    t,
    what: note,
    input: {
      type: "gps",
      // Realistic indoor browser-GPS error: 40–100 m around the true room.
      fix: noisyFix(node.lat, node.lon, 40 + rng() * 60, 40 + rng() * 60, rng),
      at: t,
    },
  });

  const start = walkPath[0]; // a real floor-1 gallery near the Great Hall
  const events: SimEvent[] = [
    {
      t: 0,
      what: `manual room entry: Gallery ${start.gallery}`,
      input: {
        type: "room",
        source: "manual",
        gallery: start.gallery!,
        floor: "1",
        site: "fifthAve",
        at: 0,
      },
    },
    gpsAt(1 * MIN, walkPath[1], `walk → near Gallery ${walkPath[1].gallery} (fresh anchor: fix ignored)`),
    gpsAt(2 * MIN, walkPath[2], `walk → near Gallery ${walkPath[2].gallery} (fresh anchor: fix ignored)`),
    gpsAt(3.5 * MIN, walkPath[3], `walk → near Gallery ${walkPath[3].gallery} (fresh anchor: fix ignored)`),
    gpsAt(4.5 * MIN, walkPath[4], "locator reopened → GPS re-resolves (anchor now STALE)"),
    gpsAt(5 * MIN, walkPath[5 % walkPath.length], "GPS refresh (assumed floor carries forward)"),
    {
      t: 5.5 * MIN,
      what: "manual override: Gallery 822 floor 2",
      input: {
        type: "room",
        source: "manual",
        gallery: "822",
        floor: "2",
        site: "fifthAve",
        at: 5.5 * MIN,
      },
    },
    gpsAt(5.7 * MIN, walkPath[1], "GPS lands right after (fresh manual beats everything)"),
    gpsAt(10 * MIN, walkPath[2], "10:00 — override stale → GPS supersedes, floor 2 assumed"),
  ];

  const { anchors, trace } = runScenario(events);
  printTrace("Fusion scenario trace (real Met centroids, mocked clock)", trace);

  it("setAnchor at t=0 yields a confidence-1.0 room anchor", () => {
    expect(anchors[0]).toMatchObject({ kind: "room", gallery: start.gallery, confidence: 1 });
  });

  it("GPS fixes inside the freshness window never move the manual anchor", () => {
    expect(anchors[1]).toBe(anchors[0]); // same reference: ignored
    expect(anchors[2]).toBe(anchors[0]);
    expect(anchors[3]).toBe(anchors[0]);
  });

  it("locator reopen after decay: fresh GPS supersedes the stale manual anchor", () => {
    const a = anchors[4]!;
    expect(a.kind).toBe("area");
    expect(a.source).toBe("gps");
  });

  it("the superseded anchor's floor is retained as assumed, and survives refreshes", () => {
    for (const a of [anchors[4]!, anchors[5]!]) {
      expect(a.kind).toBe("area");
      if (a.kind === "area") {
        expect(a.assumedFloor).toBe("1");
        expect(a.label).toContain("(assumed)");
      }
    }
  });

  it("a fresh manual override beats the GPS area anchor — and the next quick fix", () => {
    expect(anchors[6]).toMatchObject({ kind: "room", gallery: "822", floor: "2" });
    expect(anchors[7]).toBe(anchors[6]); // GPS 12 s later: ignored
  });

  it("after the override goes stale, GPS supersedes again and assumes floor 2", () => {
    const a = anchors[8]!;
    expect(a.kind).toBe("area");
    if (a.kind === "area") expect(a.assumedFloor).toBe("2");
  });
});

describe("decay flips room→wing exactly at ROOM_ANCHOR_DECAY_MS (mocked clock sweep)", () => {
  const anchor = applyInput(undefined, {
    type: "room",
    source: "artifact",
    gallery: "131",
    floor: "1",
    site: "fifthAve",
    at: 0,
  })!;

  it("level and confidence hold room-grade until the constant, wing-grade after", () => {
    for (const t of [0, 1000, ROOM_ANCHOR_DECAY_MS - 1]) {
      expect(anchorLevel(anchor, t)).toBe("room");
      expect(effectiveConfidence(anchor, t)).toBe(1);
    }
    for (const t of [ROOM_ANCHOR_DECAY_MS, ROOM_ANCHOR_DECAY_MS + 1, 60 * 60_000]) {
      expect(anchorLevel(anchor, t)).toBe("wing");
      expect(effectiveConfidence(anchor, t)).toBeLessThanOrEqual(GPS_MAX_CONFIDENCE);
    }
  });
});

describe("property: GPS NEVER yields a room claim — 500 random fixes over real centroids", () => {
  it("every resolvable fix is an area anchor with no gallery, capped at GPS confidence", () => {
    const rng = mulberry32(0xa11ce);
    let resolved = 0;
    for (let i = 0; i < 500; i++) {
      const node = galleryNodes[Math.floor(rng() * galleryNodes.length)];
      const noiseM = rng() * 200; // 0–200 m: beyond even the worst measured noise
      const accuracyM = 5 + rng() * 295;
      const fix = noisyFix(node.lat, node.lon, noiseM, accuracyM, rng);

      const direct = resolveGpsArea(fix, i);
      const fused = applyInput(undefined, { type: "gps", fix, at: i });
      for (const a of [direct, fused]) {
        if (!a) continue; // rejected outright (outlier/accuracy) — also never a room
        expect(a.kind).toBe("area");
        expect("gallery" in a).toBe(false);
        expect(a.confidence).toBeLessThanOrEqual(GPS_MAX_CONFIDENCE);
        if (a === direct) resolved++;
      }
    }
    expect(resolved).toBeGreaterThan(100); // the loop actually exercised resolutions
  });
});

describe("off-route fires exactly once per deviation — real 131→822 route galleries", () => {
  const graph = buildRouteGraph(fixture.nodes, fixture.edges, fixture.galleries);
  const r = route(graph, "131", "822")!;
  const routeGalleries = r.steps.map((s) => s.gallery);
  const offRouteGallery = fixture.galleries.find(
    (g) => g.site === "fifthAve" && !routeGalleries.includes(g.galleryNumber),
  )!.galleryNumber;

  it("two deviations on the real route → exactly two reroute signals", () => {
    const roomAt = (gallery: string, at: number): Anchor => ({
      kind: "room",
      gallery,
      floor: "1",
      site: "fifthAve",
      source: "manual",
      confidence: 1,
      timestamp: at,
    });
    const onRouteAhead = routeGalleries.find((g, i) => g !== null && i > 0)!;

    let progress = initialRouteProgress(undefined);
    const signals: RouteSignal["type"][] = [];
    const feed = (gallery: string, at: number) => {
      const res = onRouteAnchor(progress, roomAt(gallery, at), routeGalleries);
      progress = res.progress;
      signals.push(res.signal.type);
    };

    feed(offRouteGallery, 1_000); //   deviation 1 → reroute
    feed(offRouteGallery, 2_000); //   same room re-reported → deduped
    feed(offRouteGallery, 3_000); //   still deduped
    feed(onRouteAhead, 4_000); //      back on route → advance (re-arms detector)
    feed(offRouteGallery, 5_000); //   deviation 2 → reroute
    feed(offRouteGallery, 6_000); //   deduped again

    expect(signals).toEqual(["reroute", "none", "none", "advance", "reroute", "none"]);
    expect(signals.filter((s) => s === "reroute")).toHaveLength(2);
  });

  it("a GPS area anchor mid-route neither advances nor reroutes", () => {
    const gps = applyInput(undefined, {
      type: "gps",
      fix: { ...ENTRANCE, accuracyM: 40 },
      at: 0,
    });
    const progress = initialRouteProgress(undefined);
    const { signal } = onRouteAnchor(progress, gps, routeGalleries);
    expect(signal).toEqual({ type: "none" });
  });
});
