// Writes results/cache-index.json: a committed, diff-friendly index of every
// cached OpenRouter response (hash key, model, tokens, measured cost, latency,
// schema compliance) — the raw response bodies in cache/ stay gitignored.
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, RESULTS_DIR } from "./lib.mjs";

const entries = [];
for (const f of fs.readdirSync(CACHE_DIR)) {
  if (!f.endsWith(".json")) continue;
  const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
  entries.push({
    requestHash: f.replace(".json", ""),
    model: j.model,
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    usd: +(j.usage?.cost ?? 0).toFixed(8),
    latencyMs: j.latencyMs,
    schemaOkFirst: j.schemaOkFirst,
    variant: j.variant,
  });
}
const louvreDir = path.join(CACHE_DIR, "louvre");
const louvre = fs.existsSync(louvreDir) ? fs.readdirSync(louvreDir).length : 0;
entries.sort((a, b) => (a.model + a.requestHash).localeCompare(b.model + b.requestHash));
const summary = {};
for (const e of entries) {
  const s = (summary[e.model] ??= { calls: 0, usd: 0, promptTokens: 0, completionTokens: 0 });
  s.calls++;
  s.usd = +(s.usd + e.usd).toFixed(6);
  s.promptTokens += e.promptTokens;
  s.completionTokens += e.completionTokens;
}
fs.writeFileSync(
  path.join(RESULTS_DIR, "cache-index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), louvreRecordsCached: louvre, summary, entries }, null, 1),
);
console.log(`${entries.length} cached LLM responses, ${louvre} cached Louvre records`);
