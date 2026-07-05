/**
 * Louvre geometry + routing gate (D7). Reads ONLY committed snapshots
 * (data/museums/louvre/snapshots/ + data/raw/louvre/plan/) — no network, no
 * OSM re-parse — and audits what the shipped artifact will actually do:
 *
 *   geometry — polygon validity, per-floor inventory, salle↔OSM match rates
 *              (both directions, ark-weighted)
 *   graph    — connected components, 500 seeded random matched-salle pairs
 *              through shared/routing.ts (the production router), on-view
 *              salle reachability (reachable / stranded / unmatched — every
 *              salle is accounted for), landmark route Salle 711 (Joconde) →
 *              Salle 345 (Vénus de Milo) incl. avoid-stairs variant
 *   visual   — per-floor SVG renders under data/evals/reports/floors/
 *
 * THE ROUTED-FIDELITY GATE (registry fidelity "room-labels" → "routed"):
 *   1. ≥95% of seeded random matched-salle pairs routable, AND
 *   2. exactly 1 gallery-bearing connected component (no stranded block), AND
 *   3. every on-view salle either routable or explicitly listed below.
 * The gate result is printed as GATE PASS/FAIL; the report records the
 * decision. Exit code 1 iff a hard eval FAILs (gate failure alone is not a
 * hard failure — it just means fidelity must stay "room-labels").
 *
 * Usage: npm -w data run evals:louvre   (tsx src/evals-louvre.ts)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlanSalles } from "./lib/louvre-plan.ts";
import {
  buildRouteGraph,
  route,
  type GraphNode,
  type GraphEdge,
} from "../../shared/routing.ts";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(DATA_DIR, "museums", "louvre", "snapshots");
const PLAN_DIR = path.join(DATA_DIR, "raw", "louvre", "plan");
const REPORTS = path.join(DATA_DIR, "evals", "reports");
const FLOORS_DIR = path.join(REPORTS, "floors");

type Status = "PASS" | "WARN" | "FAIL";
const worse = (a: Status, b: Status): Status =>
  a === "FAIL" || b === "FAIL" ? "FAIL" : a === "WARN" || b === "WARN" ? "WARN" : "PASS";

// ---------- geometry helpers ----------
const D2R = Math.PI / 180;
const MX = Math.cos(48.861 * D2R) * 111319.49;
const MY = 111207;
type Pt = [number, number];
type Ring = Pt[];
type Poly = Ring[];
const toM = ([lon, lat]: Pt): Pt => [lon * MX, lat * MY];

function ringArea(ring: Ring): number {
  const [ox, oy] = ring[0];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
  return a / 2;
}

function main(): void {
  const plan = loadPlanSalles(PLAN_DIR);
  const gj = JSON.parse(fs.readFileSync(path.join(SNAP, "galleries.geojson"), "utf8"));
  const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = JSON.parse(
    fs.readFileSync(path.join(SNAP, "graph.json"), "utf8"),
  );
  const meta = JSON.parse(fs.readFileSync(path.join(SNAP, "geometry-meta.json"), "utf8"));
  // shared/routing.ts rows carry nullable fields; the snapshot omits them.
  const nodes: GraphNode[] = graph.nodes.map((n) => ({
    ...n,
    gallery: n.gallery ?? null,
    kind: n.kind ?? null,
    name: n.name ?? null,
  }));
  const edges: GraphEdge[] = graph.edges.map((e) => ({
    ...e,
    bearing: e.bearing ?? null,
    room: e.room ?? null,
  }));

  const body: string[] = [];
  let status: Status = "PASS";

  // ================= 1. geometry =================
  interface Feat {
    galleryNumber: string | null;
    name: string | null;
    title: string | null;
    type: string;
    floor: string;
    polysLL: Poly[];
    polysM: Poly[];
    area: number;
  }
  const feats: Feat[] = gj.features.map((f: any) => {
    const polysLL: Poly[] =
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const polysM = polysLL.map((rings: Poly) => rings.map((ring) => ring.map((c: Pt) => toM(c))));
    return {
      galleryNumber: f.properties.galleryNumber,
      name: f.properties.name,
      title: f.properties.title,
      type: f.properties.type,
      floor: f.properties.floor,
      polysLL,
      polysM,
      area: polysM.reduce((s: number, rings: Poly) => s + Math.abs(ringArea(rings[0])), 0),
    };
  });
  const invalid: string[] = [];
  for (const r of feats) {
    const label = `${r.galleryNumber ?? r.name ?? "?"} (f${r.floor})`;
    for (const rings of r.polysLL)
      for (const ring of rings) {
        if (ring.length < 4) invalid.push(`${label}: ring with ${ring.length} points`);
        const [f0, l0] = [ring[0], ring[ring.length - 1]];
        if (f0[0] !== l0[0] || f0[1] !== l0[1]) invalid.push(`${label}: unclosed ring`);
        if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
          invalid.push(`${label}: non-finite coordinate`);
      }
    if (r.area < 0.5) invalid.push(`${label}: degenerate area ${r.area.toFixed(3)} m²`);
  }
  const matchedCodes = new Set(feats.map((f) => f.galleryNumber).filter(Boolean) as string[]);
  const galleryFeats = feats.filter((f) => f.galleryNumber);
  const perFloor = new Map<string, { feats: number; galleries: number; planCodes: number; matched: number }>();
  for (const f of feats) {
    const e = perFloor.get(f.floor) ?? { feats: 0, galleries: 0, planCodes: 0, matched: 0 };
    e.feats++;
    if (f.galleryNumber) e.galleries++;
    perFloor.set(f.floor, e);
  }
  for (const s of plan.values()) {
    const e = perFloor.get(s.floor) ?? { feats: 0, galleries: 0, planCodes: 0, matched: 0 };
    e.planCodes++;
    if (matchedCodes.has(s.galleryNumber)) e.matched++;
    perFloor.set(s.floor, e);
  }
  const arksTotal = [...plan.values()].reduce((s, p) => s + p.arks.size, 0);
  const arksMatched = [...plan.values()]
    .filter((p) => matchedCodes.has(p.galleryNumber))
    .reduce((s, p) => s + p.arks.size, 0);
  if (invalid.length > 0) status = "FAIL";
  if (matchedCodes.size < 0.5 * plan.size) status = worse(status, "WARN");

  body.push(
    `## Geometry`,
    "",
    `- Features: ${feats.length} (${galleryFeats.length} salle-matched, ${feats.length - galleryFeats.length} backdrop)`,
    `- Invalid polygons: **${invalid.length}**${invalid.length ? "\n" + invalid.map((s) => `  - ${s}`).join("\n") : ""}`,
    `- Salle match (plan → OSM): **${matchedCodes.size}/${plan.size} codes** — ` +
      `**${((100 * arksMatched) / arksTotal).toFixed(1)}% of ${arksTotal} on-view arks** sit in a matched salle`,
    `- OSM → plan: ${meta.salleMatch.matchedOsmSpaces}/${meta.osm.walkableRooms} walkable OSM spaces carry a salle code ` +
      `(${meta.salleMatch.via.code} by explicit code, ${meta.salleMatch.via.name} by title match; ` +
      `${meta.salleMatch.nameAmbiguousDropped} ambiguous names dropped, never guessed)`,
    "",
    `| floor | plan salles | matched | OSM features | salle polygons |`,
    `|---|---|---|---|---|`,
    ...[...perFloor.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(
        ([fl, e]) => `| ${fl} | ${e.planCodes} | ${e.matched} | ${e.feats} | ${e.galleries} |`,
      ),
    "",
  );

  // ================= 2. graph =================
  const galleryRows = [...plan.values()].map((s) => ({
    galleryNumber: s.galleryNumber,
    title: s.title,
    floor: s.floor,
    site: "louvre",
  }));
  const rg = buildRouteGraph(nodes, edges, galleryRows);

  // components
  const comp = new Map<string, number>();
  let c = 0;
  for (const n of nodes) {
    if (comp.has(n.id)) continue;
    const stack = [n.id];
    comp.set(n.id, c);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const { to } of rg.adjacency.get(cur) ?? [])
        if (!comp.has(to)) {
          comp.set(to, c);
          stack.push(to);
        }
    }
    c++;
  }
  const compGalleries = new Map<number, string[]>();
  const compSizes = new Map<number, number>();
  for (const n of nodes) {
    const cc = comp.get(n.id)!;
    compSizes.set(cc, (compSizes.get(cc) ?? 0) + 1);
    if (n.gallery) {
      let l = compGalleries.get(cc);
      if (!l) compGalleries.set(cc, (l = []));
      l.push(n.gallery);
    }
  }
  const galleryComps = [...compGalleries.entries()].sort((a, b) => b[1].length - a[1].length);
  const mainComp = galleryComps[0]?.[0] ?? -1;

  // 500 seeded random matched-salle pairs through the production router
  const galleryNodes = nodes.filter((n) => n.gallery);
  let rngState = 42;
  const rng = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const PAIRS = 500;
  let ok = 0;
  const failures = new Map<string, number>();
  const lens: number[] = [];
  for (let i = 0; i < PAIRS; i++) {
    const a = galleryNodes[Math.floor(rng() * galleryNodes.length)];
    const b = galleryNodes[Math.floor(rng() * galleryNodes.length)];
    const r = route(rg, a.gallery!, b.gallery!);
    if (r) {
      ok++;
      lens.push(r.distanceM);
    } else {
      const k = `${a.gallery} → ${b.gallery}`;
      failures.set(k, (failures.get(k) ?? 0) + 1);
    }
  }
  lens.sort((x, y) => x - y);
  const q = (p: number) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? NaN;

  // on-view salle accounting: every plan salle with arks lands in one bucket
  const reachable: string[] = [];
  const stranded: string[] = [];
  const unmatchedSalles: string[] = [];
  for (const s of plan.values()) {
    if (s.arks.size === 0) continue;
    const nodeIds = rg.byGallery.get(s.galleryNumber) ?? [];
    if (nodeIds.length === 0) unmatchedSalles.push(`${s.galleryNumber} (${s.arks.size} arks)`);
    else if (nodeIds.some((id) => comp.get(id) === mainComp)) reachable.push(s.galleryNumber);
    else stranded.push(`${s.galleryNumber} (f${s.floor}, ${s.arks.size} arks)`);
  }

  // landmark: Joconde → Vénus de Milo, both ways of taking stairs
  const landmark = route(rg, "711", "345");
  const landmarkNoStairs = route(rg, "711", "345", { avoidStairs: true });
  const straight711 = (() => {
    const a = nodes.find((n) => n.gallery === "711");
    const b = nodes.find((n) => n.gallery === "345");
    if (!a || !b) return NaN;
    const dx = (a.lon - b.lon) * MX;
    const dy = (a.lat - b.lat) * MY;
    return Math.hypot(dx, dy);
  })();

  const pairPct = (100 * ok) / PAIRS;
  const gate =
    pairPct >= 95 &&
    galleryComps.length === 1 &&
    stranded.length === 0 &&
    landmark !== null;
  if (!landmark || pairPct < 90) status = worse(status, "FAIL");
  if (galleryComps.length > 1) status = worse(status, "WARN");

  body.push(
    `## Graph`,
    "",
    `- Nodes: ${nodes.length} (${galleryNodes.length} carry a salle code), edges: ${edges.length} ` +
      `(${edges.filter((e) => e.kind === "door").length} door, ${edges.filter((e) => e.kind === "walk").length} walk, ` +
      `${edges.filter((e) => e.kind === "stairs").length} stairs, ${edges.filter((e) => e.kind === "elevator").length} elevator)`,
    `- Doors: ${meta.osm.doorsTwoSided}/${meta.osm.doorsProbed} OSM door nodes resolved to a two-sided doorway; ` +
      `vertical units: ${meta.osm.stairsUnits} stairs + ${meta.osm.elevatorUnits} elevators`,
    `- Connected components: ${new Set(comp.values()).size} total; ` +
      `**${galleryComps.length} carry salle codes** — sizes [${galleryComps
        .slice(0, 6)
        .map(([cc, g]) => `${compSizes.get(cc)}n/${g.length}g`)
        .join(", ")}${galleryComps.length > 6 ? ", …" : ""}]`,
    "",
    `### Random-pair routing (${PAIRS} seeded matched-salle pairs, production router)`,
    "",
    `- Routable: **${ok}/${PAIRS} (${pairPct.toFixed(1)}%)**`,
    `- Path length: p50 ${q(0.5).toFixed(0)} m · p95 ${q(0.95).toFixed(0)} m · max ${q(1).toFixed(0)} m`,
    ...(failures.size
      ? [`- Failing pairs (${failures.size} distinct):`, ...[...failures.keys()].slice(0, 15).map((k) => `  - ${k}`)]
      : []),
    "",
    `### On-view salle accounting (${[...plan.values()].filter((s) => s.arks.size > 0).length} salles hold arks)`,
    "",
    `- Routable from the main block: **${reachable.length}**`,
    `- Matched but stranded outside the main block: **${stranded.length}**` +
      (stranded.length ? ` — ${stranded.join(", ")}` : ""),
    `- No OSM polygon matched (label-only rows, listed): **${unmatchedSalles.length}**`,
    ...(unmatchedSalles.length ? [``, `  ${unmatchedSalles.join(", ")}`] : []),
    "",
    `### Landmark route — Salle 711 (Joconde) → Salle 345 (Vénus de Milo)`,
    "",
    landmark
      ? `- **${landmark.distanceM.toFixed(0)} m walked / ${straight711.toFixed(0)} m straight-line** ` +
        `(${(landmark.distanceM / straight711).toFixed(2)}×), ${landmark.steps.length} steps, ` +
        `≈ ${(landmark.distanceM / 80).toFixed(1)} min` +
        `\n- avoid-stairs: ${landmarkNoStairs ? `${landmarkNoStairs.distanceM.toFixed(0)} m (elevators)` : "NO PATH"}` +
        `\n\n<details><summary>steps</summary>\n\n` +
        landmark.steps.map((s) => `1. ${s.instruction}`).join("\n") +
        `\n\n</details>`
      : `- **NO PATH**`,
    "",
    `## Routed-fidelity gate`,
    "",
    `| criterion | value | pass |`,
    `|---|---|---|`,
    `| random-pair routability ≥95% | ${pairPct.toFixed(1)}% | ${pairPct >= 95 ? "✓" : "✗"} |`,
    `| 1 gallery-bearing component | ${galleryComps.length} | ${galleryComps.length === 1 ? "✓" : "✗"} |`,
    `| no stranded on-view salle | ${stranded.length} stranded | ${stranded.length === 0 ? "✓" : "✗"} |`,
    `| landmark route exists | ${landmark ? "yes" : "no"} | ${landmark ? "✓" : "✗"} |`,
    "",
    `**GATE ${gate ? "PASS — registry fidelity may be 'routed'" : "FAIL — registry fidelity stays 'room-labels'"}**`,
    "",
  );

  // ================= 3. visual =================
  fs.mkdirSync(FLOORS_DIR, { recursive: true });
  const FILL: Record<string, string> = {
    gallery: "#f7efe0",
    corridor: "#f2f2f2",
    stairs: "#e2efe5",
    toilet: "#e8e8f4",
  };
  const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of feats)
    for (const rings of r.polysM)
      for (const [x, y] of rings[0]) {
        bb[0] = Math.min(bb[0], x);
        bb[1] = Math.min(bb[1], y);
        bb[2] = Math.max(bb[2], x);
        bb[3] = Math.max(bb[3], y);
      }
  const written: { file: string; floor: string; rooms: number; edges: number }[] = [];
  for (const fl of ["-1", "0", "1", "2"]) {
    const floorFeats = feats.filter((r) => r.floor === fl);
    const PAD = 10;
    const SCALE = 1.8;
    const W = Math.max(720, Math.ceil((bb[2] - bb[0] + 2 * PAD) * SCALE));
    const H = Math.ceil((bb[3] - bb[1] + 2 * PAD) * SCALE);
    const X = (x: number) => ((x - bb[0] + PAD) * SCALE).toFixed(1);
    const Y = (y: number) => ((bb[3] - y + PAD) * SCALE).toFixed(1);
    const els: string[] = [];
    for (const r of floorFeats.sort((a, b) => b.area - a.area)) {
      const d = r.polysM
        .map((rings) => rings.map((ring) => "M" + ring.map(([x, y]) => `${X(x)},${Y(y)}`).join("L") + "Z").join(""))
        .join("");
      const fill = r.galleryNumber ? (FILL[r.type] ?? FILL.gallery) : (FILL[r.type] ?? "#ececec");
      els.push(`<path d="${d}" fill="${fill}" stroke="#888" stroke-width="0.6" fill-rule="evenodd"/>`);
    }
    let edgeCount = 0;
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const fnum = Number(fl);
    for (const e of edges) {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b || a.floor !== fnum || b.floor !== fnum) continue;
      if (e.kind !== "walk" && e.kind !== "door") continue;
      const [ax, ay] = toM([a.lon, a.lat]);
      const [bx, by] = toM([b.lon, b.lat]);
      els.push(
        `<line x1="${X(ax)}" y1="${Y(ay)}" x2="${X(bx)}" y2="${Y(by)}" stroke="${e.kind === "door" ? "#e4002b" : "#3a7bd5"}" stroke-width="${e.kind === "door" ? 0.9 : 0.5}" opacity="0.55"/>`,
      );
      edgeCount++;
    }
    for (const n of nodes) {
      if (n.floor !== fnum) continue;
      const [x, y] = toM([n.lon, n.lat]);
      if (n.kind === "door") els.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="1.2" fill="#e4002b" opacity="0.8"/>`);
      else if (n.kind === "elevator")
        els.push(`<rect x="${(Number(X(x)) - 3).toFixed(1)}" y="${(Number(Y(y)) - 3).toFixed(1)}" width="6" height="6" fill="#7a4dc9"/>`);
      else if (n.kind === "stairs")
        els.push(`<path d="M${(Number(X(x)) - 3.5).toFixed(1)},${(Number(Y(y)) + 3).toFixed(1)} l3.5,-6 l3.5,6 Z" fill="#2c9c5a"/>`);
    }
    for (const r of floorFeats) {
      if (!r.galleryNumber) continue;
      const ring = r.polysM[0][0];
      let cx = 0;
      let cy = 0;
      for (const [x, y] of ring.slice(0, -1)) {
        cx += x;
        cy += y;
      }
      cx /= ring.length - 1;
      cy /= ring.length - 1;
      const label = r.galleryNumber.length > 6 ? "·" : r.galleryNumber;
      els.push(
        `<text x="${X(cx)}" y="${Y(cy)}" font-size="${Math.min(9, Math.max(4.5, Math.sqrt(r.area) / 4))}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" fill="#222">${label}</text>`,
      );
    }
    const legend =
      `<g font-family="Helvetica,Arial,sans-serif" font-size="11">` +
      `<text x="12" y="18" font-size="14" font-weight="bold">Louvre — niveau ${fl} (OSM)</text>` +
      `<text x="12" y="34">labels = plan salle codes · <tspan fill="#e4002b">red: doorways</tspan> · <tspan fill="#3a7bd5">blue: within-room walks</tspan> · <tspan fill="#2c9c5a">▲ stairs</tspan> · <tspan fill="#7a4dc9">■ elevator</tspan></text></g>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="white"/>${legend}${els.join("")}</svg>`;
    const file = `louvre-f${fl.replace("-", "m")}.svg`;
    fs.writeFileSync(path.join(FLOORS_DIR, file), svg);
    written.push({ file, floor: fl, rooms: floorFeats.length, edges: edgeCount });
  }
  body.push(
    `## Visual`,
    "",
    "| File | niveau | rooms | graph edges drawn |",
    "|---|---|---|---|",
    ...written.map((w) => `| [floors/${w.file}](floors/${w.file}) | ${w.floor} | ${w.rooms} | ${w.edges} |`),
  );

  // ---------- report ----------
  fs.mkdirSync(REPORTS, { recursive: true });
  const head = [
    `# Louvre geometry & routing (OSM, D7)`,
    "",
    `- Status: **${status}** · Routed-fidelity gate: **${gate ? "PASS" : "FAIL"}**`,
    `- Generated: ${new Date().toISOString()} by \`data/src/evals-louvre.ts\``,
    `- Source: OpenStreetMap (ODbL, © OpenStreetMap contributors), Overpass extract 2026-07-05 (committed)`,
    "",
  ];
  fs.writeFileSync(path.join(REPORTS, "louvre.md"), head.concat(body).join("\n") + "\n");
  console.log(
    `${status} louvre: ${matchedCodes.size}/${plan.size} salles matched (${((100 * arksMatched) / arksTotal).toFixed(1)}% of arks), ` +
      `${ok}/${PAIRS} pairs routable, ${galleryComps.length} gallery component(s), ` +
      `711→345 ${landmark ? landmark.distanceM.toFixed(0) + " m / " + landmark.steps.length + " steps" : "NO PATH"}, ` +
      `GATE ${gate ? "PASS" : "FAIL"} (report: data/evals/reports/louvre.md)`,
  );
  if (status === "FAIL") process.exit(1);
}

main();
