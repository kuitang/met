// C4 full-scale SEARCH-EVAL DB builder (NOT the production pipeline — that is
// data/src/build-db.ts). Used at Gate C because the B-stream artifact was not
// ready; produces a met.sqlite with the exact shared/search.ts schema so the
// 50-golden eval runs at true catalog scale. See data/evals/reports/search-eval.md.
// Sources: (1) official CC0 Met Open Access CSV (frozen 2023 — text metadata only):
//     curl -sL -o $DIR/MetObjects.csv https://media.githubusercontent.com/media/metmuseum/openaccess/master/MetObjects.csv
// (2) live on-view ID set from the Met API (one request):
//     curl -s "https://collectionapi.metmuseum.org/public/collection/v1/search?isOnView=true&q=*" -o $DIR/onview.json
// (3) the objects pipeline's fresh API-hydrated rows (/tmp/met-objects-cache.ndjson resume cache, if present),
// (4) targeted API hydration (0.5 s spacing) of golden objectIDs missing from (1)+(3).
// Usage: node data/evals/fullscale-eval-db.mjs   (Node >= 24; expects (1)+(2) in $DIR)
import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const Database = createRequire(p("../package.json"))("better-sqlite3");

const DIR = process.env.EVAL_DIR ?? "/tmp/c4-fullscale";
const EXHIBITION = new Set(["099", "199", "899", "964", "965", "999"]);

// ---- streaming CSV parser (RFC4180: quoted fields, embedded newlines/commas) ----
async function* csvRecords(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let field = "", record = [], inQuotes = false, prevQuote = false;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (ch === '"') { inQuotes = false; prevQuote = true; }
        else field += ch;
      } else if (prevQuote && ch === '"') { field += '"'; inQuotes = true; prevQuote = false; }
      else if (ch === '"') { inQuotes = true; prevQuote = false; }
      else if (ch === ",") { record.push(field); field = ""; prevQuote = false; }
      else if (ch === "\n") {
        record.push(field.endsWith("\r") ? field.slice(0, -1) : field);
        yield record; field = ""; record = []; prevQuote = false;
      } else { field += ch; prevQuote = false; }
    }
  }
  if (field !== "" || record.length) { record.push(field); yield record; }
}

const onview = new Set(JSON.parse(readFileSync(`${DIR}/onview.json`, "utf8")).objectIDs);
console.log("on-view IDs:", onview.size);

// ---- pass 1: CSV → rows for on-view IDs ----
const rows = new Map();
let header = null, idx = {}, n = 0;
for await (const rec of csvRecords(`${DIR}/MetObjects.csv`)) {
  if (!header) {
    header = rec.map((h) => h.replace(/^﻿/, ""));
    header.forEach((h, i) => (idx[h] = i));
    continue;
  }
  n++;
  const id = Number(rec[idx["Object ID"]]);
  if (!onview.has(id)) continue;
  const gallery = (rec[idx["Gallery Number"]] || "").trim();
  const dept = rec[idx["Department"]] || "";
  rows.set(id, {
    objectID: id,
    accession: rec[idx["Object Number"]] || "",
    title: rec[idx["Title"]] || "",
    artist: rec[idx["Artist Display Name"]] || "",
    culture: rec[idx["Culture"]] || "",
    period: rec[idx["Period"]] || "",
    classification: rec[idx["Classification"]] || "",
    medium: rec[idx["Medium"]] || "",
    tags: rec[idx["Tags"]] || "",
    galleryNumber: gallery,
    site: dept === "The Cloisters" ? "cloisters" : "fifthAve",
    rotation: EXHIBITION.has(gallery) ? "exhibition" : "permanent",
    isHighlight: rec[idx["Is Highlight"]] === "True" ? 1 : 0,
    imageUrl: "", // CSV has no image URL; patched from fresh rows where available
    metadataDate: rec[idx["Metadata Date"]] || "",
  });
}
console.log(`CSV rows scanned: ${n}; on-view matched: ${rows.size}`);

// ---- pass 2: overlay B's fresh API rows ----
let fresh = 0;
if (existsSync("/tmp/met-objects-cache.ndjson")) {
  for (const line of readFileSync("/tmp/met-objects-cache.ndjson", "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { row } = JSON.parse(line);
    if (!row || !onview.has(row.objectID)) continue;
    rows.set(row.objectID, {
      ...row,
      tags: row.tags || "",
      isHighlight: row.isHighlight ? 1 : 0,
    });
    fresh++;
  }
}
console.log("fresh API rows overlaid:", fresh);

// ---- pass 3: hydrate golden IDs missing from the corpus (gentle: 2 req/s) ----
const goldens = JSON.parse(
  readFileSync(p("./search-cases.json"), "utf8"),
).cases;
const goldenIDs = [...new Set(goldens.flatMap((c) => c.expectObjectIDs ?? []))];
const missing = goldenIDs.filter((id) => !rows.has(id) || !rows.get(id).title);
console.log("golden IDs:", goldenIDs.length, "missing/empty:", missing.length, missing);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of missing) {
  await sleep(500);
  try {
    const res = await fetch(
      `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
      { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" } },
    );
    if (!res.ok) { console.log(`  hydrate ${id}: HTTP ${res.status}`); continue; }
    const o = await res.json();
    const gallery = o.GalleryNumber || "";
    rows.set(id, {
      objectID: id,
      accession: o.accessionNumber || "",
      title: o.title || "",
      artist: o.artistDisplayName || "",
      culture: o.culture || "",
      period: o.period || "",
      classification: o.classification || "",
      medium: o.medium || "",
      tags: (o.tags || []).map((t) => t.term).join("|"),
      galleryNumber: gallery,
      site: o.department === "The Cloisters" ? "cloisters" : "fifthAve",
      rotation: EXHIBITION.has(gallery) ? "exhibition" : "permanent",
      isHighlight: o.isHighlight ? 1 : 0,
      imageUrl: o.primaryImageSmall || "",
      metadataDate: o.metadataDate || "",
    });
    console.log(`  hydrated ${id}: ${o.title}`);
  } catch (e) { console.log(`  hydrate ${id} failed:`, e.message); }
}

// ---- build met.sqlite (exact shared/search.ts contract) ----
const dbPath = `${DIR}/met.sqlite`;
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  DROP TABLE IF EXISTS objects; DROP TABLE IF EXISTS objects_fts; DROP TABLE IF EXISTS galleries; DROP TABLE IF EXISTS amenities;
  CREATE TABLE objects(
    objectID INTEGER PRIMARY KEY, accession TEXT, title TEXT, artist TEXT,
    culture TEXT, period TEXT, classification TEXT, medium TEXT, tags TEXT,
    galleryNumber TEXT, site TEXT, rotation TEXT, isHighlight INTEGER,
    imageUrl TEXT, metadataDate TEXT);
  CREATE VIRTUAL TABLE objects_fts USING fts5(
    title, artist, culture, classification, medium, tags,
    content='objects', content_rowid='objectID',
    tokenize='porter unicode61', prefix='2 3 4');
  CREATE TABLE galleries(galleryNumber TEXT, site TEXT, floor TEXT,
    title TEXT, closed INTEGER, PRIMARY KEY(galleryNumber, site));
  CREATE TABLE amenities(id INTEGER PRIMARY KEY, type TEXT, name TEXT,
    galleryNumber TEXT, site TEXT, floor TEXT, lat REAL, lon REAL);
`);
const insObj = db.prepare(`INSERT INTO objects VALUES (@objectID,@accession,@title,@artist,@culture,@period,@classification,@medium,@tags,@galleryNumber,@site,@rotation,@isHighlight,@imageUrl,@metadataDate)`);
const insFts = db.prepare(`INSERT INTO objects_fts(rowid,title,artist,culture,classification,medium,tags) VALUES (?,?,?,?,?,?,?)`);
db.transaction(() => {
  for (const r of rows.values()) {
    insObj.run(r);
    insFts.run(r.objectID, r.title, r.artist, r.culture, r.classification, r.medium, r.tags);
  }
})();

// galleries from B's geometry snapshot
const gj = JSON.parse(readFileSync(p("../snapshots/galleries.geojson"), "utf8"));
const insGal = db.prepare(`INSERT OR IGNORE INTO galleries VALUES (?,?,?,?,?)`);
let gals = 0;
db.transaction(() => {
  for (const f of gj.features) {
    const p = f.properties;
    if (p.type !== "gallery" || !p.galleryNumber) continue;
    const floor = (p.floorName || "").replace(/^Floor /, "") || String(p.floor ?? "");
    insGal.run(p.galleryNumber, p.site, floor, p.title || "", p.closed ? 1 : 0);
    gals++;
  }
})();

// amenities from B's snapshot
const aj = JSON.parse(readFileSync(p("../snapshots/amenities.geojson"), "utf8"));
const TYPE_MAP = { restroom: "restroom", dining: "dining", elevator: "elevator", water: "water", information: "info" };
const insAm = db.prepare(`INSERT INTO amenities(type,name,galleryNumber,site,floor,lat,lon) VALUES (?,?,?,?,?,?,?)`);
let ams = 0, amSkipped = {};
db.transaction(() => {
  for (const f of aj.features) {
    const p = f.properties;
    const t = TYPE_MAP[(p.kind || "").toLowerCase()];
    if (!t) { amSkipped[p.kind] = (amSkipped[p.kind] || 0) + 1; continue; }
    const [lon, lat] = f.geometry?.coordinates ?? [null, null];
    const floor = (p.floorName || "").replace(/^Floor /, "") || String(p.floor ?? "");
    insAm.run(t, p.title || p.name || "", p.galleryNumber || "", p.site || "fifthAve", floor, lat, lon);
    ams++;
  }
})();
console.log("galleries:", gals, "amenities:", ams, "skipped types:", amSkipped);

db.exec(`INSERT INTO objects_fts(objects_fts) VALUES('optimize');`);
db.close();
writeFileSync(`${DIR}/VERSION`, "c4-fullscale-eval-2026-06-10\n");
const { size } = await import("node:fs").then((m) => m.promises.stat(dbPath));
console.log(`DONE: ${dbPath} ${(size / 1e6).toFixed(1)} MB, objects: ${rows.size}`);
