// TASK 1b — prompt-variant arm for the two Task-1 finalists (deepseek-v4-flash,
// gemini-3.1-flash-lite) on the SAME cached 200-record Louvre fixture.
//
// Variants (each builds on the previous; baseline = Task 1's prompt verbatim):
//   V1 domain-brief : + a museum-catalog domain brief (conventional EN titles,
//                     art-historical materials vocabulary, museum-label register)
//   V2 few-shot     : V1 + 6 hand-verified FR->EN exemplars spanning
//                     title / objectType / materials / period cases
//   V3 model-specific:
//     deepseek : V2 + temperature 1.3 — DeepSeek's own documented recommendation
//                for translation (thinking already off in every arm)
//     gemini   : no documented flash-lite MT temperature guidance exists, so per
//                the fallback rule V3 = V2 + a mini-glossary of the fixture's 20
//                most frequent materialsAndTechniques terms with fixed translations
//
// Scoring mirrors task1-translate.mjs: normalized edit similarity vs cleaned
// Wikidata EN labels on the 101 referenced records (paired delta vs BASELINE,
// bootstrap 95% CI) + pairwise position-debiased judge (deepseek-v4-pro) on a
// 40-record subsample of the unreferenced records. Baseline translations are
// cache hits from Task 1 ($0).
import fs from "node:fs";
import path from "node:path";
import { DIR, RESULTS_DIR, MODELS, JUDGE, orJson, bootstrapCI, editSimilarity, p50 } from "./lib.mjs";

const FINALISTS = ["google/gemini-3.1-flash-lite", "deepseek/deepseek-v4-flash"];
const sample = JSON.parse(fs.readFileSync(path.join(DIR, "louvre-sample.json"), "utf8")).records;
const BATCH = 10;
const JUDGE_N = 40;

// --- BASELINE: verbatim from task1-translate.mjs ------------------------------
const BASELINE = [
  "You translate French museum-catalog records from the Louvre into natural English for an English-language collection search index.",
  "For each record below, translate the four fields into concise museum-label English.",
  "Keep proper names (artists, sitters, places) in their conventional English form when one exists (e.g. 'La Joconde' -> 'Mona Lisa'), otherwise leave them as-is.",
  "Keep field content parallel to the source: do not add, explain, or merge fields. Empty fields stay empty strings.",
  "Return every record id exactly as given.",
].join("\n");

const DOMAIN_BRIEF = [
  "Domain brief: these records come from the Louvre's collection catalog (paintings, sculpture, decorative arts, antiquities).",
  "Titles: use the established conventional English title where art-historical usage has one ('La Liberté guidant le peuple' -> 'Liberty Leading the People'); works conventionally known by their French name keep it. Otherwise translate descriptively in museum-label register.",
  "Materials/techniques and object types: use standard art-historical vocabulary ('huile sur toile' -> 'oil on canvas', 'ronde-bosse' -> 'sculpture in the round'). Periods: standard English century/dynasty phrasing. No explanations, no bracketed notes.",
].join("\n");

// 6 hand-verified exemplars spanning title / objectType / materials / period
const FEWSHOT = [
  "Examples (French -> English):",
  "title: 'La Liberté guidant le peuple' -> 'Liberty Leading the People'",
  "title: 'La Dentellière' -> 'The Lacemaker'",
  "title: 'La Belle Ferronnière' -> 'La Belle Ferronnière' (conventional French name kept)",
  "objectType: 'buste' -> 'bust'; 'coupe' -> 'cup'",
  "materialsAndTechniques: 'huile sur bois' -> 'oil on panel'; 'bronze doré' -> 'gilt bronze'; 'terre cuite' -> 'terracotta'",
  "period: '2e quart du XIXe siècle' -> 'second quarter of the 19th century'; 'époque romaine' -> 'Roman period'",
].join("\n");

// Fixed translations for the fixture's 20 most frequent materials terms
const GLOSSARY = [
  "Terminology glossary (always use these translations):",
  "huile sur toile -> oil on canvas; toile -> canvas; huile sur bois -> oil on panel; huile sur carton -> oil on cardboard;",
  "marbre -> marble; bronze -> bronze; bois -> wood; terre cuite -> terracotta; pierre calcaire -> limestone; calcaire -> limestone;",
  "alliage cuivreux -> copper alloy; ivoire -> ivory; ivoire d'éléphant -> elephant ivory; stéatite -> steatite; basalte -> basalt;",
  "lapis-lazuli -> lapis lazuli; ronde-bosse -> sculpture in the round; haut-relief -> high relief; gravure -> engraving; incrustation -> inlay",
].join("\n");

const ARMS = {
  baseline: { prompt: BASELINE, temperature: 0 },
  "v1-domain-brief": { prompt: `${BASELINE}\n\n${DOMAIN_BRIEF}`, temperature: 0 },
  "v2-few-shot": { prompt: `${BASELINE}\n\n${DOMAIN_BRIEF}\n\n${FEWSHOT}`, temperature: 0 },
};
const V3 = {
  "deepseek/deepseek-v4-flash": {
    name: "v3-temp1.3 (DeepSeek documented MT setting)",
    prompt: ARMS["v2-few-shot"].prompt,
    temperature: 1.3,
  },
  "google/gemini-3.1-flash-lite": {
    name: "v3-glossary (no documented temp rec; fallback rule)",
    prompt: `${ARMS["v2-few-shot"].prompt}\n\n${GLOSSARY}`,
    temperature: 0,
  },
};

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

async function translateAll(model, prompt, temperature) {
  const batches = [];
  for (let i = 0; i < sample.length; i += BATCH) batches.push(sample.slice(i, i + BATCH));
  const per = { byArk: {}, latencies: [], schemaOk: 0, calls: 0, usd: 0, tokens: { prompt: 0, completion: 0 } };
  const results = await pool(batches, 4, (batch) =>
    orJson({
      model,
      messages: [{ role: "user", content: `${prompt}\n\nRecords:\n\n${batch.map(fmt).join("\n\n")}` }],
      schemaName: "translation_batch",
      schema: SCHEMA,
      maxTokens: 3500,
      reasoning: MODELS[model].reasoning,
      temperature,
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
    const entries = shapeOk ? r.parsed.entries : [];
    const byId = new Map(entries.map((e) => [String(e.id).trim(), e]));
    for (const rec of batches[b]) per.byArk[rec.ark] = byId.get(rec.ark) ?? null;
  }
  return per;
}

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

// --- main ----------------------------------------------------------------------
const cleanLabel = (s) => s.replace(/\s*[-–—]\s*[A-Z]{1,3}[ .]?\d[\w ./-]*$/u, "").trim();
const refRecs = sample.filter((r) => r.enLabel).map((r) => ({ ...r, enLabel: cleanLabel(r.enLabel) }));
const judgeRecs = sample.filter((r) => !r.enLabel).slice(0, JUDGE_N);
console.log(`${sample.length} records: ${refRecs.length} referenced, ${judgeRecs.length} judged per variant`);

const out = { generatedAt: new Date().toISOString(), baselinePrompt: BASELINE, models: {} };
for (const model of FINALISTS) {
  const arms = { ...ARMS, [V3[model].name]: V3[model] };
  const runs = {};
  out.models[model] = {};
  for (const [armName, arm] of Object.entries(arms)) {
    console.log(`== ${model} / ${armName}`);
    const per = await translateAll(model, arm.prompt, arm.temperature);
    runs[armName] = per;
    const refSims = refRecs.map((r) => editSimilarity(per.byArk[r.ark]?.title ?? "", r.enLabel));
    out.models[model][armName] = {
      refSimilarity: bootstrapCI(refSims, 31),
      refSims,
      schemaComplianceRate: per.schemaOk / per.calls,
      latencyP50Ms: p50(per.latencies),
      measuredUsd: per.usd,
      tokens: per.tokens,
      usdPer1kRecords: (per.usd / sample.length) * 1000,
      missingRate: sample.filter((r) => !per.byArk[r.ark]).length / sample.length,
    };
    if (armName !== "baseline") {
      const d = refSims.map((s, i) => s - out.models[model].baseline.refSims[i]);
      out.models[model][armName].refDeltaVsBaseline = bootstrapCI(d, 32);
      const scores = await pool(judgeRecs, 6, async (rec) => {
        const varT = per.byArk[rec.ark];
        const baseT = runs.baseline.byArk[rec.ark];
        const v1 = await judgePair(rec, varT, baseT);
        const v2 = await judgePair(rec, baseT, varT);
        const s1 = v1 === "A" ? 1 : v1 === "B" ? 0 : 0.5;
        const s2 = v2 === "B" ? 1 : v2 === "A" ? 0 : 0.5;
        return s1 === s2 ? s1 : 0.5;
      });
      out.models[model][armName].judgeWinRateVsBaseline = bootstrapCI(scores, 33);
      out.models[model][armName].judgeScores = scores;
    }
    const m = out.models[model][armName];
    const j = m.judgeWinRateVsBaseline;
    const rd = m.refDeltaVsBaseline;
    console.log(
      `  refSim ${m.refSimilarity.mean.toFixed(3)}${rd ? ` (delta ${rd.mean >= 0 ? "+" : ""}${rd.mean.toFixed(3)} [${rd.lo.toFixed(3)},${rd.hi.toFixed(3)}])` : ""}` +
        `${j ? ` | judgeWin ${j.mean.toFixed(3)} [${j.lo.toFixed(3)},${j.hi.toFixed(3)}]` : ""}` +
        ` | schema ${(m.schemaComplianceRate * 100).toFixed(0)}% | $${m.measuredUsd.toFixed(4)} | $/1k ${m.usdPer1kRecords.toFixed(3)} | missing ${(m.missingRate * 100).toFixed(1)}%`,
    );
  }
}
fs.writeFileSync(path.join(RESULTS_DIR, "task1b.json"), JSON.stringify(out, null, 1));
console.log("wrote results/task1b.json");
