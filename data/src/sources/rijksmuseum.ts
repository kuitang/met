/**
 * Rijksmuseum (Amsterdam) source adapter (D9) — the fleet's first two-stage
 * enumerate-then-hydrate museum where BOTH stages hit different endpoints:
 * OAI-PMH (data.rijksmuseum.nl/oai, EDM/RDF-XML) enumerates the on-view id
 * set cheaply, then Linked Art JSON-LD (id.rijksmuseum.nl/{id}) resolves each
 * on-view id's room code + descriptive fields. See the spike report
 * data/evals/reports/rijksmuseum-spike.md for the original access-design
 * measurement; this header records what changed/was reconfirmed while
 * building the adapter (2026-07-06, same read-only politeness envelope).
 *
 * WHY TWO STAGES, NOT ONE: the classic collection API is HTTP 410 Gone and
 * the new Search API has no on-view/location filter. OAI-PMH's EDM record
 * carries `edm:currentLocation` — present ONLY for on-view objects, verified
 * live 8/8 in the spike and reconfirmed here — as a bare institution-Place
 * reference (no room code), so presence is just the on-view FLAG. The actual
 * room code only exists in the Linked Art JSON-LD's `current_location`
 * (`Accept: application/ld+json`). OAI's own record fields
 * (dcterms:medium/edm:type/dc:type/etc.) are mostly opaque AAT/internal-id
 * references with NO inline label in the OAI response, whereas Linked Art
 * resolves every reference to bilingual (nl+en) `notation`/`Name` text — so
 * Linked Art is also where all descriptive fields (title, artist, culture,
 * period, classification, medium) come from, not just the room code. OAI is
 * therefore used ONLY for enumeration (id, accession, datestamp, the
 * currentLocation flag, and the image url + rights the aggregation record
 * already carries) — never parsed for descriptive text.
 *
 * OAI-PMH pacing/scale (measured 2026-07-06): 50 records/page,
 * completeListSize 843,035 (grew from the spike's 837,654) => ~16,861 pages.
 * Resumption tokens are POSITION-encoded and idempotent — refetching the same
 * token returns the identical page (verified) — so the resumable state file
 * below just needs to persist "the token for the next unfetched page"; a
 * crash before that save merely re-processes (harmlessly, append+dedupe) the
 * last page. `from`/`until` genuinely filter (verified: a future `from`
 * yields `noRecordsMatch`), so nightly delta via from/until is sound.
 *
 * Linked Art `current_location` shape (verified live across 8 real on-view
 * records spanning all 3 sampled buildings — HG "Hoofdgebouw"/Main building,
 * TV "KPN-vleugel"/KPN Wing, AK not sampled but same schema expected):
 * `identified_by` is a small array mixing one `Identifier` (the code, e.g.
 * `"HG-2.16-02"`, decomposed into `part`s classified by Getty AAT concept ids
 * — building `aat:300004188` "HG", room `aat:300260522` "2.16", case
 * `aat:300240057` "02", case OPTIONAL) and two `Name` entries (nl + en, each
 * with `part`s for building/era/room labels — e.g. en room name "Medals").
 * Room codes are uniformly "{floor}.{room}" (2.16, 1.17, 0.10, 1.18, 1.4) —
 * floor is always the leading segment. galleryNumber is `{building}-{room}`
 * (NOT the full code with case) so multiple display cases in one room share
 * one gallery/room label; the case suffix (when present) goes to
 * locationNote instead — same room-vs-case-note split V&A uses.
 *
 * MEASURED GAP (not in the spike, found scanning 40 live OAI pages here):
 * OAI's `edm:currentLocation` flag is NOT 100% equivalent to "Linked Art has
 * a resolvable current_location" — 4 of 12 sampled on-view-flagged ids came
 * back with the field entirely absent from Linked Art. All 4 were
 * `part_of` a parent HumanMadeObject (a multi-piece accession, e.g.
 * BK-2024-8-1/BK-2024-8-2) — the location apparently lives on the PARENT,
 * not the child. We do not walk the part_of chain (adds a resolution hop for
 * a minority case); these resolve to `skip` and are excluded, counted in
 * objects-meta.json's `resolvedNoLocation`. The resolver still hard-fails
 * (throws) if fewer than 50% of the first 100 flagged-on-view ids resolve a
 * parseable code — that threshold is well below the ~67% we measured live,
 * so ordinary part_of noise passes but a genuine field-name/shape change
 * (the schema-migration caveat the spike flagged for ~June 2026) does not.
 *
 * Fields not covered by the spike, resolved live for this adapter:
 *   title       <- identified_by (top-level) Name, language nl, preferring
 *                  the entry classified as aat:300417207 (primary title)
 *   artist      <- produced_by.part[].carried_out_by[].notation (falls back
 *                  to produced_by.carried_out_by directly when there's no
 *                  `.part` — simple/unattributed productions, e.g. coins,
 *                  skip `.part` entirely per Linked Art convention)
 *   culture     <- produced_by.part[].took_place_at[].notation (place of
 *                  production; often nl-only, no en counterpart — kept as-is)
 *   period      <- produced_by.timespan identified_by Name (en preferred),
 *                  falling back to timespan.begin_of_the_begin's year
 *   classification <- top-level classified_as entries sub-classified
 *                  "Type of Work" (aat:300435443), notation (en preferred)
 *   medium      <- made_of[].notation (en preferred); tags <- produced_by.
 *                  technique[].notation (en preferred) — UNLIKE Louvre/V&A,
 *                  these come pre-resolved bilingual from the source, so no
 *                  DeepSeek vocab translation is needed for them (a real cost
 *                  savings vs. Louvre's all-French records) — only the
 *                  curatorial `title` stays Dutch and routes through
 *                  translate.ts (registry `translateFrom: "nl"`).
 *   image/rights <- captured during the OAI stage itself: edm:isShownBy (IIIF
 *                  url) + edm:rights (a rightsstatements.org/creativecommons
 *                  URI already present on the SAME aggregation record) — no
 *                  extra Linked Art digging needed. Per spike + task design,
 *                  imageUrl/imageLicense are populated ONLY when the rights
 *                  URI is a CC0 or Public Domain Mark statement; anything
 *                  else (in-copyright, unclear) ships neither (see
 *                  classifyRights below) — same "no derivatives without a
 *                  clear grant" policy as NGA/V&A.
 *   license     <- registry default "CC0-1.0" (NOT per-record from Linked
 *                  Art). Live-checked (2026-07-06) instead of a prose terms
 *                  page: every sampled record's `subject_of` entry keyed to
 *                  its `data.rijksmuseum.nl/{id}` metadata node carries
 *                  `subject_to: [{classified_as: [creativecommons.org/
 *                  publicdomain/zero]}]` — i.e. the METADATA (not the image)
 *                  is CC0 on every record sampled, matching the spike's
 *                  "CC0-leaning" characterization. No per-record override is
 *                  implemented (same flat-license convention as Louvre).
 *
 * Etiquette: both stages share one `politeFetch` client at <=1.2 req/s (the
 * spike's ceiling) with the same research UA as every other adapter. The OAI
 * stage pages sequentially (each page's URL depends on the prior page's
 * resumptionToken, so it cannot use the pooled/concurrent mapper) with a
 * manual pacer; the Linked Art stage resolves independent ids and DOES use
 * `pooledMap` (concurrency 2).
 *
 * Resume/scale: full OAI harvest is ~16.8k sequential requests (~4h @
 * 1.2 req/s) persisted to data/raw/rijksmuseum/{oai-state.json,
 * onview-ids.ndjson} (gitignored, re-fetchable); Linked Art resolution of the
 * ~8-9k on-view ids (~2h @ 1.2 req/s, pooled) persists to
 * data/raw/rijksmuseum/objects-cache.ndjson (same convention as Louvre/Met).
 * A `--limit N` smoke run pauses (does not mark `done`) once N on-view
 * candidates are found, so a later unlimited run resumes and continues past
 * exactly where the smoke run stopped — no wasted requests.
 *
 * Delta: OAI `ListRecords` scoped to `from`/`until` since the last run finds
 * every record touched in the window. Only records that (re-)gained
 * `edm:currentLocation` need a Linked Art re-fetch; records the OAI stage
 * itself shows have LOST the flag are tombstoned directly (no extra
 * request); OAI `status="deleted"` (repo `deletedRecord=persistent`)
 * tombstones by looking up the numeric id in the objects-cache ndjson to
 * recover its sourceId (accession).
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPoliteClient } from "../lib/politeFetch.ts";
import { buildVocab } from "../lib/vocab.ts";
import type { FullFetchOptions, GalleryLabelRow, MuseumSource, ObjectRow } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const OAI = "https://data.rijksmuseum.nl/oai";
const LOD = "https://id.rijksmuseum.nl"; // Linked Art JSON-LD resolver
const UA = "MuseWalk-research/0.1 (kuitang@gmail.com)";
const SITE = "rijksmuseum";
const REQS_PER_SEC = 1.2; // spike-measured politeness ceiling, shared by both stages

const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_DIR = join(REPO_DATA, "raw", "rijksmuseum");
const OAI_STATE_FILE = join(RAW_DIR, "oai-state.json");
const ONVIEW_IDS_FILE = join(RAW_DIR, "onview-ids.ndjson");
const RESUME_FILE = join(RAW_DIR, "objects-cache.ndjson");

// Getty AAT concept ids used throughout current_location / identified_by parsing (verified live 2026-07-06).
const AAT = {
  LANG_NL: "300388256",
  LANG_EN: "300388277",
  BUILDING: "300004188",
  ROOM: "300260522",
  CASE: "300240057",
  PRIMARY_TITLE: "300417207",
  TYPE_OF_WORK: "300435443",
  OBJECT_NUMBER: "300312355",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(maxAttempts: number, headers?: Record<string, string>) {
  return createPoliteClient({
    reqsPerSec: REQS_PER_SEC,
    concurrency: 2,
    maxAttempts,
    userAgent: UA,
    headers,
    label: "rijksmuseum",
  });
}

/* ------------------------------------------------------------------------ *
 * Stage 1: OAI-PMH enumeration — on-view id list + image/rights only.
 * ------------------------------------------------------------------------ */

interface OaiRecord {
  id: string; // numeric id.rijksmuseum.nl id (from the header's <identifier> URL)
  sourceId: string; // dc:identifier — the classic accession ("SK-C-1726")
  datestamp: string;
  deleted: boolean;
  hasLocation: boolean;
  imageUrl: string;
  rightsUri: string;
}

interface OaiPage {
  records: OaiRecord[];
  token: string | null;
  noRecordsMatch: boolean;
  completeListSize: number | null;
}

/**
 * Minimal, purpose-built OAI-PMH/EDM record splitter. We only need 6 leaf
 * facts per record (numeric id, accession, datestamp, deleted flag,
 * currentLocation presence, image url + rights) plus the page's
 * resumptionToken — a full XML parser/dependency isn't warranted for that
 * (see politeFetch.fetchText, added for this adapter). Throws on structural
 * surprises rather than silently emitting an empty/degraded page — the
 * spike's flagged risk is exactly this kind of drift.
 */
function parseOaiPage(xml: string): OaiPage {
  const errM = /<error code="([^"]+)">([^<]*)<\/error>/.exec(xml);
  if (errM) {
    if (errM[1] === "noRecordsMatch") return { records: [], token: null, noRecordsMatch: true, completeListSize: null };
    throw new Error(`rijksmuseum OAI error ${errM[1]}: ${errM[2]}`);
  }
  const clSizeM = /completeListSize="(\d+)"/.exec(xml);
  const records: OaiRecord[] = [];
  const recordRe = /<record>([\s\S]*?)<\/record>/g;
  let m: RegExpExecArray | null;
  while ((m = recordRe.exec(xml))) {
    const block = m[1];
    const headerM = /<header(\s[^>]*)?>([\s\S]*?)<\/header>/.exec(block);
    if (!headerM) {
      throw new Error(
        "rijksmuseum OAI: record missing <header> — schema may have changed (see data/evals/reports/rijksmuseum-spike.md caveat)",
      );
    }
    const deleted = /status\s*=\s*"deleted"/i.test(headerM[1] ?? "");
    const idM = /<identifier>([^<]+)<\/identifier>/.exec(headerM[2]);
    const dsM = /<datestamp>([^<]+)<\/datestamp>/.exec(headerM[2]);
    if (!idM || !dsM) {
      throw new Error(
        "rijksmuseum OAI: record header missing identifier/datestamp — schema may have changed (see data/evals/reports/rijksmuseum-spike.md caveat)",
      );
    }
    const id = idM[1].trim().split("/").pop()!;
    if (deleted) {
      records.push({ id, sourceId: "", datestamp: dsM[1], deleted: true, hasLocation: false, imageUrl: "", rightsUri: "" });
      continue;
    }
    const dcIdM = /<dc:identifier>([^<]+)<\/dc:identifier>/.exec(block);
    const isShownByM = /<edm:isShownBy rdf:resource="([^"]+)"/.exec(block);
    const rightsM = /<edm:rights rdf:resource="([^"]+)"/.exec(block);
    records.push({
      id,
      sourceId: dcIdM?.[1]?.trim() ?? "",
      datestamp: dsM[1],
      deleted: false,
      hasLocation: /<edm:currentLocation\b/.test(block),
      imageUrl: isShownByM?.[1] ?? "",
      rightsUri: rightsM?.[1] ?? "",
    });
  }
  const tokM = /<resumptionToken(?:\s[^>]*)?>([^<]*)<\/resumptionToken>/.exec(xml);
  const token = tokM && tokM[1] ? tokM[1] : null;
  return { records, token, noRecordsMatch: false, completeListSize: clSizeM ? Number(clSizeM[1]) : null };
}

/** Fail loudly on structural drift; tolerate a genuinely-empty delta window. */
function validateFirstPage(xml: string, records: OaiRecord[], opts: { allowEmpty?: boolean } = {}): void {
  if (!/xmlns:edm=/.test(xml)) {
    throw new Error(
      "rijksmuseum OAI: response no longer declares the edm: namespace — schema may have changed (see data/evals/reports/rijksmuseum-spike.md caveat)",
    );
  }
  if (!records.length) {
    if (opts.allowEmpty) return;
    throw new Error("rijksmuseum OAI: first page returned zero records — schema or endpoint may have changed");
  }
  if (!records.some((r) => !r.deleted)) {
    throw new Error("rijksmuseum OAI: first page contained only deleted-status records — unexpected for a fresh harvest");
  }
}

interface OaiState {
  token: string | null; // token for the NEXT unfetched page; null + pagesProcessed 0 = not started
  pagesProcessed: number;
  recordsScanned: number;
  onViewFound: number;
  completeListSize: number | null;
  done: boolean;
}

function loadOaiState(): OaiState {
  return existsSync(OAI_STATE_FILE)
    ? JSON.parse(readFileSync(OAI_STATE_FILE, "utf8"))
    : { token: null, pagesProcessed: 0, recordsScanned: 0, onViewFound: 0, completeListSize: null, done: false };
}

/**
 * Full historical harvest (no from/until — the whole 843k+-record corpus),
 * resumable via OAI_STATE_FILE + ONVIEW_IDS_FILE. Stops (without marking
 * `done`) once `limit` on-view candidates are found, so a later unlimited
 * call resumes and keeps going past exactly where this one stopped.
 */
async function harvestFullOnView(
  limit: number,
): Promise<{ candidates: OnViewCandidate[]; pagesProcessed: number; recordsScanned: number; completeListSize: number | null }> {
  mkdirSync(RAW_DIR, { recursive: true });
  const c = client(8);
  const state = loadOaiState();

  const candidates = new Map<string, OnViewCandidate>();
  if (existsSync(ONVIEW_IDS_FILE)) {
    for (const line of readFileSync(ONVIEW_IDS_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      if (rec.deleted) candidates.delete(rec.id);
      else candidates.set(rec.id, rec);
    }
    console.log(`rijksmuseum OAI: resuming — ${candidates.size} on-view candidates already found (${state.pagesProcessed} pages processed)`);
  }

  if (!state.done && candidates.size < limit) {
    let nextUrl =
      state.pagesProcessed === 0
        ? `${OAI}?${new URLSearchParams({ verb: "ListRecords", metadataPrefix: "edm" })}`
        : `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(state.token!)}`;
    let firstPageValidated = state.pagesProcessed > 0; // only validate a genuinely fresh harvest's first page

    while (candidates.size < limit) {
      if (state.pagesProcessed > 0 || nextUrl.includes("resumptionToken")) await sleep(1000 / REQS_PER_SEC);
      const xml = await c.fetchText(nextUrl);
      if (xml === null) throw new Error(`rijksmuseum OAI: unexpected 404 for ${nextUrl}`);
      const page = parseOaiPage(xml);
      if (!firstPageValidated) {
        validateFirstPage(xml, page.records);
        firstPageValidated = true;
      }
      if (page.noRecordsMatch) {
        state.done = true;
        break;
      }
      state.pagesProcessed++;
      state.recordsScanned += page.records.length;
      if (page.completeListSize) state.completeListSize = page.completeListSize;

      for (const r of page.records) {
        if (r.deleted) {
          candidates.delete(r.id);
          appendFileSync(ONVIEW_IDS_FILE, JSON.stringify({ id: r.id, deleted: true }) + "\n");
          continue;
        }
        if (r.hasLocation) {
          const cand: OnViewCandidate = { id: r.id, sourceId: r.sourceId, datestamp: r.datestamp, imageUrl: r.imageUrl, rightsUri: r.rightsUri };
          candidates.set(r.id, cand);
          appendFileSync(ONVIEW_IDS_FILE, JSON.stringify(cand) + "\n");
          state.onViewFound++;
        }
      }
      writeFileSync(OAI_STATE_FILE, JSON.stringify(state));
      if (state.pagesProcessed % 200 === 0) {
        const pct = state.completeListSize ? (((state.pagesProcessed * 50) / state.completeListSize) * 100).toFixed(1) : "?";
        console.log(`rijksmuseum OAI: ${state.pagesProcessed} pages, ${state.recordsScanned} scanned (${pct}%), ${candidates.size} on-view found`);
      }
      if (!page.token) {
        state.done = true;
        writeFileSync(OAI_STATE_FILE, JSON.stringify(state));
        break;
      }
      state.token = page.token;
      nextUrl = `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(page.token)}`;
    }
  }

  const arr = [...candidates.values()];
  return {
    candidates: limit < Infinity ? arr.slice(0, limit) : arr,
    pagesProcessed: state.pagesProcessed,
    recordsScanned: state.recordsScanned,
    completeListSize: state.completeListSize,
  };
}

/**
 * Bounded delta window (from/until) — no resume-file persistence (a nightly
 * window is small/fast; a crash just reruns the whole window next time).
 * Splits results into: candidates needing a Linked Art re-fetch (gained or
 * still-has the on-view flag), off-view sourceIds we can tombstone directly
 * (OAI itself shows the flag is gone — no need to hit Linked Art at all),
 * and OAI-deleted numeric ids (need an objects-cache lookup to tombstone).
 */
async function harvestWindowOnView(
  from: string,
  until: string,
): Promise<{ candidates: OnViewCandidate[]; touchedOffViewSourceIds: Set<string>; deletedIds: Set<string> }> {
  const c = client(8);
  const candidates: OnViewCandidate[] = [];
  const touchedOffViewSourceIds = new Set<string>();
  const deletedIds = new Set<string>();
  let url: string | null = `${OAI}?${new URLSearchParams({ verb: "ListRecords", metadataPrefix: "edm", from, until })}`;
  let pages = 0;
  while (url) {
    if (pages > 0) await sleep(1000 / REQS_PER_SEC);
    const xml = await c.fetchText(url);
    if (xml === null) throw new Error(`rijksmuseum OAI: unexpected 404 for ${url}`);
    const page = parseOaiPage(xml);
    if (pages === 0) validateFirstPage(xml, page.records, { allowEmpty: true });
    pages++;
    if (page.noRecordsMatch) break;
    for (const r of page.records) {
      if (r.deleted) {
        deletedIds.add(r.id);
        continue;
      }
      if (r.hasLocation) {
        candidates.push({ id: r.id, sourceId: r.sourceId, datestamp: r.datestamp, imageUrl: r.imageUrl, rightsUri: r.rightsUri });
      } else if (r.sourceId) {
        touchedOffViewSourceIds.add(r.sourceId);
      }
    }
    url = page.token ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(page.token)}` : null;
  }
  return { candidates, touchedOffViewSourceIds, deletedIds };
}

/* ------------------------------------------------------------------------ *
 * Stage 2: Linked Art JSON-LD resolution — room code + descriptive fields.
 * ------------------------------------------------------------------------ */

interface OnViewCandidate {
  id: string;
  sourceId: string;
  datestamp: string;
  imageUrl: string;
  rightsUri: string;
}

interface CurrentLocationInfo {
  buildingCode: string; // "HG" | "AK" | "TV"
  roomCode: string; // "2.16"
  caseCode: string; // "" | "02" | "Z9.01"
  fullCode: string; // "HG-2.16-02"
  nameEn: string; // "Medals"
  nameNl: string; // "Penningen"
  buildingNameEn: string; // "Main building" | "KPN Wing" | ...
}

const asArray = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : []);
const aatId = (url?: string): string => (url ? url.split("/").pop() ?? "" : "");

/** {@language,@value} notation arrays (technique/material/classification) — prefer English, else the first. */
function notationText(notation: any): string {
  const arr = asArray(notation);
  const hit = arr.find((n: any) => n?.["@language"] === "en") ?? arr[0];
  return String(hit?.["@value"] ?? "").trim();
}

/** {content, language:[{id}]} Name entries (titles/timespans) — pick by AAT language id. */
function pickByLang(entries: any[], langAat: string): any {
  return entries.find((e) => aatId(e.language?.[0]?.id) === langAat);
}

function parseCurrentLocation(cl: any): CurrentLocationInfo | null {
  if (!cl || !Array.isArray(cl.identified_by)) return null;
  let buildingCode = "";
  let roomCode = "";
  let caseCode = "";
  let fullCode = "";
  let nameEn = "";
  let nameNl = "";
  let buildingNameEn = "";
  for (const entry of cl.identified_by) {
    if (entry.type === "Identifier") {
      fullCode = entry.content ?? fullCode;
      for (const p of asArray(entry.part)) {
        const aat = aatId(p.classified_as?.[0]?.id);
        if (aat === AAT.ROOM) roomCode = p.content ?? roomCode;
        else if (aat === AAT.BUILDING) buildingCode = p.content ?? buildingCode;
        else if (aat === AAT.CASE) caseCode = p.content ?? caseCode;
      }
    } else if (entry.type === "Name") {
      const langId = aatId(entry.language?.[0]?.id);
      if (langId !== AAT.LANG_EN && langId !== AAT.LANG_NL) continue;
      let roomName = "";
      let buildingName = "";
      for (const p of asArray(entry.part)) {
        const aat = aatId(p.classified_as?.[0]?.id);
        if (aat === AAT.ROOM) roomName = p.content ?? roomName;
        else if (aat === AAT.BUILDING) buildingName = p.content ?? buildingName;
      }
      if (langId === AAT.LANG_EN) {
        nameEn = roomName || nameEn;
        buildingNameEn = buildingName || buildingNameEn;
      } else {
        nameNl = roomName || nameNl;
      }
    }
  }
  if (!roomCode) return null; // no parseable room -> not placeable (see part_of-child gap in the header doc comment)
  return {
    buildingCode,
    roomCode,
    caseCode,
    fullCode: fullCode || [buildingCode, roomCode, caseCode].filter(Boolean).join("-"),
    nameEn,
    nameNl,
    buildingNameEn,
  };
}

function pickTitle(la: any): string {
  const names = asArray(la.identified_by).filter((e: any) => e.type === "Name");
  const nlNames = names.filter((e: any) => aatId(e.language?.[0]?.id) === AAT.LANG_NL);
  const primary = nlNames.find((e: any) => asArray(e.classified_as).some((c: any) => aatId(c.id) === AAT.PRIMARY_TITLE));
  return String((primary ?? nlNames[0])?.content ?? "").trim();
}

function fallbackAccession(la: any): string {
  const ids = asArray(la.identified_by).filter((e: any) => e.type === "Identifier");
  const objNum = ids.find((e: any) => asArray(e.classified_as).some((c: any) => aatId(c.id) === AAT.OBJECT_NUMBER));
  return String((objNum ?? ids[0])?.content ?? "").trim();
}

/** Linked Art groups per-agent/per-place sub-events under produced_by.part[]; simple (unattributed) productions skip `.part` entirely. */
function productionEvents(la: any): any[] {
  const top = la.produced_by;
  if (!top) return [];
  return asArray(top.part).length ? asArray(top.part) : [top];
}

function pickArtist(la: any): string {
  const names = productionEvents(la)
    .flatMap((p) => asArray(p.carried_out_by))
    .map((a) => notationText(a.notation))
    .filter(Boolean);
  return [...new Set(names)].join("; ");
}

function pickCulture(la: any): string {
  const places = productionEvents(la)
    .flatMap((p) => asArray(p.took_place_at))
    .map((p) => notationText(p.notation))
    .filter(Boolean);
  return [...new Set(places)].join("; ");
}

function pickPeriod(la: any): string {
  const ts = la.produced_by?.timespan;
  if (!ts) return "";
  const names = asArray(ts.identified_by).filter((e: any) => e.type === "Name");
  const preferred = pickByLang(names, AAT.LANG_EN) ?? names[0];
  if (preferred?.content) return String(preferred.content).trim();
  return String(ts.begin_of_the_begin ?? "").slice(0, 4);
}

function pickClassification(la: any): string {
  const all = asArray(la.classified_as);
  const typed = all.filter((e: any) => asArray(e.classified_as).some((c: any) => aatId(c.id) === AAT.TYPE_OF_WORK));
  const use = typed.length ? typed : all;
  return [...new Set(use.map((e: any) => notationText(e.notation)).filter(Boolean))].join("; ");
}

function pickMedium(la: any): string {
  return [...new Set(asArray(la.made_of).map((e: any) => notationText(e.notation)).filter(Boolean))].join("; ");
}

function pickTags(la: any): string {
  return [...new Set(asArray(la.produced_by?.technique).map((e: any) => notationText(e.notation)).filter(Boolean))].join("|");
}

/** Only CC0/Public-Domain-Mark rights ship an image derivative; anything else (in-copyright, unclear) ships neither. */
function classifyRights(uri: string): { imageLicense: string; allowImage: boolean } {
  if (uri.includes("publicdomain/zero")) return { imageLicense: "CC0-1.0", allowImage: true };
  if (uri.includes("publicdomain/mark")) return { imageLicense: "PDM-1.0", allowImage: true };
  return { imageLicense: "", allowImage: false };
}

function toRow(cand: OnViewCandidate, la: any, loc: CurrentLocationInfo): ObjectRow {
  const rights = classifyRights(cand.rightsUri);
  const sourceId = cand.sourceId || fallbackAccession(la);
  return {
    objectID: 0, // assigned by build-db (48-bit hash of museum/sourceId)
    sourceId,
    accession: sourceId,
    title: pickTitle(la),
    artist: pickArtist(la),
    culture: pickCulture(la),
    period: pickPeriod(la),
    classification: pickClassification(la),
    medium: pickMedium(la),
    tags: pickTags(la),
    galleryNumber: `${loc.buildingCode}-${loc.roomCode}`,
    site: SITE,
    rotation: "permanent",
    isHighlight: false, // no curated-highlight signal in this record shape
    imageUrl: rights.allowImage ? cand.imageUrl : "",
    metadataDate: cand.datestamp,
    locationNote: [loc.buildingCode !== "HG" ? loc.buildingNameEn : "", loc.caseCode ? `Case ${loc.caseCode}` : ""]
      .filter(Boolean)
      .join(", "),
    imageLicense: rights.imageLicense,
  };
}

interface CacheRec {
  id: string;
  skip: boolean;
  row?: ObjectRow;
  galleryTitle?: string;
  galleryFloor?: string;
}

/**
 * Resolves each candidate's Linked Art record, resumable via RESUME_FILE
 * (skips already-cached ids unless `forceRefresh`, which delta uses since a
 * candidate showing up in a delta window means it changed). Validates the
 * first 100 freshly-resolved records against the >=50% parseable-location
 * threshold documented in the header comment; throws rather than shipping a
 * degraded snapshot if the Linked Art shape has genuinely moved.
 */
async function resolveCandidates(
  candidates: OnViewCandidate[],
  opts: { forceRefresh?: boolean } = {},
): Promise<{ rows: ObjectRow[]; galleries: Map<string, GalleryLabelRow>; skipped: number }> {
  mkdirSync(RAW_DIR, { recursive: true });
  const c = client(8, { Accept: "application/ld+json" });

  const known = new Map<string, CacheRec>();
  if (existsSync(RESUME_FILE)) {
    for (const line of readFileSync(RESUME_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec: CacheRec = JSON.parse(line);
      known.set(rec.id, rec);
    }
    console.log(`rijksmuseum resolve: resuming, ${known.size} already processed in ${RESUME_FILE}`);
  }

  const todo = opts.forceRefresh ? candidates : candidates.filter((cand) => !known.has(cand.id));
  let validated = 0;
  let validPlaceable = 0;

  await c.pooledMap(todo, async (cand) => {
    const la = await c.fetchJson(`${LOD}/${cand.id}`);
    let rec: CacheRec;
    if (la === null) {
      rec = { id: cand.id, skip: true };
    } else {
      const loc = parseCurrentLocation(la.current_location);
      if (validated < 100) {
        validated++;
        if (loc) validPlaceable++;
        if (validated === 100 && validPlaceable / validated < 0.5) {
          throw new Error(
            `rijksmuseum: only ${validPlaceable}/${validated} resolved on-view records carried a parseable current_location — ` +
              "the Linked Art schema may have changed (see data/evals/reports/rijksmuseum-spike.md caveat). " +
              "Aborting rather than shipping an empty/degraded snapshot.",
          );
        }
      }
      if (!loc) {
        rec = { id: cand.id, skip: true };
      } else {
        const row = toRow(cand, la, loc);
        rec = { id: cand.id, skip: false, row, galleryTitle: loc.nameEn || loc.nameNl || loc.fullCode, galleryFloor: loc.roomCode.split(".")[0] };
      }
    }
    appendFileSync(RESUME_FILE, JSON.stringify(rec) + "\n");
    known.set(cand.id, rec);
  });

  const rows: ObjectRow[] = [];
  const galleries = new Map<string, GalleryLabelRow>();
  let skipped = 0;
  for (const cand of candidates) {
    const rec = known.get(cand.id);
    if (!rec || rec.skip || !rec.row) {
      skipped++;
      continue;
    }
    rows.push(rec.row);
    if (!galleries.has(rec.row.galleryNumber)) {
      galleries.set(rec.row.galleryNumber, {
        galleryNumber: rec.row.galleryNumber,
        site: SITE,
        title: rec.galleryTitle || rec.row.galleryNumber,
        floor: rec.galleryFloor,
      });
    }
  }
  return { rows, galleries, skipped };
}

/* ------------------------------------------------------------------------ *
 * MuseumSource
 * ------------------------------------------------------------------------ */

async function fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>> {
  const { snapDir, limit = Infinity } = opts;
  const t0 = Date.now();

  const harvest = await harvestFullOnView(limit);
  console.log(
    `rijksmuseum OAI: ${harvest.pagesProcessed} pages, ${harvest.recordsScanned} scanned, ${harvest.candidates.length} on-view candidates ` +
      `(completeListSize ${harvest.completeListSize ?? "?"})`,
  );

  const { rows, galleries, skipped } = await resolveCandidates(harvest.candidates);
  const finalRows = rows.sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));

  const meta = {
    fetchedAt: new Date().toISOString(),
    oaiPagesProcessed: harvest.pagesProcessed,
    oaiRecordsScanned: harvest.recordsScanned,
    oaiCompleteListSize: harvest.completeListSize,
    onViewCandidates: harvest.candidates.length,
    resolvedNoLocation: skipped,
    rows: finalRows.length,
    distinctGalleryNumbers: galleries.size,
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
    ...(limit < Infinity ? { partial: true, limit } : null),
  };

  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "objects.json.gz"), gzipSync(JSON.stringify(finalRows)));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(finalRows), null, 2));
  writeFileSync(join(snapDir, "galleries.json"), JSON.stringify([...galleries.values()], null, 2));
  writeFileSync(join(snapDir, "objects-meta.json"), JSON.stringify(meta, null, 2));
  console.log("rijksmuseum meta:", JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Nightly incremental: OAI from/until since the last run. See
 * harvestWindowOnView's doc comment for how gained/lost/deleted records are
 * routed — only gained/still-on-view candidates cost a Linked Art request.
 */
async function delta(snapDir: string, since: string): Promise<number> {
  const snapPath = join(snapDir, "objects.json.gz");
  const bySourceId = new Map<string, ObjectRow>(
    (JSON.parse(gunzipSync(readFileSync(snapPath)).toString("utf8")) as ObjectRow[]).map((r) => [r.sourceId!, r]),
  );
  const galleriesPath = join(snapDir, "galleries.json");
  const galleries = new Map<string, GalleryLabelRow>(
    (existsSync(galleriesPath) ? (JSON.parse(readFileSync(galleriesPath, "utf8")) as GalleryLabelRow[]) : []).map((g) => [
      g.galleryNumber,
      g,
    ]),
  );

  const until = new Date().toISOString();
  const { candidates, touchedOffViewSourceIds, deletedIds } = await harvestWindowOnView(since, until);
  console.log(
    `rijksmuseum delta: window ${since}..${until}, ${candidates.length} candidates to re-resolve, ` +
      `${touchedOffViewSourceIds.size} dropped off-view, ${deletedIds.size} OAI-tombstoned`,
  );

  let refreshed = 0;
  let droppedFromView = 0;
  if (candidates.length) {
    const res = await resolveCandidates(candidates, { forceRefresh: true });
    const resolvedSourceIds = new Set(res.rows.map((r) => r.sourceId));
    for (const row of res.rows) bySourceId.set(row.sourceId!, row);
    for (const [k, v] of res.galleries) galleries.set(k, v);
    refreshed = res.rows.length;
    droppedFromView = res.skipped;
    for (const cand of candidates) {
      if (cand.sourceId && !resolvedSourceIds.has(cand.sourceId)) bySourceId.delete(cand.sourceId);
    }
  }
  for (const sourceId of touchedOffViewSourceIds) bySourceId.delete(sourceId);

  if (deletedIds.size && existsSync(RESUME_FILE)) {
    const cacheById = new Map<string, string>();
    for (const line of readFileSync(RESUME_FILE, "utf8").split("\n")) {
      if (!line) continue;
      const rec: CacheRec = JSON.parse(line);
      if (rec.row?.sourceId) cacheById.set(rec.id, rec.row.sourceId);
    }
    for (const id of deletedIds) {
      const sid = cacheById.get(id);
      if (sid) bySourceId.delete(sid);
    }
  }

  const rows = [...bySourceId.values()].sort((a, b) => a.sourceId!.localeCompare(b.sourceId!, undefined, { numeric: true }));
  writeFileSync(snapPath + ".tmp", gzipSync(JSON.stringify(rows)));
  renameSync(snapPath + ".tmp", snapPath);

  const liveGalleryNumbers = new Set(rows.map((r) => r.galleryNumber));
  const finalGalleries = [...galleries.values()].filter((g) => liveGalleryNumbers.has(g.galleryNumber));
  writeFileSync(galleriesPath, JSON.stringify(finalGalleries, null, 2));
  writeFileSync(join(snapDir, "vocab.json"), JSON.stringify(buildVocab(rows), null, 2));
  writeFileSync(
    join(snapDir, "objects-meta.json"),
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        refreshedBy: "data/src/sources/rijksmuseum.ts#delta",
        windowSince: since,
        windowUntil: until,
        touchedCandidates: candidates.length,
        refreshed,
        droppedFromView,
        oaiTombstoned: deletedIds.size,
        rows: rows.length,
      },
      null,
      2,
    ),
  );
  return refreshed;
}

export const rijksmuseumSource: MuseumSource = { id: "rijksmuseum", fullFetch, delta };
