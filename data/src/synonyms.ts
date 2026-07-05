/**
 * Index-time synonym expansion (gate-review approved search upgrade).
 *
 * flash-lite batch over (a) every distinct culture / period / classification
 * value and (b) distinct object titles in the "failing categories" — the
 * antiquities classifications where the Gate C golden eval measured
 * catalog-vocabulary leaps (e.g. "Bronze statuette of a Lar" vs. a visitor's
 * "roman household god", "mesopotamia" vs. cultures Assyrian/Babylonian/
 * Sumerian/ancient Iran). Output: data/snapshots/synonyms.json, consumed by
 * build-db.ts into the FTS-indexed `synonyms` column.
 *
 *   { vocab:  { "<culture|period|classification>": "space-joined terms" },
 *     titles: { "<exact title>": "space-joined terms" } }
 *
 * CACHED/INCREMENTAL: existing keys in synonyms.json are never re-queried, so
 * the nightly refresh re-run only pays for values new to the catalog (~$0).
 *
 * Usage (Node 24, GEMINI_API_KEY set):
 *   npx tsx data/src/synonyms.ts                 # values+titles from snapshots/objects.json.gz
 *   npx tsx data/src/synonyms.ts --museum vanda  # another museum's snapshot dir (registry snapDirFor)
 *   npx tsx data/src/synonyms.ts --db x.sqlite   # harvest from a met.sqlite instead/in addition
 *   MET_DATA_DIR=/data ...                       # same root override as build-db.ts
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { z } from "zod";
import { museumInfo } from "./sources/registry.ts";

const DATA_DIR = process.env.MET_DATA_DIR
  ? path.resolve(process.env.MET_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const museumIdx = process.argv.indexOf("--museum");
const MUSEUM_ID = museumIdx >= 0 ? process.argv[museumIdx + 1] : "met";
const MUSEUM_NAME = museumInfo(MUSEUM_ID).name;
// Same per-museum layout as registry.snapDirFor, anchored on DATA_DIR so
// MET_DATA_DIR keeps working for the nightly stage dir.
const SNAP_DIR =
  MUSEUM_ID === "met"
    ? path.join(DATA_DIR, "snapshots")
    : path.join(DATA_DIR, "museums", MUSEUM_ID, "snapshots");
const OUT_PATH = path.join(SNAP_DIR, "synonyms.json");

const MODEL = "gemini-3.1-flash-lite";
const BATCH = 40;
const CONCURRENCY = 6;

/** Classifications whose golden-eval failures motivated title-level synonyms.
 * Met: Greek/Roman + Ancient Near East antiquities, where catalog titles use
 * specialist vocabulary (Lar, kylix, situla...) visitors don't type.
 * AIC: golden misses were plain-English *descriptions* of famous paintings
 * ("lonely diner at night" -> Nighthawks, "farmer and woman with a
 * pitchfork" -> American Gothic) — AIC's classification vocabulary is
 * per-object free text (not the Met's controlled department taxonomy), so
 * the override matches on substring, not `^`-anchor. Measured against
 * data/museums/aic/snapshots/objects.json.gz: 347 distinct titles (of 3,510
 * objects) — American Gothic ("oil paintings (visual works)") and Nighthawks
 * ("modern and contemporary art") both included, at title-batch scale
 * unchanged from the Met run. */
const FAILING_CLASSIFICATION_RE_BY_MUSEUM: Record<string, RegExp> = {
  aic: /paint|modern and contemporary art/i,
};
const FAILING_CLASSIFICATION_RE =
  FAILING_CLASSIFICATION_RE_BY_MUSEUM[MUSEUM_ID] ??
  /^(bronzes|vases|terracottas|gold and silver|stone[ -]sculpture|gems|glass)/i;

interface SynonymsFile {
  model: string;
  generatedAt: string;
  vocab: Record<string, string>;
  titles: Record<string, string>;
}

const batchSchema = z.object({
  entries: z.array(z.object({ term: z.string(), synonyms: z.array(z.string()) })),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// harvest distinct values + failing-category titles
// ---------------------------------------------------------------------------
/** Pure date/date-range strings ("ca. 1770", "1848 - 1854") — some sources'
 * `period` is a display date, not a period name; synonym-querying them is
 * pure waste (measured on the V&A: 6,651 of 14,449 distinct values). */
const DATE_ONLY_RE = /^(ca?\.?\s*)?\d{3,4}(\s*[-–]\s*(ca?\.?\s*)?\d{2,4})?\s*$/i;

function harvest(): { values: Set<string>; titles: Set<string> } {
  const values = new Set<string>();
  const titles = new Set<string>();
  const add = (culture: string, period: string, classification: string, title: string) => {
    for (const v of [culture, period, classification]) if (v && !DATE_ONLY_RE.test(v)) values.add(v);
    if (FAILING_CLASSIFICATION_RE.test(classification) && title) titles.add(title);
  };

  const snapPath = path.join(SNAP_DIR, "objects.json.gz");
  if (fs.existsSync(snapPath)) {
    const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString()) as Array<{
      culture: string; period: string; classification: string; title: string;
    }>;
    for (const r of rows) add(r.culture ?? "", r.period ?? "", r.classification ?? "", r.title ?? "");
    console.log(`snapshot: ${rows.length} rows`);
  }

  const dbIdx = process.argv.indexOf("--db");
  if (dbIdx >= 0) {
    // optional extra harvest from any met.sqlite with the objects schema
    const db = new Database(process.argv[dbIdx + 1], { readonly: true });
    const rows = db
      .prepare("SELECT culture, period, classification, title FROM objects")
      .all() as Array<{ culture: string; period: string; classification: string; title: string }>;
    for (const r of rows) add(r.culture, r.period, r.classification, r.title);
    db.close();
    console.log(`--db: ${rows.length} rows`);
  }
  return { values, titles };
}

// ---------------------------------------------------------------------------
// flash-lite batches (structured output; adaptive 429 backoff)
// ---------------------------------------------------------------------------
const ai = new GoogleGenAI({});
let backoffUntil = 0;
let calls = 0;
let tokensIn = 0;
let tokensOut = 0;

async function generateBatch(prompt: string, terms: string[]): Promise<Map<string, string[]>> {
  for (let a = 0; ; a++) {
    const wait = backoffUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const r = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [{ text: `${prompt}\n\nTerms (one per line):\n${terms.join("\n")}` }],
          },
        ],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(batchSchema),
        },
      });
      calls++;
      tokensIn += r.usageMetadata?.promptTokenCount ?? 0;
      tokensOut += r.usageMetadata?.candidatesTokenCount ?? 0;
      const parsed = batchSchema.parse(JSON.parse(r.text ?? "{}"));
      const out = new Map<string, string[]>();
      for (const e of parsed.entries) out.set(e.term, e.synonyms);
      return out;
    } catch (e) {
      const is429 = /429|RESOURCE_EXHAUSTED/.test(String(e));
      if (a >= 6) throw e;
      const delay = is429 ? Math.min(60_000, 5_000 * 2 ** a) : 1_000 * 2 ** a;
      if (is429) backoffUntil = Math.max(backoffUntil, Date.now() + delay);
      else await sleep(delay);
    }
  }
}

const VOCAB_PROMPT = [
  `Each term below is a culture, period, or classification label from the ${MUSEUM_NAME} collection database.`,
  "For each, list 2-8 short alternative search words a museum visitor might type instead: plain-English names, translations, broader or adjacent terms, ancient region names, modern country names — and be generous with loose geographic terms visitors commonly conflate, including the conflated term itself (e.g. visitors type 'Mesopotamia' for Assyrian, Babylonian, Sumerian, AND ancient Iranian/Anatolian/Near Eastern material, so include 'Mesopotamia' for all of those; 'samurai sword' for Edo-period blades).",
  "Return every input term exactly as given with its synonyms (empty list if none are useful). Synonyms are single words or short phrases, no explanations.",
].join("\n");

const TITLE_PROMPT = [
  `Each line below is an artwork title from the ${MUSEUM_NAME} catalog (Greek, Roman, and Ancient Near Eastern antiquities).`,
  "For each, list 0-6 plain-language search words a visitor who does NOT know the specialist or iconographic vocabulary might type to find it (e.g. 'Bronze statuette of a Lar' -> household god, guardian spirit, roman god figurine; 'Terracotta kylix' -> drinking cup, wine cup).",
  "Only add words NOT already in the title. Return every input title exactly as given; empty list when the title is already plain English.",
].join("\n");

async function expand(
  prompt: string,
  todo: string[],
  into: Record<string, string>,
): Promise<void> {
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (batches.length) {
      const batch = batches.shift()!;
      try {
        const result = await generateBatch(prompt, batch);
        for (const term of batch) {
          // model echoes terms back; tolerate minor whitespace drift
          const syns =
            result.get(term) ??
            result.get(term.trim()) ??
            [...result.entries()].find(([k]) => k.trim() === term.trim())?.[1];
          into[term] = (syns ?? [])
            .filter((s) => s && s.toLowerCase() !== term.toLowerCase())
            .join(" ");
        }
      } catch (e) {
        console.warn(`batch of ${batch.length} failed permanently: ${e}`);
      }
      done += batch.length;
      if (done % 400 < BATCH) console.log(`  ${done}/${todo.length}`);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const { values, titles } = harvest();
  const existing: SynonymsFile = fs.existsSync(OUT_PATH)
    ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8"))
    : { model: MODEL, generatedAt: "", vocab: {}, titles: {} };

  const newValues = [...values].filter((v) => !(v in existing.vocab));
  const newTitles = [...titles].filter((t) => !(t in existing.titles));
  console.log(
    `${values.size} vocab values (${newValues.length} new), ${titles.size} failing-category titles (${newTitles.length} new)`,
  );

  const t0 = Date.now();
  await expand(VOCAB_PROMPT, newValues, existing.vocab);
  await expand(TITLE_PROMPT, newTitles, existing.titles);

  existing.model = MODEL;
  existing.generatedAt = new Date().toISOString();
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH + ".tmp", JSON.stringify(existing));
  fs.renameSync(OUT_PATH + ".tmp", OUT_PATH);

  // flash-lite $0.25/1M in, $1.50/1M out (docs/llm-bench.md)
  const cost = (tokensIn * 0.25 + tokensOut * 1.5) / 1e6;
  console.log(
    `done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${calls} calls, ` +
      `${tokensIn} in / ${tokensOut} out tokens, ~$${cost.toFixed(3)}; ` +
      `${Object.keys(existing.vocab).length} vocab + ${Object.keys(existing.titles).length} title entries -> ${OUT_PATH}`,
  );
}

main();
