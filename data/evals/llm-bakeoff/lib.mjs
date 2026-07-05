// Shared harness for the milestone-G LLM bake-off (offline pipelines).
// Plain Node >= 22, no deps outside the repo's node_modules.
//
// - OpenRouter chat client with strict JSON-schema response_format
// - Disk response cache (cache/, gitignored) keyed by request hash => reruns are $0
// - Spend ledger (results/spend.json) fed by OpenRouter's measured usage.cost;
//   hard-stops new calls when the projected total crosses BUDGET_STOP
// - Deterministic helpers: seeded RNG, bootstrap CIs, edit similarity
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(DIR, "cache");
export const RESULTS_DIR = path.join(DIR, "results");
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const LEDGER = path.join(RESULTS_DIR, "spend.json");
export const BUDGET_STOP = 6.5; // hard task budget is $8; stop with margin

// The recommended 6 from candidates.md + the judge (never a contestant).
// Prices $/token, re-pulled from the OpenRouter catalog 2026-07-05 (matched
// candidates.md exactly; no drift).
export const MODELS = {
  "google/gemini-3.1-flash-lite": { prompt: 0.25e-6, completion: 1.5e-6, reasoning: true, tag: "incumbent" },
  "google/gemini-2.5-flash-lite": { prompt: 0.1e-6, completion: 0.4e-6, reasoning: true, tag: "prior-gen" },
  "deepseek/deepseek-v4-flash": { prompt: 0.09e-6, completion: 0.18e-6, reasoning: true, tag: "cheapest-frontier" },
  "qwen/qwen3.6-flash": { prompt: 0.1875e-6, completion: 1.125e-6, reasoning: true, tag: "qwen-flash" },
  "mistralai/mistral-small-3.2-24b-instruct": { prompt: 0.075e-6, completion: 0.2e-6, reasoning: false, tag: "french-native" },
  "openai/gpt-oss-20b": { prompt: 0.029e-6, completion: 0.14e-6, reasoning: true, tag: "floor" },
};
export const INCUMBENT = "google/gemini-3.1-flash-lite";
export const JUDGE = "deepseek/deepseek-v4-pro"; // strongest cheap model NOT in any comparison
export const JUDGE_PRICE = { prompt: 0.435e-6, completion: 0.87e-6 };

const KEY = fs.readFileSync(path.join(process.env.HOME, ".openrouter_key"), "utf8").trim();

export function readLedger() {
  return fs.existsSync(LEDGER)
    ? JSON.parse(fs.readFileSync(LEDGER, "utf8"))
    : { totalUsd: 0, calls: 0, byModel: {} };
}
function addSpend(model, usage, usd) {
  const l = readLedger();
  l.totalUsd += usd;
  l.calls += 1;
  const m = (l.byModel[model] ??= { usd: 0, calls: 0, promptTokens: 0, completionTokens: 0 });
  m.usd += usd;
  m.calls += 1;
  m.promptTokens += usage?.prompt_tokens ?? 0;
  m.completionTokens += usage?.completion_tokens ?? 0;
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  if (l.totalUsd >= BUDGET_STOP) {
    throw new Error(`BUDGET STOP: measured spend $${l.totalUsd.toFixed(4)} >= $${BUDGET_STOP}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 40);

/**
 * One structured-output chat call. Cached to disk; cache hits cost $0 and keep
 * the originally measured latency/usage so reruns reproduce the report.
 * Schema compliance is measured on the FIRST attempt's content (schemaOkFirst).
 */
export async function orJson({ model, messages, schemaName, schema, maxTokens = 4000, reasoning = true, temperature = 0 }) {
  // temperature enters the cache key only when non-default so pre-existing cache entries stay valid
  const key = hash({ model, messages, schemaName, schema, v: 1, ...(temperature !== 0 ? { temperature } : {}) });
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(cacheFile)) return { ...JSON.parse(fs.readFileSync(cacheFile, "utf8")), cached: true };

  const base = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
  };
  // Reasoning suppression ladder: these are trivial batch tasks; never pay for CoT.
  const variants = reasoning
    ? [{ ...base, reasoning: { effort: "none" } }, { ...base, reasoning: { effort: "low" } }, base]
    : [base];
  // Provider quirk (observed: qwen via DashScope): json_schema is downgraded to
  // json_object, which then requires the literal word "json" in the messages.
  // Final fallback appends that word — recorded via variant index in results.
  const jsonWordMessages = messages.map((m, i) =>
    i === messages.length - 1 ? { ...m, content: `${m.content}\n\nReturn the result as JSON.` } : m,
  );
  variants.push(...variants.map((v) => ({ ...v, messages: jsonWordMessages })));

  let firstContent = null;
  let firstUsage = null;
  let schemaOkFirst = null;
  for (let v = 0; v < variants.length; v++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = Date.now();
      let res, body;
      try {
        res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(variants[v]),
        });
        body = await res.json();
      } catch (e) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const latencyMs = Date.now() - t0;
      if (res.status === 429 || res.status >= 500 || body?.error?.code === 429) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (body?.error) {
        // 400-class: likely the reasoning/effort variant is unsupported -> next variant
        if (v < variants.length - 1) break;
        throw new Error(`${model}: ${JSON.stringify(body.error).slice(0, 300)}`);
      }
      const usage = body.usage ?? {};
      const usd = usage.cost ?? ((usage.prompt_tokens ?? 0) * (MODELS[model]?.prompt ?? JUDGE_PRICE.prompt) + (usage.completion_tokens ?? 0) * (MODELS[model]?.completion ?? JUDGE_PRICE.completion));
      addSpend(model, usage, usd);
      const content = body.choices?.[0]?.message?.content ?? "";
      let parsed = null;
      let schemaOk = true;
      try {
        parsed = JSON.parse(content);
      } catch {
        schemaOk = false;
      }
      if (firstContent === null) {
        firstContent = content;
        firstUsage = usage;
        schemaOkFirst = schemaOk;
      }
      if (!schemaOk && attempt < 2) {
        // one repair retry (still measured as a first-attempt compliance failure)
        await sleep(500);
        continue;
      }
      const out = {
        parsed,
        schemaOkFirst,
        usage: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0, cost: usd },
        latencyMs,
        model,
        variant: v,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(out));
      return { ...out, cached: false };
    }
  }
  throw new Error(`${model}: exhausted retries`);
}

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededSample(arr, n, seed) {
  const rnd = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** percentile bootstrap (1000 resamples, seeded) over per-item values; returns [lo, hi, mean] */
export function bootstrapCI(values, seed = 42, resamples = 1000) {
  const n = values.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const rnd = mulberry32(seed);
  const means = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rnd() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * resamples)], hi: means[Math.floor(0.975 * resamples)], n };
}

export function normText(s) {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
/** normalized edit similarity in [0,1] on normalized strings */
export function editSimilarity(a, b) {
  const x = normText(a), y = normText(b);
  const L = Math.max(x.length, y.length);
  return L === 0 ? 1 : 1 - editDistance(x, y) / L;
}

export function p50(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
