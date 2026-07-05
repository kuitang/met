// TASK 2 — per-museum synonym generation bake-off.
//
// Uses the EXACT prompt style of data/src/synonyms.ts (VOCAB_PROMPT / TITLE_PROMPT,
// terms one per line, {entries:[{term,synonyms[]}]} JSON) against a deterministic
// sample of 60 vocab values per museum (met + aic; culture/period/classification)
// plus 22 hand-picked vocabulary-leap probes with expected visitor phrases.
//
// Metrics per model:
//   noiseRate  — per-term fraction of synonym phrases that are literal echoes of the
//                source value (substring either way after normalization, incl. naive
//                stem) or gibberish (fails charset/length/shape heuristics)
//   probeRecall— fraction of probes whose synonym set contains the expected phrase
//   echoRate   — fraction of input terms NOT returned (batch-integrity failure)
//   cost/1k values projection from measured tokens
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DIR, RESULTS_DIR, MODELS, orJson, seededSample, bootstrapCI, normText, p50, INCUMBENT } from "./lib.mjs";

const ROOT = path.resolve(DIR, "../../..");

// --- prompts copied VERBATIM from data/src/synonyms.ts (keep in sync) --------
const VOCAB_PROMPT = [
  "Each term below is a culture, period, or classification label from the Metropolitan Museum of Art collection database.",
  "For each, list 2-8 short alternative search words a museum visitor might type instead: plain-English names, translations, broader or adjacent terms, ancient region names, modern country names — and be generous with loose geographic terms visitors commonly conflate, including the conflated term itself (e.g. visitors type 'Mesopotamia' for Assyrian, Babylonian, Sumerian, AND ancient Iranian/Anatolian/Near Eastern material, so include 'Mesopotamia' for all of those; 'samurai sword' for Edo-period blades).",
  "Return every input term exactly as given with its synonyms (empty list if none are useful). Synonyms are single words or short phrases, no explanations.",
].join("\n");
const TITLE_PROMPT = [
  "Each line below is an artwork title from the Metropolitan Museum of Art catalog (Greek, Roman, and Ancient Near Eastern antiquities).",
  "For each, list 0-6 plain-language search words a visitor who does NOT know the specialist or iconographic vocabulary might type to find it (e.g. 'Bronze statuette of a Lar' -> household god, guardian spirit, roman god figurine; 'Terracotta kylix' -> drinking cup, wine cup).",
  "Only add words NOT already in the title. Return every input title exactly as given; empty list when the title is already plain English.",
].join("\n");
// For AIC the same prompt with the museum name swapped (per-museum pipelines).
const VOCAB_PROMPT_AIC = VOCAB_PROMPT.replace("Metropolitan Museum of Art", "Art Institute of Chicago");

const SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: { term: { type: "string" }, synonyms: { type: "array", items: { type: "string" } } },
        required: ["term", "synonyms"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

// --- vocab samples (deterministic) -------------------------------------------
function museumValues(vocabPath, objectsPath, seed) {
  const vocab = JSON.parse(fs.readFileSync(vocabPath, "utf8"));
  const keys = (v) => (Array.isArray(v) ? v : Object.keys(v));
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(objectsPath)));
  const periods = [...new Set(rows.map((r) => r.period).filter(Boolean))];
  return [
    ...seededSample(keys(vocab.classifications), 20, seed),
    ...seededSample(keys(vocab.cultures), 20, seed + 1),
    ...seededSample(periods, 20, seed + 2),
  ];
}
const metValues = museumValues(
  path.join(ROOT, "data/snapshots/vocab.json"),
  path.join(ROOT, "data/snapshots/objects.json.gz"),
  101,
);
const aicValues = museumValues(
  path.join(ROOT, "data/museums/aic/snapshots/vocab.json"),
  path.join(ROOT, "data/museums/aic/snapshots/objects.json.gz"),
  202,
);

// --- vocabulary-leap probes (all verified to exist in the catalogs) ----------
// expect: regex over the space-joined synonym string (normalized)
const PROBES = [
  // Met antiquities titles (TITLE_PROMPT)
  { museum: "met", kind: "title", term: "Bronze statuette of a Lar", expect: /household|guardian/ },
  { museum: "met", kind: "title", term: "Terracotta kylix (cup)", expect: /drink|wine/ },
  { museum: "met", kind: "title", term: "Lekythos", expect: /oil|flask|perfume/ },
  { museum: "met", kind: "title", term: "Fragment of a terracotta oinochoe (jug)", expect: /wine|pour|pitcher/ },
  { museum: "met", kind: "title", term: "Faience Ushabti", expect: /funerary|servant|tomb|mummy|shabti/ },
  { museum: "met", kind: "title", term: "Amphora", expect: /jar|storage/ },
  { museum: "met", kind: "title", term: "Situla with Design of Boats", expect: /bucket|pail|vessel/ },
  { museum: "met", kind: "title", term: "Terracotta zoomorphic askos (vessel)", expect: /animal|pour|flask/ },
  { museum: "met", kind: "title", term: "Bronze cista (toiletries box)", expect: /cosmetic|casket|makeup|jewelry/ },
  { museum: "met", kind: "title", term: "Terracotta pyxis (cosmetic box)", expect: /makeup|jewelry|trinket|lidded/ },
  // Met vocab values (VOCAB_PROMPT)
  { museum: "met", kind: "vocab", term: "Assyrian", expect: /mesopotamia/ },
  { museum: "met", kind: "vocab", term: "Babylonian", expect: /mesopotamia/ },
  { museum: "met", kind: "vocab", term: "Sumerian", expect: /mesopotamia/ },
  { museum: "met", kind: "vocab", term: "Sasanian", expect: /iran|persia/ },
  { museum: "met", kind: "vocab", term: "Edo period (1615–1868)", expect: /japan|samurai|tokugawa/ },
  { museum: "met", kind: "vocab", term: "Greek, Attic", expect: /athen/ },
  { museum: "met", kind: "vocab", term: "Sword Furniture-Tsuba", expect: /guard|samurai/ },
  // AIC vocab values (VOCAB_PROMPT_AIC)
  { museum: "aic", kind: "vocab", term: "woodblock print", expect: /ukiyo|japanese print|woodcut/ },
  { museum: "aic", kind: "vocab", term: "suit", expect: /armou?r/ },
  { museum: "aic", kind: "vocab", term: "Meissen", expect: /porcelain|german/ },
  { museum: "aic", kind: "vocab", term: "Sèvres", expect: /porcelain|france|french/ },
  { museum: "aic", kind: "vocab", term: "Flanders", expect: /flemish|belgi/ },
];

// --- noise heuristic ----------------------------------------------------------
function isLiteral(syn, term) {
  const s = normText(syn), t = normText(term);
  if (!s) return true;
  const stem = (x) => x.replace(/(es|s)$/, "");
  return t.includes(s) || s.includes(t) || t.split(" ").some((tok) => stem(tok) === stem(s));
}
function isGibberish(syn) {
  const s = syn.trim();
  return (
    s.length < 2 ||
    s.length > 40 ||
    s.split(/\s+/).length > 5 ||
    !/^[\p{L}\p{N}''.,()/-]+(?: [\p{L}\p{N}''.,()/-]+)*$/u.test(s) ||
    /e\.g\.|for example|such as/i.test(s)
  );
}

// --- run -----------------------------------------------------------------------
const BATCH = 20;
async function runModel(model) {
  const per = { model, terms: [], latencies: [], usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 }, schemaOk: 0, calls: 0 };
  const jobs = [
    ...[...chunk(metValues, BATCH)].map((terms) => ({ prompt: VOCAB_PROMPT, terms, museum: "met", kind: "vocab" })),
    ...[...chunk(aicValues, BATCH)].map((terms) => ({ prompt: VOCAB_PROMPT_AIC, terms, museum: "aic", kind: "vocab" })),
    { prompt: TITLE_PROMPT, terms: PROBES.filter((p) => p.kind === "title").map((p) => p.term), museum: "met", kind: "title" },
    { prompt: VOCAB_PROMPT, terms: PROBES.filter((p) => p.kind === "vocab" && p.museum === "met").map((p) => p.term), museum: "met", kind: "vocab" },
    { prompt: VOCAB_PROMPT_AIC, terms: PROBES.filter((p) => p.museum === "aic").map((p) => p.term), museum: "aic", kind: "vocab" },
  ];
  for (const job of jobs) {
    const r = await orJson({
      model,
      messages: [{ role: "user", content: `${job.prompt}\n\nTerms (one per line):\n${job.terms.join("\n")}` }],
      schemaName: "synonym_batch",
      schema: SCHEMA,
      reasoning: MODELS[model].reasoning,
    });
    per.calls++;
    // strict compliance = first attempt parsed AND matches the {entries:[...]} schema shape
    const shapeOk = Array.isArray(r.parsed?.entries);
    per.schemaOk += r.schemaOkFirst && shapeOk ? 1 : 0;
    per.usage.prompt_tokens += r.usage.prompt_tokens;
    per.usage.completion_tokens += r.usage.completion_tokens;
    per.usage.cost += r.usage.cost;
    per.latencies.push(r.latencyMs);
    // tolerant harvest: schema shape, else a flat {term: [synonyms]} map (observed
    // from qwen's provider, which downgrades json_schema silently)
    const got = shapeOk
      ? new Map(r.parsed.entries.map((e) => [e.term.trim(), e.synonyms]))
      : new Map(Object.entries(r.parsed ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k.trim(), v]));
    for (const term of job.terms) {
      per.terms.push({ term, museum: job.museum, kind: job.kind, synonyms: got.get(term.trim()) ?? null });
    }
  }
  return per;
}
function* chunk(a, n) {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n);
}

const out = { generatedAt: new Date().toISOString(), sample: { metValues, aicValues, probes: PROBES.map((p) => ({ ...p, expect: p.expect.source })) }, models: {} };
for (const model of Object.keys(MODELS)) {
  console.log(`== ${model}`);
  const per = await runModel(model);
  // metrics
  const vocabTerms = per.terms.filter((t) => !PROBES.some((p) => p.term === t.term));
  const noisePerTerm = vocabTerms
    .filter((t) => t.synonyms && t.synonyms.length)
    .map((t) => t.synonyms.filter((s) => isLiteral(s, t.term) || isGibberish(s)).length / t.synonyms.length);
  const missing = per.terms.filter((t) => t.synonyms === null).length;
  const probeHits = PROBES.map((p) => {
    const t = per.terms.find((x) => x.term === p.term);
    const joined = normText((t?.synonyms ?? []).join(" "));
    return p.expect.test(joined) ? 1 : 0;
  });
  out.models[model] = {
    tag: MODELS[model].tag,
    terms: per.terms,
    metrics: {
      noise: bootstrapCI(noisePerTerm, 1),
      probeRecall: bootstrapCI(probeHits, 2),
      probeHits: probeHits.reduce((s, v) => s + v, 0),
      probeTotal: PROBES.length,
      missingTermRate: missing / per.terms.length,
      schemaComplianceRate: per.schemaOk / per.calls,
      latencyP50Ms: p50(per.latencies),
      measuredUsd: per.usage.cost,
      tokens: { prompt: per.usage.prompt_tokens, completion: per.usage.completion_tokens },
      nValues: per.terms.length,
      usdPer1kValues: (per.usage.cost / per.terms.length) * 1000,
    },
  };
  const m = out.models[model].metrics;
  console.log(
    `  noise ${m.noise.mean?.toFixed(3)} [${m.noise.lo?.toFixed(3)},${m.noise.hi?.toFixed(3)}] | probes ${m.probeHits}/${m.probeTotal} | missing ${(m.missingTermRate * 100).toFixed(1)}% | schema ${(m.schemaComplianceRate * 100).toFixed(0)}% | $${m.measuredUsd.toFixed(4)} | $/1k ${m.usdPer1kValues.toFixed(3)}`,
  );
}

// paired deltas vs incumbent (noise: lower better; probes: higher better)
for (const model of Object.keys(MODELS)) {
  if (model === INCUMBENT) continue;
  const a = out.models[model], b = out.models[INCUMBENT];
  const pairNoise = [];
  for (let i = 0; i < a.terms.length; i++) {
    const ta = a.terms[i], tb = b.terms[i];
    if (!ta.synonyms?.length || !tb.synonyms?.length) continue;
    if (PROBES.some((p) => p.term === ta.term)) continue;
    const f = (t) => t.synonyms.filter((s) => isLiteral(s, t.term) || isGibberish(s)).length / t.synonyms.length;
    pairNoise.push(f(ta) - f(tb));
  }
  const probeDelta = PROBES.map((p, i) => {
    const hit = (m) => (p.expect.test(normText((m.terms.find((x) => x.term === p.term)?.synonyms ?? []).join(" "))) ? 1 : 0);
    return hit(a) - hit(b);
  });
  a.metrics.noiseDeltaVsIncumbent = bootstrapCI(pairNoise, 3);
  a.metrics.probeDeltaVsIncumbent = bootstrapCI(probeDelta, 4);
}

fs.writeFileSync(path.join(RESULTS_DIR, "task2.json"), JSON.stringify(out, null, 1));
console.log("wrote results/task2.json");
