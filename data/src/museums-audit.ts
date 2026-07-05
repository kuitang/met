/**
 * Per-museum data-quality audit (D10). Reads `data/met.sqlite` (built by
 * build-db.ts) and reports, per registry museum:
 *
 *   1. Fill rates          — measured % non-empty per field, + gallery-table
 *                             room-label coverage (title/floor)
 *   2. Structural invariants (hard FAIL) — real bugs only: objectID
 *      collisions, sourceId uniqueness, site values outside the registry,
 *      empty license, TTL museums missing meta.ttlDays, and the
 *      object→gallery join rate (thresholded, not asserted at 100% — the
 *      Met's alias-only exhibition codes are a known, small, documented tail;
 *      see docs/DATA.md's coverage section for the alias-resolved number).
 *   3. Distribution sanity (WARN, numbers not guesses) — catalog-noise
 *      (title, artist) clusters, rows-per-gallery p50/p95/max, empty-title %,
 *      titleAlt coverage for translateFrom museums, license histogram.
 *   4. Churn (Kui's Gate-3 replacement) — added/removed/moved-room counts vs
 *      a PREVIOUS met.sqlite, when one is available. This is the staleness
 *      DASHBOARD the client's degraded-fidelity copy will eventually read;
 *      it is not itself a merge gate.
 *
 * Per Kui's standing rule (evals are a north star, not a merge gate): only
 * the structural invariants above can FAIL the process; everything else is
 * WARN-with-numbers into the report.
 *
 * Usage: npm -w data run audit   (tsx src/museums-audit.ts; also chained from
 *   `npm run evals`). PREV_DB=<path> or --prev=<path> points at a previous
 *   met.sqlite for the churn section (the nightly job always has one via its
 *   Tigris pull — see data/src/nightly.ts; local runs without it just note
 *   the section unavailable rather than fabricating numbers).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MUSEUMS, type MuseumInfo } from "./sources/registry.ts";

type DB = InstanceType<typeof Database>;

const DATA_DIR = process.env.MET_DATA_DIR
  ? path.resolve(process.env.MET_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(DATA_DIR, "met.sqlite");
const REPORTS = path.join(DATA_DIR, "evals", "reports");

type Status = "PASS" | "WARN" | "FAIL";
const worse = (a: Status, b: Status): Status =>
  a === "FAIL" || b === "FAIL" ? "FAIL" : a === "WARN" || b === "WARN" ? "WARN" : "PASS";

// =====================================================================
// Pure metric functions — each takes an open better-sqlite3 Database and
// returns plain data, so data/src/museums-audit.test.ts can exercise them
// against a tiny in-memory fixture without touching the real artifact.
// =====================================================================

export interface FillRates {
  n: number;
  artistPct: number;
  periodPct: number;
  classificationPct: number;
  mediumPct: number;
  tagsPct: number;
  imagePct: number;
  imageLicensedPct: number; // imageUrl non-empty AND imageLicense allows derivatives
  locationNotePct: number;
}

const pct = (n: number, total: number): number => (total ? (100 * n) / total : 0);

export function fillRates(db: DB, museum: string): FillRates {
  const row = db
    .prepare(
      `SELECT count(*) AS n,
        sum(artist != '') AS artist, sum(period != '') AS period,
        sum(classification != '') AS classification, sum(medium != '') AS medium,
        sum(tags != '') AS tags, sum(imageUrl != '') AS image,
        sum(imageUrl != '' AND imageLicense != '') AS imageLicensed,
        sum(locationNote != '') AS locationNote
       FROM objects WHERE museum = ?`,
    )
    .get(museum) as Record<string, number | null>;
  const n = row.n ?? 0;
  return {
    n,
    artistPct: pct(row.artist ?? 0, n),
    periodPct: pct(row.period ?? 0, n),
    classificationPct: pct(row.classification ?? 0, n),
    mediumPct: pct(row.medium ?? 0, n),
    tagsPct: pct(row.tags ?? 0, n),
    imagePct: pct(row.image ?? 0, n),
    imageLicensedPct: pct(row.imageLicensed ?? 0, n),
    locationNotePct: pct(row.locationNote ?? 0, n),
  };
}

export interface RoomLabelCoverage {
  total: number;
  titled: number;
  floored: number;
  titledPct: number;
  flooredPct: number;
}

/** Gallery-row title/floor coverage for a set of site ids (galleries has no museum column). */
export function roomLabelCoverage(db: DB, sites: string[]): RoomLabelCoverage {
  if (sites.length === 0) return { total: 0, titled: 0, floored: 0, titledPct: 0, flooredPct: 0 };
  const placeholders = sites.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT count(*) AS total, sum(title IS NOT NULL) AS titled, sum(floor IS NOT NULL) AS floored
       FROM galleries WHERE site IN (${placeholders})`,
    )
    .get(...sites) as { total: number; titled: number | null; floored: number | null };
  return {
    total: row.total,
    titled: row.titled ?? 0,
    floored: row.floored ?? 0,
    titledPct: pct(row.titled ?? 0, row.total),
    flooredPct: pct(row.floored ?? 0, row.total),
  };
}

export interface JoinCheck {
  total: number;
  matched: number;
  pct: number;
}

/** Every object row should join a `(galleryNumber, site)` galleries row — the site-scoped identity join. */
export function objectGalleryJoin(db: DB, museum: string): JoinCheck {
  const row = db
    .prepare(
      `SELECT count(*) AS total,
        sum(EXISTS (SELECT 1 FROM galleries g WHERE g.galleryNumber = o.galleryNumber AND g.site = o.site)) AS matched
       FROM objects o WHERE o.museum = ?`,
    )
    .get(museum) as { total: number; matched: number | null };
  const matched = row.matched ?? 0;
  return { total: row.total, matched, pct: row.total ? pct(matched, row.total) : 100 };
}

/** objectID is the PRIMARY KEY, so this is always empty post-build; kept as an explicit, testable assertion. */
export function objectIdCollisions(db: DB): number[] {
  return (
    db.prepare(`SELECT objectID FROM objects GROUP BY objectID HAVING count(*) > 1`).all() as {
      objectID: number;
    }[]
  ).map((r) => r.objectID);
}

/** (museum, sourceId) is UNIQUE-indexed at build time; kept as an explicit, testable assertion. */
export function sourceIdDuplicateCount(db: DB, museum: string): number {
  return (
    db
      .prepare(
        `SELECT sourceId FROM objects WHERE museum = ? GROUP BY sourceId HAVING count(*) > 1`,
      )
      .all(museum) as unknown[]
  ).length;
}

/** Distinct objects.site values for a museum that fall outside its own registry siteIds. */
export function objectSiteViolations(db: DB, museum: string, allowedSites: Set<string>): string[] {
  return (db.prepare(`SELECT DISTINCT site FROM objects WHERE museum = ?`).all(museum) as { site: string }[])
    .map((r) => r.site)
    .filter((s) => !allowedSites.has(s));
}

/** galleries has no museum column (site ids are globally unique) — check once against the full registry. */
export function galleryTableSiteViolations(db: DB, allSites: Set<string>): string[] {
  return (db.prepare(`SELECT DISTINCT site FROM galleries`).all() as { site: string }[])
    .map((r) => r.site)
    .filter((s) => !allSites.has(s));
}

export function licenseEmptyCount(db: DB, museum: string): number {
  return (
    db.prepare(`SELECT count(*) AS n FROM objects WHERE museum = ? AND license = ''`).get(museum) as {
      n: number;
    }
  ).n;
}

/** Minimal structural shape ttlMetaViolations needs — MuseumInfo satisfies it, and fixtures can be tiny. */
export interface MuseumInfoLike {
  id: string;
  license: { text: string; ttlDays?: number };
}

/**
 * Registry-level (not DB) invariant: a museum whose license text carries a
 * TTL marker ("-ttlNN") must set license.ttlDays, or the license-TTL
 * expiry mechanism (shared/search.ts computeExpiredMuseums) silently never
 * fires. Checked bidirectionally — ttlDays without a text marker would also
 * be a silent inconsistency worth catching.
 */
export function ttlMetaViolations(museums: MuseumInfoLike[]): string[] {
  const looksTtl = (m: MuseumInfoLike) => /ttl/i.test(m.license.text);
  return museums.filter((m) => looksTtl(m) !== (m.license.ttlDays !== undefined)).map((m) => m.id);
}

export interface DupCluster {
  title: string;
  artist: string;
  n: number;
}

/** Catalog-noise detector: (title, artist) clusters bigger than `threshold` rows. */
export function duplicateClusters(db: DB, museum: string, threshold = 20): DupCluster[] {
  return db
    .prepare(
      `SELECT title, artist, count(*) AS n FROM objects
       WHERE museum = ? AND title != '' GROUP BY title, artist HAVING n > ? ORDER BY n DESC`,
    )
    .all(museum, threshold) as DupCluster[];
}

export interface RowsPerGallery {
  p50: number;
  p95: number;
  max: number;
  galleryCount: number;
}

export function rowsPerGallery(db: DB, museum: string): RowsPerGallery {
  const rows = (
    db
      .prepare(`SELECT count(*) AS n FROM objects WHERE museum = ? GROUP BY galleryNumber, site ORDER BY n`)
      .all(museum) as { n: number }[]
  ).map((r) => r.n);
  if (rows.length === 0) return { p50: 0, p95: 0, max: 0, galleryCount: 0 };
  const q = (p: number) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))];
  return { p50: q(0.5), p95: q(0.95), max: rows[rows.length - 1], galleryCount: rows.length };
}

export function emptyTitlePct(db: DB, museum: string): number {
  const row = db
    .prepare(`SELECT count(*) AS n, sum(title = '') AS empty FROM objects WHERE museum = ?`)
    .get(museum) as { n: number; empty: number | null };
  return pct(row.empty ?? 0, row.n);
}

export function titleAltCoveragePct(db: DB, museum: string): number {
  const row = db
    .prepare(`SELECT count(*) AS n, sum(titleAlt != '') AS hasAlt FROM objects WHERE museum = ?`)
    .get(museum) as { n: number; hasAlt: number | null };
  return pct(row.hasAlt ?? 0, row.n);
}

export interface LicenseBucket {
  license: string;
  imageLicense: string;
  n: number;
}

export function licenseHistogram(db: DB, museum: string): LicenseBucket[] {
  return db
    .prepare(
      `SELECT license, imageLicense, count(*) AS n FROM objects WHERE museum = ?
       GROUP BY license, imageLicense ORDER BY n DESC`,
    )
    .all(museum) as LicenseBucket[];
}

export interface ChurnResult {
  matched: number;
  added: number;
  removed: number;
  movedRooms: number;
  addedPct: number;
  removedPct: number;
  movedPct: number;
}

function hasSchemaV2Columns(db: DB): boolean {
  const cols = (db.prepare(`PRAGMA table_info(objects)`).all() as { name: string }[]).map((c) => c.name);
  return cols.includes("museum") && cols.includes("sourceId");
}

/**
 * Row-level churn between a previous and the current artifact, keyed on
 * (museum, sourceId) — stable across builds (Met keeps native ids; other
 * museums hash museum+sourceId deterministically). Returns null when either
 * database predates schema v2 (no museum/sourceId columns) — nothing sane to
 * compare.
 */
export function computeChurn(prevDb: DB, currDb: DB, museum: string): ChurnResult | null {
  if (!hasSchemaV2Columns(prevDb) || !hasSchemaV2Columns(currDb)) return null;
  const prevRows = new Map<string, { galleryNumber: string; site: string }>();
  for (const r of prevDb
    .prepare(`SELECT sourceId, galleryNumber, site FROM objects WHERE museum = ?`)
    .all(museum) as { sourceId: string; galleryNumber: string; site: string }[])
    prevRows.set(r.sourceId, { galleryNumber: r.galleryNumber, site: r.site });
  const currRows = new Map<string, { galleryNumber: string; site: string }>();
  for (const r of currDb
    .prepare(`SELECT sourceId, galleryNumber, site FROM objects WHERE museum = ?`)
    .all(museum) as { sourceId: string; galleryNumber: string; site: string }[])
    currRows.set(r.sourceId, { galleryNumber: r.galleryNumber, site: r.site });

  let matched = 0;
  let moved = 0;
  for (const [id, prev] of prevRows) {
    const cur = currRows.get(id);
    if (!cur) continue;
    matched++;
    if (cur.galleryNumber !== prev.galleryNumber || cur.site !== prev.site) moved++;
  }
  const added = [...currRows.keys()].filter((id) => !prevRows.has(id)).length;
  const removed = [...prevRows.keys()].filter((id) => !currRows.has(id)).length;
  const baseline = prevRows.size || 1;
  return {
    matched,
    added,
    removed,
    movedRooms: moved,
    addedPct: pct(added, baseline),
    removedPct: pct(removed, baseline),
    movedPct: matched ? pct(moved, matched) : 0,
  };
}

// =====================================================================
// Report assembly + hard-gate roll-up
// =====================================================================

interface MuseumSection {
  info: MuseumInfo;
  status: Status;
  lines: string[];
  summaryRow: string;
  hardGateRows: string[];
}

function auditMuseum(db: DB, info: MuseumInfo, prevDb: DB | null, allSites: Set<string>): MuseumSection {
  const sites = info.sites.map((s) => s.siteId);
  const fr = fillRates(db, info.id);
  const room = roomLabelCoverage(db, sites);
  const join = objectGalleryJoin(db, info.id);
  const sourceDupes = sourceIdDuplicateCount(db, info.id);
  const siteViol = objectSiteViolations(db, info.id, new Set(sites));
  const licEmpty = licenseEmptyCount(db, info.id);
  const dupClusters = duplicateClusters(db, info.id, 20);
  const rpg = rowsPerGallery(db, info.id);
  const emptyTitle = emptyTitlePct(db, info.id);
  const titleAlt = titleAltCoveragePct(db, info.id);
  const licHist = licenseHistogram(db, info.id);
  const churn = prevDb ? computeChurn(prevDb, db, info.id) : null;

  let status: Status = "PASS";
  const hardGateRows: string[] = [];
  const gate = (label: string, ok: boolean, detail: string, sev: Status = "FAIL") => {
    hardGateRows.push(`| ${label} (${info.id}) | ${ok ? "PASS" : sev} | ${detail} |`);
    if (!ok) status = worse(status, sev);
  };
  gate("sourceId unique per museum", sourceDupes === 0, `${sourceDupes} duplicate (museum, sourceId) groups`);
  gate(
    "objects.site ⊆ registry sites",
    siteViol.length === 0,
    siteViol.length ? `unknown site values: ${siteViol.join(", ")}` : "all objects.site values are registered",
  );
  gate("license non-empty", licEmpty === 0, `${licEmpty}/${fr.n} objects with license=''`);
  // Object→gallery join: thresholded, not asserted at 100% — see file header.
  const joinStatus: Status = join.pct >= 99 ? "PASS" : join.pct >= 95 ? "WARN" : "FAIL";
  hardGateRows.push(
    `| every object joins a gallery row, site-scoped (${info.id}) | ${joinStatus} | ${join.matched}/${join.total} (${join.pct.toFixed(2)}%) |`,
  );
  status = worse(status, joinStatus);

  const lines: string[] = [];
  lines.push(`### ${info.name} (\`${info.id}\`)`, "");
  lines.push(
    `Fidelity **${info.fidelity}** · sites: ${sites.join(", ")} · license \`${info.license.text}\`` +
      (info.license.ttlDays ? ` (TTL ${info.license.ttlDays}d)` : "") +
      (info.translateFrom ? ` · translateFrom \`${info.translateFrom}\`` : ""),
    "",
    "#### Fill rates (measured %, n=" + fr.n + ")",
    "",
    "| field | filled | % |",
    "|---|---|---|",
    `| artist | ${Math.round((fr.artistPct / 100) * fr.n)} | ${fr.artistPct.toFixed(1)}% |`,
    `| period/date | ${Math.round((fr.periodPct / 100) * fr.n)} | ${fr.periodPct.toFixed(1)}% |`,
    `| classification | ${Math.round((fr.classificationPct / 100) * fr.n)} | ${fr.classificationPct.toFixed(1)}% |`,
    `| medium | ${Math.round((fr.mediumPct / 100) * fr.n)} | ${fr.mediumPct.toFixed(1)}% |`,
    `| tags | ${Math.round((fr.tagsPct / 100) * fr.n)} | ${fr.tagsPct.toFixed(1)}% |`,
    `| image (imageUrl set) | ${Math.round((fr.imagePct / 100) * fr.n)} | ${fr.imagePct.toFixed(1)}% |`,
    `| image, license-allowed | ${Math.round((fr.imageLicensedPct / 100) * fr.n)} | ${fr.imageLicensedPct.toFixed(1)}% |`,
    `| locationNote | ${Math.round((fr.locationNotePct / 100) * fr.n)} | ${fr.locationNotePct.toFixed(1)}% |`,
    "",
    `Room-label coverage (galleries table, ${room.total} rows for this museum's sites): ` +
      `**${room.titled}/${room.total} titled (${room.titledPct.toFixed(1)}%)**, ` +
      `**${room.floored}/${room.total} floored (${room.flooredPct.toFixed(1)}%)**.`,
    "",
    "#### Structural invariants",
    "",
    `- object→gallery join: **${join.matched}/${join.total} (${join.pct.toFixed(2)}%)** — ${joinStatus}` +
      (info.id === "met"
        ? " (known tail: alias-only exhibition codes not present in the galleries table directly — see docs/DATA.md coverage section for the alias-resolved 99.8%)"
        : ""),
    `- sourceId duplicate groups: **${sourceDupes}**`,
    `- objects.site values outside the registry: **${siteViol.length}**${siteViol.length ? " → " + siteViol.join(", ") : ""}`,
    `- objects with license='': **${licEmpty}**`,
    "",
    "#### Distribution sanity",
    "",
    `- Empty-title rows: **${emptyTitle.toFixed(2)}%**`,
    `- Rows per gallery: p50 **${rpg.p50}**, p95 **${rpg.p95}**, max **${rpg.max}** (${rpg.galleryCount} distinct galleries)`,
    ...(info.translateFrom ? [`- titleAlt coverage (translateFrom ${info.translateFrom}): **${titleAlt.toFixed(1)}%**`] : []),
    `- License histogram: ${licHist.map((h) => `\`${h.license}\`/\`${h.imageLicense || "(none)"}\` ×${h.n}`).join(", ")}`,
    "",
    `Catalog-noise clusters — (title, artist) pairs with >20 rows (top 5 of ${dupClusters.length}):`,
    "",
    ...(dupClusters.length
      ? [
          "| title | artist | rows |",
          "|---|---|---|",
          ...dupClusters.slice(0, 5).map((c) => `| ${c.title} | ${c.artist || "(none)"} | ${c.n} |`),
        ]
      : ["None."]),
    "",
    "#### Churn vs previous artifact",
    "",
    ...(churn
      ? [
          `- Matched rows: **${churn.matched}**`,
          `- Added: **${churn.added}** (${churn.addedPct.toFixed(1)}% of previous count)`,
          `- Removed: **${churn.removed}** (${churn.removedPct.toFixed(1)}% of previous count)`,
          `- Moved rooms: **${churn.movedRooms}** (${churn.movedPct.toFixed(1)}% of matched rows)`,
        ]
      : ["No previous artifact provided (set PREV_DB=<path> to a prior met.sqlite) — churn unavailable this run."]),
    "",
  );

  const summaryRow =
    `| ${info.shortName} | ${fr.n} | ${info.fidelity} | ${join.pct.toFixed(1)}% | ${fr.artistPct.toFixed(0)}% | ` +
    `${fr.periodPct.toFixed(0)}% | ${fr.classificationPct.toFixed(0)}% | ${fr.mediumPct.toFixed(0)}% | ` +
    `${fr.tagsPct.toFixed(0)}% | ${fr.imagePct.toFixed(0)}% | ${fr.imageLicensedPct.toFixed(0)}% | ` +
    `${room.titledPct.toFixed(0)}%/${room.flooredPct.toFixed(0)}% | ${status} |`;

  return { info, status, lines, summaryRow, hardGateRows };
}

function resolvePrevDbPath(): string | null {
  const argPrefix = "--prev=";
  const argv = process.argv.find((a) => a.startsWith(argPrefix));
  const fromArg = argv ? argv.slice(argPrefix.length) : null;
  const candidate = fromArg ?? process.env.PREV_DB ?? path.join(DATA_DIR, "met.sqlite.prev");
  return fs.existsSync(candidate) ? path.resolve(candidate) : null;
}

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`museums-audit: met.sqlite not found at ${DB_PATH} — run npm -w data run build-db first.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });
  const prevPath = resolvePrevDbPath();
  const prevDb = prevPath ? new Database(prevPath, { readonly: true }) : null;

  const presentIds = new Set(
    (db.prepare(`SELECT DISTINCT museum FROM objects`).all() as { museum: string }[]).map((r) => r.museum),
  );
  const museums = MUSEUMS.filter((m) => presentIds.has(m.id));
  const missing = MUSEUMS.filter((m) => !presentIds.has(m.id)).map((m) => m.id);

  const allSites = new Set(MUSEUMS.flatMap((m) => m.sites.map((s) => s.siteId)));
  const galSiteViol = galleryTableSiteViolations(db, allSites);
  const idCollisions = objectIdCollisions(db);
  const ttlViol = ttlMetaViolations(MUSEUMS);

  const sections = museums.map((m) => auditMuseum(db, m, prevDb, allSites));

  let overall: Status = sections.reduce((s, sec) => worse(s, sec.status), "PASS" as Status);
  const globalHardGateRows: string[] = [];
  const globalGate = (label: string, ok: boolean, detail: string) => {
    globalHardGateRows.push(`| ${label} | ${ok ? "PASS" : "FAIL"} | ${detail} |`);
    if (!ok) overall = worse(overall, "FAIL");
  };
  globalGate("objectID collisions", idCollisions.length === 0, `${idCollisions.length} colliding ids`);
  globalGate(
    "galleries.site ⊆ registry sites",
    galSiteViol.length === 0,
    galSiteViol.length ? `unknown site values: ${galSiteViol.join(", ")}` : "all galleries.site values are registered",
  );
  globalGate(
    "TTL museums declare meta.ttlDays",
    ttlViol.length === 0,
    ttlViol.length ? `mismatched: ${ttlViol.join(", ")}` : "every TTL-marked license has ttlDays set (and vice versa)",
  );

  const hardGateFails = [...globalHardGateRows, ...sections.flatMap((s) => s.hardGateRows)].filter((r) =>
    / FAIL /.test(r),
  ).length;
  const hardGateWarns = [...globalHardGateRows, ...sections.flatMap((s) => s.hardGateRows)].filter((r) =>
    / WARN /.test(r),
  ).length;
  const hardGateLine =
    `Hard gate: **${overall === "FAIL" ? "FAIL" : "PASS"}** — ${hardGateFails} structural FAILs, ` +
    `${hardGateWarns} thresholded WARNs (join-rate tails) across ${globalHardGateRows.length + sections.reduce((n, s) => n + s.hardGateRows.length, 0)} checks.`;

  const dataVersion = fs.existsSync(path.join(DATA_DIR, "VERSION"))
    ? fs.readFileSync(path.join(DATA_DIR, "VERSION"), "utf8").trim()
    : "(no VERSION file)";
  const builtAt = (db.prepare(`SELECT value FROM meta WHERE key = 'builtAt'`).get() as { value: string } | undefined)
    ?.value;

  const summaryHeader = [
    "| Museum | objects | fidelity | join% | artist% | period% | classif% | medium% | tags% | image% | img-licensed% | room title%/floor% | gate |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  const body: string[] = [
    `# Museums data-quality audit`,
    "",
    `- Status: **${overall}**`,
    `- Generated: ${new Date().toISOString()} by \`data/src/museums-audit.ts\``,
    `- Data version: ${dataVersion}${builtAt ? ` (built ${builtAt})` : ""}`,
    `- Museums audited: ${museums.map((m) => m.id).join(", ")}${missing.length ? ` (registry entries with no snapshot in this artifact: ${missing.join(", ")})` : ""}`,
    `- Previous artifact for churn: ${prevPath ?? "none provided (PREV_DB unset, no data/met.sqlite.prev) — churn sections unavailable this run"}`,
    "",
    "Per Kui's standing rule, this report is a north-star dashboard: only the",
    "structural invariants below can fail the process (exit 1); everything else",
    "is a WARN with numbers attached, never a guess.",
    "",
    `> ${hardGateLine}`,
    "",
    "## Hard-gate summary",
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...globalHardGateRows,
    ...sections.flatMap((s) => s.hardGateRows),
    "",
    "## Cross-museum summary",
    "",
    ...summaryHeader,
    ...sections.map((s) => s.summaryRow),
    "",
    "## Per-museum detail",
    "",
    ...sections.flatMap((s) => s.lines),
  ];

  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, "museums-audit.md"), body.join("\n") + "\n");

  console.log(
    `${overall} museums-audit: ${museums.length} museums audited, ${idCollisions.length} objectID collisions, ` +
      `${galSiteViol.length} unregistered gallery sites, ${ttlViol.length} TTL-meta mismatches` +
      (prevDb ? `, churn vs ${prevPath}` : ", no PREV_DB — churn skipped"),
  );
  for (const s of sections) console.log(`  ${s.status} ${s.info.id}`);

  db.close();
  prevDb?.close();
  if (overall === "FAIL") process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
