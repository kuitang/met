// Sample ~200 Louvre records for the FR->EN translation bake-off (Task 1).
//
// Source of arks: Wikidata SPARQL over P9394 ("Louvre Museum ARK ID") — gives us
// both a broad ark list AND, where present, an English label to use as reference
// translation. Record bodies come from collections.louvre.fr's public .json
// endpoints at <= 2 req/s with a research User-Agent.
//
// Output (committed fixture): data/evals/llm-bakeoff/louvre-sample.json
//   { fetchedAt, records: [{ ark, fr: {title, objectType, materialsAndTechniques, period},
//                            enLabel|null, onView, collection }] }
//
// Deterministic given the same Wikidata result set (seeded shuffle); resumable
// (per-ark responses cached in cache/louvre/).
import fs from "node:fs";
import path from "node:path";
import { DIR, seededSample } from "./lib.mjs";

const UA = "MuseWalk-research/0.1 (kuitang@gmail.com)";
const OUT = path.join(DIR, "louvre-sample.json");
const LCACHE = path.join(DIR, "cache", "louvre");
fs.mkdirSync(LCACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET = 200;
const MAX_ATTEMPTS = 320;

async function sparqlArks() {
  const q = `SELECT ?ark ?enLabel WHERE {
    ?item wdt:P9394 ?ark .
    OPTIONAL { ?item rdfs:label ?enLabel FILTER(LANG(?enLabel)="en") }
  } LIMIT 4000`;
  const res = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}`);
  const j = await res.json();
  const byArk = new Map();
  for (const b of j.results.bindings) {
    const ark = b.ark.value.trim();
    if (!/^\d{9}$/.test(ark)) continue;
    if (!byArk.has(ark) || b.enLabel) byArk.set(ark, b.enLabel?.value ?? null);
  }
  return byArk;
}

async function fetchRecord(ark) {
  const cacheFile = path.join(LCACHE, `${ark}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  await sleep(550); // <= 2 req/s
  const res = await fetch(`https://collections.louvre.fr/ark:/53355/cl${ark}.json`, {
    headers: { "User-Agent": UA },
  });
  const out = res.ok ? await res.json() : { __status: res.status };
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

function toRecord(ark, j, enLabel) {
  const title = str(j.title);
  if (!title || !/[a-zà-ÿ]/i.test(title)) return null;
  const period = str(j.dateCreated?.[0]?.text) || str(j.displayDateCreated).replace(/^Date de création\/fabrication\s*:\s*/i, "");
  const onView = !!str(j.room) && !/non exposé/i.test(str(j.currentLocation));
  return {
    ark,
    fr: {
      title,
      objectType: str(j.objectType),
      materialsAndTechniques: str(j.materialsAndTechniques),
      period,
    },
    enLabel: enLabel ?? null,
    onView,
    collection: str(j.collection),
  };
}

const byArk = await sparqlArks();
console.log(`wikidata: ${byArk.size} arks, ${[...byArk.values()].filter(Boolean).length} with EN labels`);

// Deterministic candidate order; interleave so ~half the sample has an EN
// reference label and the ark list isn't dominated by unlabeled items.
const withEn = seededSample([...byArk.entries()].filter(([, en]) => en).map(([a]) => a), 2000, 7);
const withoutEn = seededSample([...byArk.entries()].filter(([, en]) => !en).map(([a]) => a), 2000, 8);
const order = [];
for (let i = 0; i < Math.max(withEn.length, withoutEn.length) && order.length < MAX_ATTEMPTS * 2; i++) {
  if (i < withEn.length) order.push(withEn[i]);
  if (i < withoutEn.length) order.push(withoutEn[i]);
}

const records = [];
let attempts = 0;
for (const ark of order) {
  if (records.length >= TARGET || attempts >= MAX_ATTEMPTS) break;
  attempts++;
  try {
    const j = await fetchRecord(ark);
    if (j.__status) continue;
    const r = toRecord(ark, j, byArk.get(ark));
    if (r) records.push(r);
    if (records.length % 25 === 0) console.log(`  ${records.length}/${TARGET} (attempts ${attempts})`);
  } catch (e) {
    console.warn(`ark ${ark}: ${e}`);
    await sleep(2000);
  }
}

// Prefer on-view records first in the final sample ordering (report slices by this).
records.sort((a, b) => Number(b.onView) - Number(a.onView) || a.ark.localeCompare(b.ark));
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), records }, null, 1));
console.log(
  `wrote ${records.length} records (${records.filter((r) => r.onView).length} on-view, ` +
    `${records.filter((r) => r.enLabel).length} with EN reference) -> ${OUT}`,
);
