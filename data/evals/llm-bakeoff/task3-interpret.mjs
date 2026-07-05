// TASK 3 — awareness-only interpret-signal check (NOT a production decision:
// the runtime interpret path is Gemini-locked via @google/genai).
//
// Replays the 13 llm-tier golden queries through each candidate with the EXACT
// production rewrite prompt shape (server/src/gemini.ts interpretQuery +
// server/src/vocab.ts frequency-ordered 200/250 vocab block) and counts how
// many rewrites carry the golden's key term(s) in ftsQuery+filters text.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DIR, RESULTS_DIR, MODELS, INCUMBENT, orJson, bootstrapCI, normText, p50 } from "./lib.mjs";

const ROOT = path.resolve(DIR, "../../..");

// vocab block: replicate server/src/vocab.ts (frequency-ordered, caps 200/250)
// from the objects snapshot (same source build-db.ts uses).
const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "data/snapshots/objects.json.gz"))));
function topValues(col, cap) {
  const counts = new Map();
  for (const r of rows) {
    const v = r[col];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([v]) => v);
}
const vocab = { classifications: topValues("classification", 200), cultures: topValues("culture", 250) };

const SCHEMA = {
  type: "object",
  properties: {
    ftsQuery: { type: "string" },
    filters: {
      type: "object",
      properties: {
        artist: { type: "string" },
        classification: { type: "string" },
        material: { type: "string" },
        culture_or_period: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: ["ftsQuery", "filters"],
  additionalProperties: false,
};

// Key terms: what the rewrite must carry for the downstream relaxed-FTS
// execution to have a chance at the golden (derived from each case's expected
// match + the synonyms-indexed vocabulary, see docs/SEARCH.md).
const CASES = [
  { q: "great wave", key: /wave/ },
  { q: "sake bottle willow", key: /willow|bottle/ },
  { q: "that huge painting of washington crossing a river in a boat", key: /washington/ },
  { q: "blue ming vases", key: /vase/ },
  { q: "ancient egyptian cat statues", key: /cat/ },
  { q: "armor for horses", key: /horse/ },
  { q: "samurai sword", key: /sword|blade|katana|tachi/ },
  { q: "impressionist gardens", key: /garden/ },
  { q: "tiffany stained glass", key: /tiffany/ },
  { q: "painting of a woman seated beside a vase of flowers", key: /flower|vase/ },
  { q: "stone idol with big eyes", key: /idol|eye/ },
  { q: "bronze statue of a roman household god", key: /lar\b|household|god/ },
  { q: "beads from ancient mesopotamia", key: /bead/ },
];

const PROMPT_HEAD = [
  "Convert a museum visitor search query into an SQLite FTS5 query over columns title, artist, culture, classification, medium, tags.",
  "Prefer few, high-signal stemmed terms joined with OR so recall stays high; put exact-match constraints in filters.",
  `Valid classification values: ${vocab.classifications.join(", ")}`,
  `Valid culture/period values: ${vocab.cultures.join(", ")}`,
].join("\n");

const out = { generatedAt: new Date().toISOString(), note: "awareness-only; runtime is Gemini-locked", models: {} };
for (const model of Object.keys(MODELS)) {
  const hits = [];
  const latencies = [];
  let usd = 0, schemaOk = 0;
  const rewrites = [];
  for (const c of CASES) {
    const r = await orJson({
      model,
      messages: [{ role: "user", content: `${PROMPT_HEAD}\nQuery: ${c.q}` }],
      schemaName: "interpreted_query",
      schema: SCHEMA,
      maxTokens: 400,
      reasoning: MODELS[model].reasoning,
    });
    usd += r.usage.cost;
    latencies.push(r.latencyMs);
    schemaOk += r.schemaOkFirst && typeof r.parsed?.ftsQuery === "string" ? 1 : 0;
    // key-term signal is measured over ALL string values (schema compliance is a
    // separate metric — e.g. qwen's provider drops json_schema and snake_cases keys)
    const strings = [];
    (function walk(v) {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    })(r.parsed);
    const text = normText(strings.join(" "));
    hits.push(c.key.test(text) ? 1 : 0);
    rewrites.push({ q: c.q, rewrite: r.parsed, hit: c.key.test(text) });
  }
  out.models[model] = {
    tag: MODELS[model].tag,
    keyTermHits: hits.reduce((s, v) => s + v, 0),
    total: CASES.length,
    hitCI: bootstrapCI(hits, 21),
    hits,
    schemaComplianceRate: schemaOk / CASES.length,
    latencyP50Ms: p50(latencies),
    measuredUsd: usd,
    rewrites,
  };
  console.log(
    `${model}: ${out.models[model].keyTermHits}/${CASES.length} | schema ${(out.models[model].schemaComplianceRate * 100).toFixed(0)}% | p50 ${out.models[model].latencyP50Ms}ms | $${usd.toFixed(4)}`,
  );
}
for (const model of Object.keys(MODELS)) {
  if (model === INCUMBENT) continue;
  const d = out.models[model].hits.map((h, i) => h - out.models[INCUMBENT].hits[i]);
  out.models[model].deltaVsIncumbent = bootstrapCI(d, 22);
}
fs.writeFileSync(path.join(RESULTS_DIR, "task3.json"), JSON.stringify(out, null, 1));
console.log("wrote results/task3.json");
