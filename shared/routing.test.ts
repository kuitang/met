import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildRouteGraph,
  floorLabelOf,
  route,
  type GalleryRow,
  type GraphEdge,
  type GraphNode,
} from "./routing.ts";

/**
 * Fixture: the REAL routing graph + gallery rows from data/met.sqlite
 * (geometry/graph tables are complete — built from the committed Living Map
 * raw tiles — even while the objects table hydrates). Regenerate with:
 *
 *   node -e "const D=require('better-sqlite3'),z=require('node:zlib'),f=require('node:fs');
 *     const db=new D('data/met.sqlite',{readonly:true});
 *     f.writeFileSync('shared/fixtures/met-graph.json.gz',z.gzipSync(JSON.stringify({
 *       generated:'from data/met.sqlite '+db.prepare(\"select value from meta where key='dataVersion'\").get().value,
 *       nodes:db.prepare('select id,lat,lon,floor,site,gallery,kind,name from graph_nodes').all(),
 *       edges:db.prepare('select a,b,len,kind,bearing,room from graph_edges').all(),
 *       galleries:db.prepare('select galleryNumber,title,floor,site from galleries').all()}),{level:9}))"
 */
const fixture = JSON.parse(
  gunzipSync(
    readFileSync(fileURLToPath(new URL("./fixtures/met-graph.json.gz", import.meta.url))),
  ).toString("utf8"),
) as { nodes: GraphNode[]; edges: GraphEdge[]; galleries: GalleryRow[] };

const graph = buildRouteGraph(fixture.nodes, fixture.edges, fixture.galleries);

describe("floorLabelOf", () => {
  it("maps the graph's numeric floors to the published labels", () => {
    expect(floorLabelOf(0)).toBe("G");
    expect(floorLabelOf(1)).toBe("1");
    expect(floorLabelOf(1.5)).toBe("1M");
    expect(floorLabelOf(2)).toBe("2");
  });
});

describe("route 131 → 822 (Temple of Dendur → the Van Gogh gallery, J9)", () => {
  const r = route(graph, "131", "822")!;

  it("finds a route of plausible length (graph eval: ~1.2× straight line)", () => {
    expect(r).not.toBeNull();
    expect(r.distanceM).toBeGreaterThan(200);
    expect(r.distanceM).toBeLessThan(450);
  });

  it("starts in Gallery 131 and arrives in Gallery 822, titles joined in", () => {
    expect(r.steps[0].kind).toBe("start");
    expect(r.steps[0].instruction).toBe(
      "Start in Gallery 131 (The Temple of Dendur) — Floor 1",
    );
    const last = r.steps[r.steps.length - 1];
    expect(last.kind).toBe("arrive");
    expect(last.gallery).toBe("822");
    expect(last.instruction).toContain("you've arrived at Gallery 822 (The Annenberg Collection)");
  });

  it("crosses floors with exactly one room-grouped vertical step", () => {
    const vertical = r.steps.filter((s) => s.kind === "stairs" || s.kind === "elevator");
    expect(vertical).toHaveLength(1);
    expect(vertical[0].instruction).toMatch(/^Take the (stairs|elevator) to Floor 2$/);
    expect(r.steps[0].floor).toBe(1);
    expect(r.steps[r.steps.length - 1].floor).toBe(2);
  });

  it("phrases every transition as an exit through a compass door", () => {
    for (const s of r.steps) {
      if (s.kind !== "walk") continue;
      expect(s.instruction).toMatch(
        /^Exit .+ through the (north|northeast|east|southeast|south|southwest|west|northwest) door into .+$/,
      );
    }
  });

  it("returns the polyline path and the traversed edges", () => {
    expect(r.path.length).toBeGreaterThan(r.steps.length);
    expect(r.edges).toHaveLength(r.path.length - 1);
    expect(r.path[0].floor).toBe(1);
    expect(r.path[r.path.length - 1].floor).toBe(2);
  });
});

describe("route 131 → 822 with avoidStairs (J10)", () => {
  const r = route(graph, "131", "822", { avoidStairs: true })!;

  it("uses no stairs edge anywhere in the path", () => {
    expect(r).not.toBeNull();
    expect(r.edges.every((e) => e.kind !== "stairs")).toBe(true);
  });

  it("rides the elevator instead and says so", () => {
    expect(r.edges.some((e) => e.kind === "elevator")).toBe(true);
    expect(r.steps.some((s) => s.kind === "elevator" && /elevator to Floor 2/.test(s.instruction))).toBe(true);
    expect(r.steps.some((s) => /stairs/i.test(s.instruction))).toBe(false);
  });
});

describe("route 534 → 535 (the Vélez Blanco Patio pair from the brief)", () => {
  it("exits through a compass door, takes the stairs, arrives upstairs", () => {
    const r = route(graph, "534", "535")!;
    expect(r.steps.map((s) => s.instruction)).toEqual([
      "Start in Gallery 534 (Patio from the Castle of Vélez Blanco) — Floor 1",
      "Exit Gallery 534 through the south door into the stairs",
      "Take the stairs to Floor 2",
      "Exit the stairs through the northeast door — you've arrived at Gallery 535 (The Vélez Blanco Patio)",
    ]);
  });
});

describe("edge cases", () => {
  it("same-gallery route degenerates to a single arrive step", () => {
    const r = route(graph, "131", "131")!;
    expect(r.distanceM).toBe(0);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].kind).toBe("arrive");
    expect(r.steps[0].instruction).toContain("already in Gallery 131");
  });

  it("unknown endpoints return null", () => {
    expect(route(graph, "131", "no-such-gallery")).toBeNull();
    expect(route(graph, "no-such-gallery", "822")).toBeNull();
  });

  it("cross-site routes are impossible (disconnected components)", () => {
    // Cloisters gallery 03 vs Fifth Ave 822: no edge crosses sites.
    const cloisters = fixture.nodes.find((n) => n.site === "cloisters" && n.gallery);
    expect(cloisters).toBeDefined();
    expect(route(graph, cloisters!.gallery!, "822")).toBeNull();
  });

  it("routes to amenity node ids (J12 destinations)", () => {
    const restroom = fixture.nodes.find(
      (n) => n.site === "fifthAve" && n.name?.includes("Restroom") && n.floor === 1,
    )!;
    const r = route(graph, "131", restroom.id)!;
    expect(r).not.toBeNull();
    expect(r.steps[r.steps.length - 1].nodeId).toBe(restroom.id);
    expect(r.steps[r.steps.length - 1].instruction).toContain("Restroom");
  });

  it("Cloisters routes work inside their own component", () => {
    const cl = fixture.nodes.filter((n) => n.site === "cloisters" && n.gallery);
    const r = route(graph, cl[0].gallery!, cl[cl.length - 1].gallery!);
    expect(r).not.toBeNull();
  });
});
