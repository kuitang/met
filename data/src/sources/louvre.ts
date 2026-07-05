/**
 * Musée du Louvre source adapter (D6) — the fleet's first per-record-hydration
 * museum without a bulk search API: collections.louvre.fr serves one JSON
 * document per ark (no boolean on-view flag, no bulk on-view query), so
 * enumeration comes from the plan tool instead of the collection API.
 *
 * Enumeration (measured 2026-07-05): the public plan
 * (https://collections.louvre.fr/en/plan) loads one JSON per floor —
 * `/media/map/en/salles_{niveau}.json` for niveau in {-1,0,1,2} (a 3rd Rez-de-
 * chaussée-adjacent level, "-2", exists only as text inside a room's `etage`
 * label ["Niveaux -1 et -2"] — the file itself 404s, so floorOrder stops at
 * -1). Each floor JSON is `{ [internalRoomKey]: { nom, aile, etage, oeuvres:
 * [{ alias: "/en/ark:/53355/{ark}", ... }] } }` — this IS the on-view roster
 * (every listed ark is physically on display in that room), so hydrating
 * exactly these ~26.6k arks (measured) replaces the 480k-record sitemap crawl
 * the task forbids. Two structural quirks measured in the 391 raw room
 * entries: (a) one room ("Crypte d'Osiris", internal key 291598) is listed
 * verbatim-identically under two floor files because it physically spans two
 * levels — dedupe by internal key, first floor seen wins; (b) one salle
 * number ("186") is split across two internal keys/titles (two curatorial
 * sub-collections in one room) — dedupe by parsed gallery code, merging ark
 * sets and joining titles. After both dedupes: 389 galleries, 26,653 arks.
 *
 * Etiquette: collections.louvre.fr is NOT WAF-throttled like the Met (plain
 * per-object JSON, cache-control: public, no bot-block observed) but per-
 * record hydration at ~30k requests warrants real restraint regardless —
 * politeFetch paced at <=2 req/s with a custom research UA (robots.txt blocks
 * named AI crawlers from *image* extensions only; our custom UA + JSON
 * requests are outside every Disallow rule, but we still identify honestly).
 * Resumable via a per-ark ndjson cache (data/raw/louvre/objects-cache.ndjson,
 * gitignored) exactly like the Met's per-object hydration.
 *
 * Field mapping (per-record JSON has no explicit boolean/classification
 * schema like Met/AIC — French free text throughout, kept as-is per the
 * milestone's translation-gating decision):
 *   title            <- title (denominationTitle[0].value fallback)
 *   artist            <- creator[].label joined "; "
 *   culture           <- placeOfCreation (geographic/production-place free text)
 *   period            <- displayDateCreated (the "Epoque/période ... Date de
 *                        création/fabrication ..." composite string the site
 *                        itself displays — no separate machine period field)
 *   classification    <- objectType
 *   medium            <- materialsAndTechniques (newlines flattened)
 *   tags              <- every index[*][].value across all facets, deduped, '|'-joined
 *   accession         <- objectNumber's "Numéro principal" entry (fallback: first)
 *   galleryNumber/locationNote/site <- the plan membership map (NOT the
 *                        record's own free-text `room`/`currentLocation` —
 *                        those are for on-view/eyeballing only, e.g. the
 *                        Louvre's own copy has a doubled "Aile Aile Denon" typo)
 *   metadataDate      <- obj["modified "] (note: the API's own key has a
 *                        trailing space — verified byte-for-byte on-record)
 *   license / imageLicense <- "etalab-2.0" / "" always (restricted images; the
 *                        record has no machine image-rights field to gate on)
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

const BASE = "https://collections.louvre.fr";
const UA = "MuseWalk-research/0.1 (kuitang@gmail.com)";
const SITE = "louvre";
// Measured 2026-07-05: salles_{-1,0,1,2}.json are real; salles_-2.json 404s
// (the "-2" level only ever appears inside a room's free-text `etage` label).
const FLOORS = ["-1", "0", "1", "2"];

const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLAN_DIR = join(REPO_DATA, "raw", "louvre", "plan");
// Resume cache: one JSON line per processed ark, so an interrupted ~4-5h full
// hydration restarts where it left off (same convention as met.ts).
const RESUME_FILE = join(REPO_DATA, "raw", "louvre", "objects-cache.ndjson");

function client(maxAttempts: number) {
  return createPoliteClient({
    reqsPerSec: 2,
    concurrency: 2,
    maxAttempts,
    userAgent: UA,
    label: "louvre",
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RoomMeta {
  galleryNumber: string;
  wing: string;
  floor: string;
}

/**
 * "Salle 711 - Salle de la Joconde" -> "711"; "Salle 227 bis - ..." -> "227bis";
 * rooms with no "Salle N" prefix (stairwells, paliers, rotondes — measured 13
 * of 391) fall back to the plan's own internal numeric key so they still get
 * a stable, unique gallery row.
 */
function parseRoomCode(nom: string, internalKey: string): string {
  const m = nom.match(/^Salle\s+(\d+)(?:\s*(bis))?/i);
  return m ? m[1] + (m[2] ? "bis" : "") : internalKey;
}

/**
 * Fetch (or reuse the committed cache of) the per-floor plan JSONs and derive
 * ark -> room membership + gallery label rows. One-time-ETL discipline like
 * Living Map: raw responses are committed under data/raw/louvre/plan/ so this
 * never depends on collections.louvre.fr staying reachable, and delta() only
 * re-fetches when the cache is deliberately cleared.
 */
async function loadMembership(
  c: ReturnType<typeof client>,
  refetch: boolean,
): Promise<{ arkRoom: Map<string, RoomMeta>; galleries: GalleryLabelRow[] }> {
  mkdirSync(PLAN_DIR, { recursive: true });
  // Same physical room can be filed under >1 floor JSON (measured: "Crypte
  // d'Osiris", key 291598, is byte-identical under salles_-1 and salles_0
  // because it spans both levels) — dedupe by internal key, first floor wins.
  const seenKeys = new Set<string>();
  const byCode = new Map<
    string,
    { titles: Set<string>; wing: string; floor: string; arks: Set<string> }
  >();

  for (const floor of FLOORS) {
    const cachePath = join(PLAN_DIR, `salles_${floor}.json`);
    let salles: Record<string, { nom?: string; aile?: string; etage?: string; oeuvres?: Array<{ alias?: string }> }>;
    if (!refetch && existsSync(cachePath)) {
      salles = JSON.parse(readFileSync(cachePath, "utf8"));
    } else {
      salles = await c.fetchJson(`${BASE}/media/map/en/salles_${floor}.json`);
      writeFileSync(cachePath, JSON.stringify(salles, null, 2));
    }
    for (const [key, s] of Object.entries(salles)) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const code = parseRoomCode(s.nom ?? "", key);
      const entry = byCode.get(code) ?? {
        titles: new Set<string>(),
        wing: (s.aile ?? "").trim(),
        floor,
        arks: new Set<string>(),
      };
      if (s.nom) entry.titles.add(s.nom.trim());
      for (const o of s.oeuvres ?? []) {
        const m = o.alias?.match(/ark:\/53355\/(\w+)/);
        if (m) entry.arks.add(m[1]);
      }
      byCode.set(code, entry);
    }
  }

  const arkRoom = new Map<string, RoomMeta>();
  const galleries: GalleryLabelRow[] = [];
  for (const [code, e] of byCode) {
    galleries.push({ galleryNumber: code, site: SITE, title: [...e.titles].join(" / "), floor: e.floor });
    for (const ark of e.arks) arkRoom.set(ark, { galleryNumber: code, wing: e.wing, floor: e.floor });
  }
  return { arkRoom, galleries };
}

/** objectNumber: [{ value, type }]; prefer the "Numéro principal" entry. */
function accessionNumber(objectNumber: unknown): string {
  if (!Array.isArray(objectNumber) || !objectNumber.length) return "";
  const principal = objectNumber.find((n: any) => n?.type === "Numéro principal");
  return String((principal ?? objectNumber[0])?.value ?? "");
}

/** Flatten every faceted `index` value (material, objectType, period, place, …) into one bag. */
function flattenIndex(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const values = new Set<string>();
  for (const entries of Object.values(index as Record<string, Array<{ value?: string }>>)) {
    for (const e of entries ?? []) if (e?.value) values.add(String(e.value).trim());
  }
  return [...values].join("|");
}

function toRow(ark: string, room: RoomMeta, obj: any): ObjectRow {
  const title =
    String(obj.title ?? "").trim() ||
    String((Array.isArray(obj.denominationTitle) ? obj.denominationTitle[0]?.value : "") ?? "").trim();
  const artist = Array.isArray(obj.creator)
    ? obj.creator.map((cr: any) => cr?.label).filter(Boolean).join("; ")
    : "";
  const image = Array.isArray(obj.image) && obj.image.length ? obj.image[0] : null;
  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId: ark,
    accession: accessionNumber(obj.objectNumber),
    title,
    artist,
    culture: String(obj.placeOfCreation ?? "").trim(),
    period: String(obj.displayDateCreated ?? "").trim(),
    classification: String(obj.objectType ?? "").trim(),
    medium: String(obj.materialsAndTechniques ?? "").replace(/\r?\n/g, "; ").trim(),
    tags: flattenIndex(obj.index),
    galleryNumber: room.galleryNumber,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no highlight/boosted signal in the Louvre record
    imageUrl: String(image?.urlImage ?? image?.urlThumbnail ?? ""),
    metadataDate: String(obj["modified "] ?? "").trim(),
    locationNote: room.wing,
    license: "etalab-2.0",
    imageLicense: "", // restricted license — no derivative rights
  };
}

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const c = client(8);
  const t0 = Date.now();

  const { arkRoom, galleries } = await loadMembership(c, false);
  console.log(`louvre: ${galleries.length} salles, ${arkRoom.size} arks on view`);

  let arks = [...arkRoom.keys()];
  if (limit < arks.length) arks = arks.slice(0, limit);
  const arksSet = new Set(arks);

  mkdirSync(dirname(RESUME_FILE), { recursive: true });
  const rows: ObjectRow[] = [];
  let notFound = 0;

  // Resume: replay previously processed arks from the cache, hydrate only the rest.
  const seen = new Set<string>();
  if (existsSync(RESUME_FILE)) {
    for (const line of readFileSync(RESUME_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (seen.has(rec.sourceId)) continue;
      seen.add(rec.sourceId);
      if (rec.skip) notFound++;
      else rows.push(rec.row);
    }
    console.log(`resume: ${seen.size} already processed in ${RESUME_FILE}`);
  }
  const todo = arks.filter((a) => !seen.has(a));

  await c.pooledMap(todo, async (ark) => {
    const obj = await c.fetchJson(`${BASE}/ark:/53355/${ark}.json`);
    let rec: { sourceId: string; skip?: boolean; row?: ObjectRow };
    if (obj === null) {
      notFound++;
      rec = { sourceId: ark, skip: true };
    } else {
      const row = toRow(ark, arkRoom.get(ark)!, obj);
      rows.push(row);
      rec = { sourceId: ark, row };
    }
    appendFileSync(RESUME_FILE, JSON.stringify(rec) + "\n");
  });

  // Restrict to arks actually requested this run — the resume cache can carry
  // rows from a broader (or since-dropped-from-membership) prior run, e.g. a
  // --limit smoke test reusing a fuller cache, or a stale ark whose room fell
  // out of membership between runs. This also makes fullFetch() safe to call
  // repeatedly as a de-facto delta (tombstones off-view arks) even though the
  // dedicated delta() below is the intended nightly path.
  const finalRows = rows
    .filter((r) => arksSet.has(r.sourceId!))
    .sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));

  const meta = {
    fetchedAt: new Date().toISOString(),
    sallesListed: galleries.length,
    membershipArks: arkRoom.size,
    hydrated: arks.length,
    rows: finalRows.length,
    skipped: { notFound },
    distinctGalleryNumbers: new Set(finalRows.map((r) => r.galleryNumber)).size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    ...(limit < Infinity ? { partial: true, limit } : null),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify(galleries, null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("louvre meta:", JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Cheap re-pull of the salles JSON + hydrate only new arks + tombstone arks
 * that dropped out of membership (rotations, deaccessions since the last
 * build). Does NOT re-hydrate already-known arks' own metadata — the Louvre
 * has no bulk "changed since" endpoint like the Met's ?metadataDate=, so an
 * existing ark's title/medium/etc. only refreshes on its next appearance in a
 * from-scratch fullFetch (documented limitation, same shape as the gap AIC's
 * delta doesn't have because its whole on-view set is cheap to re-pull nightly).
 */
async function delta(snapDir: string, since: string): Promise<number> {
  const c = client(8);
  const snapPath = join(snapDir, "objects.json.gz");
  const known = new Map<string, ObjectRow>(
    (JSON.parse(gunzipSync(readFileSync(snapPath)).toString("utf8")) as ObjectRow[]).map((r) => [
      r.sourceId!,
      r,
    ]),
  );

  const { arkRoom, galleries } = await loadMembership(c, true);
  const todo = new Set<string>();
  for (const ark of arkRoom.keys()) if (!known.has(ark)) todo.add(ark);
  console.log(
    `louvre delta: ${arkRoom.size} on view (${galleries.length} salles), ${known.size} known, ${todo.size} new to hydrate (since ${since})`,
  );

  mkdirSync(dirname(RESUME_FILE), { recursive: true });
  await c.pooledMap([...todo], async (ark) => {
    const obj = await c.fetchJson(`${BASE}/ark:/53355/${ark}.json`);
    const row = obj === null ? null : toRow(ark, arkRoom.get(ark)!, obj);
    if (row) known.set(ark, row);
    appendFileSync(RESUME_FILE, JSON.stringify({ sourceId: ark, skip: !row, row: row ?? undefined }) + "\n");
  });

  // Refresh room membership for already-known arks (free — no extra requests).
  for (const [ark, row] of known) {
    const room = arkRoom.get(ark);
    if (room) {
      row.galleryNumber = room.galleryNumber;
      row.locationNote = room.wing;
    }
  }
  // Tombstone rows that fell off the on-view membership entirely.
  for (const ark of [...known.keys()]) if (!arkRoom.has(ark)) known.delete(ark);

  const rows = [...known.values()].sort((a, b) =>
    a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }),
  );
  writeFileSync(snapPath + ".tmp", gzipSync(JSON.stringify(rows)));
  renameSync(snapPath + ".tmp", snapPath);
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify(galleries, null, 2));
  writeFileSync(
    join(snapDir, "objects-meta.json"),
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        refreshedBy: "data/src/sources/louvre.ts#delta",
        membershipArks: arkRoom.size,
        hydrated: todo.size,
        rows: rows.length,
      },
      null,
      2,
    ),
  );
  return todo.size;
}

export const louvreSource: MuseumSource = { id: "louvre", fullFetch, delta };
