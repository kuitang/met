// TASK 1 — FR->EN translation of Louvre records (batch pipeline shape, like
// data/src/synonyms.ts: shared instructions first, N items per call, JSON out).
//
// Scoring:
//  A) reference subset — records whose Wikidata item has an English label:
//     normalized edit similarity(model title, EN label); paired bootstrap deltas
//     vs the incumbent.
//  B) judged subset — up to 80 non-reference records: pairwise LLM judge
//     (deepseek-v4-pro, never a contestant) with position debiasing: each
//     candidate-vs-incumbent pair judged twice with A/B order swapped;
//     disagreement or explicit tie => tie. Win-rate in [0,1] (win 1, tie 0.5).
// Also measured: strict schema compliance, latency p50, measured $ and $/1k records.
import fs from "node:fs";
import path from "node:path";
import { DIR, RESULTS_DIR, MODELS, INCUMBENT, JUDGE, orJson, bootstrapCI, editSimilarity, p50 } from "./lib.mjs";

const sample = JSON.parse(fs.readFileSync(path.join(DIR, "louvre-sample.json"), "utf8")).records;
const BATCH = 10;
const JUDGE_N = 80;

const PROMPT = [
  "You translate French museum-catalog records from the Louvre into natural English for an English-language collection search index.",
  "For each record below, translate the four fields into concise museum-label English.",
  "Keep proper names (artists, sitters, places) in their conventional English form when one exists (e.g. 'La Joconde' -> 'Mona Lisa'), otherwise leave them as-is.",
  "Keep field content parallel to the source: do not add, explain, or merge fields. Empty fields stay empty strings.",
  "Return every record id exactly as given.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objectType: { type: "string" },
          materialsAndTechniques: { type: "string" },
          period: { type: "string" },
        },
        required: ["id", "title", "objectType", "materialsAndTechniques", "period"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

const fmt = (r) =>
  `id: ${r.ark}\ntitle: ${r.fr.title}\nobjectType: ${r.fr.objectType}\nmaterialsAndTechniques: ${r.fr.materialsAndTechniques}\nperiod: ${r.fr.period}`;

async function pool(jobs, width, fn) {
  const q = [...jobs.entries()];
  const out = new Array(jobs.length);
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (q.length) {
        const [i, job] = q.shift();
        out[i] = await fn(job);
      }
    }),
  );
  return out;
}

// --- translate ---------------------------------------------------------------
async function translateAll(model) {
  const batches = [];
  for (let i = 0; i < sample.length; i += BATCH) batches.push(sample.slice(i, i + BATCH));
  const per = { byArk: {}, latencies: [], schemaOk: 0, calls: 0, usd: 0, tokens: { prompt: 0, completion: 0 } };
  const results = await pool(batches, 4, (batch) =>
    orJson({
      model,
      messages: [{ role: "user", content: `${PROMPT}\n\nRecords:\n\n${batch.map(fmt).join("\n\n")}` }],
      schemaName: "translation_batch",
      schema: SCHEMA,
      maxTokens: 3500,
      reasoning: MODELS[model].reasoning,
    }),
  );
  for (let b = 0; b < batches.length; b++) {
    const r = results[b];
    per.calls++;
    per.usd += r.usage.cost;
    per.tokens.prompt += r.usage.prompt_tokens;
    per.tokens.completion += r.usage.completion_tokens;
    per.latencies.push(r.latencyMs);
    const shapeOk = Array.isArray(r.parsed?.entries);
    per.schemaOk += r.schemaOkFirst && shapeOk ? 1 : 0;
    const entries = shapeOk
      ? r.parsed.entries
      : Object.entries(r.parsed ?? {})
          .filter(([, v]) => v && typeof v === "object")
          .map(([id, v]) => ({ id, ...v }));
    const byId = new Map(entries.map((e) => [String(e.id).trim(), e]));
    for (const rec of batches[b]) per.byArk[rec.ark] = byId.get(rec.ark) ?? null;
  }
  return per;
}

// --- judge -------------------------------------------------------------------
const JUDGE_SCHEMA = {
  type: "object",
  properties: { winner: { type: "string", enum: ["A", "B", "tie"] } },
  required: ["winner"],
  additionalProperties: false,
};
async function judgePair(rec, tA, tB) {
  const show = (t) =>
    t
      ? `title: ${t.title}\nobjectType: ${t.objectType}\nmaterialsAndTechniques: ${t.materialsAndTechniques}\nperiod: ${t.period}`
      : "(missing)";
  const r = await orJson({
    model: JUDGE,
    messages: [
      {
        role: "user",
        content: [
          "You are judging two English translations (A and B) of the same French museum-catalog record.",
          "Prefer the translation that is more accurate, more natural museum-label English, uses conventional English names for well-known works/people, and stays parallel to the source fields. A missing translation always loses.",
          'Answer with JSON {"winner":"A"|"B"|"tie"}.',
          "",
          "French source:",
          fmt(rec),
          "",
          "Translation A:",
          show(tA),
          "",
          "Translation B:",
          show(tB),
        ].join("\n"),
      },
    ],
    schemaName: "judge_verdict",
    schema: JUDGE_SCHEMA,
    maxTokens: 500,
    reasoning: true,
  });
  return r.parsed?.winner ?? "tie";
}

// --- main --------------------------------------------------------------------
// Reference cleanup: many Wikidata EN labels for Louvre items end in inventory
// numbers ("Horus as child taming animals-E 20008") — strip that suffix; it is
// reference noise, not translation content.
const cleanLabel = (s) => s.replace(/\s*[-–—]\s*[A-Z]{1,3}[ .]?\d[\w ./-]*$/u, "").trim();
const refRecs = sample.filter((r) => r.enLabel).map((r) => ({ ...r, enLabel: cleanLabel(r.enLabel) }));
const judgeRecs = sample.filter((r) => !r.enLabel).slice(0, JUDGE_N);
console.log(`${sample.length} records: ${refRecs.length} reference-scored, ${judgeRecs.length} judge-scored`);

const out = { generatedAt: new Date().toISOString(), nRecords: sample.length, refN: refRecs.length, judgeN: judgeRecs.length, models: {} };
const trans = {};
for (const model of Object.keys(MODELS)) {
  console.log(`== translate: ${model}`);
  const per = await translateAll(model);
  trans[model] = per;
  const refSims = refRecs.map((r) => editSimilarity(per.byArk[r.ark]?.title ?? "", r.enLabel));
  out.models[model] = {
    tag: MODELS[model].tag,
    refSimilarity: bootstrapCI(refSims, 11),
    refSims,
    schemaComplianceRate: per.schemaOk / per.calls,
    latencyP50Ms: p50(per.latencies),
    measuredUsd: per.usd,
    tokens: per.tokens,
    usdPer1kRecords: (per.usd / sample.length) * 1000,
    missingRate: sample.filter((r) => !per.byArk[r.ark]).length / sample.length,
  };
  const m = out.models[model];
  console.log(
    `  refSim ${m.refSimilarity.mean.toFixed(3)} [${m.refSimilarity.lo.toFixed(3)},${m.refSimilarity.hi.toFixed(3)}] | schema ${(m.schemaComplianceRate * 100).toFixed(0)}% | p50 ${m.latencyP50Ms}ms | $${m.measuredUsd.toFixed(4)} | $/1k ${m.usdPer1kRecords.toFixed(3)} | missing ${(m.missingRate * 100).toFixed(1)}%`,
  );
}

// paired ref-similarity deltas vs incumbent
for (const model of Object.keys(MODELS)) {
  if (model === INCUMBENT) continue;
  const d = out.models[model].refSims.map((s, i) => s - out.models[INCUMBENT].refSims[i]);
  out.models[model].refDeltaVsIncumbent = bootstrapCI(d, 12);
}

// pairwise judging vs incumbent (both orders; disagreement => tie)
for (const model of Object.keys(MODELS)) {
  if (model === INCUMBENT) continue;
  console.log(`== judge: ${model} vs incumbent`);
  const scores = await pool(judgeRecs, 6, async (rec) => {
    const cand = trans[model].byArk[rec.ark];
    const inc = trans[INCUMBENT].byArk[rec.ark];
    const v1 = await judgePair(rec, cand, inc); // cand = A
    const v2 = await judgePair(rec, inc, cand); // cand = B
    const candWon1 = v1 === "A" ? 1 : v1 === "B" ? 0 : 0.5;
    const candWon2 = v2 === "B" ? 1 : v2 === "A" ? 0 : 0.5;
    return candWon1 === candWon2 ? candWon1 : 0.5; // positional disagreement => tie
  });
  out.models[model].judgeWinRateVsIncumbent = bootstrapCI(scores, 13);
  out.models[model].judgeScores = scores;
  const j = out.models[model].judgeWinRateVsIncumbent;
  const wins = scores.filter((s) => s === 1).length, losses = scores.filter((s) => s === 0).length;
  console.log(`  winRate ${j.mean.toFixed(3)} [${j.lo.toFixed(3)},${j.hi.toFixed(3)}] (${wins}W/${scores.length - wins - losses}T/${losses}L)`);
}

fs.writeFileSync(path.join(RESULTS_DIR, "task1.json"), JSON.stringify(out, null, 1));
console.log("wrote results/task1.json");
