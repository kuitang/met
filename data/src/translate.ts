/**
 * translate.ts — source-language→EN translation post-processor, one museum
 * at a time (`--museum`). Reads snapshots/objects.json.gz, fills `titleAlt`
 * (English display+search title; `title` stays in the source language) and
 * ENGLISHIFIES the facet columns (culture/period/classification/medium — they
 * feed filters and the interpret vocabulary, which must be monolingual),
 * appending the source-language originals to `tags` so they stay FTS-
 * searchable. Built for Louvre (D6, French); D9 (Rijksmuseum, Dutch)
 * generalized the hardcoded "French" prompt wording into a registry-driven
 * parameter — `MuseumInfo.translateFrom` (registry.ts) selects both the
 * source string this reads for logging/prompting and the ISO code passed to
 * `systemPrompt()`/`callOpenRouter()` (see LANGUAGE_NAMES). Rijksmuseum's
 * vocab fields (culture/period/classification/medium) are already resolved
 * bilingual at the source (see sources/rijksmuseum.ts) — this still runs the
 * same pass-through call for them (DeepSeek EN->EN is a near-free no-op,
 * cached per distinct value afterward), only `title` genuinely needs
 * translating for that museum.
 *
 * Model: DeepSeek V4 Flash via OpenRouter — Kui-approved 2026-07-05 after the
 * measured bake-off (data/evals/reports/llm-bakeoff.md): statistically tied
 * with the incumbent at 5.1× lower cost. TRANSLATION ONLY — synonyms and all
 * runtime LLM calls stay Gemini (locked architecture rule; OpenRouter never
 * appears in the product server). Baseline prompt (the bake-off's prompt-
 * variant arm measured no gain from few-shot/glossary additions), T=0,
 * reasoning off, and ID-KEYED batches — the bake-off caught DeepSeek
 * returning echo-keyed batches off by one; id-keying makes that structural
 * failure impossible.
 *
 * Incremental + cached: data/museums/{id}/snapshots/translations.json maps
 * exact source-language string → English, split {titles, vocab}. Existing
 * keys never re-hit the API (a rerun on an unchanged snapshot costs $0).
 * Atomic writes.
 *
 * Usage: OPENROUTER_API_KEY=$(cat ~/.openrouter_key) tsx src/translate.ts --museum louvre
 *   (or --museum rijksmuseum, etc. — source language comes from the registry)
 *   TRANSLATE_MODEL overrides the model id (default deepseek/deepseek-v4-flash).
 *   MET_DATA_DIR overrides the data root (nightly stage dir).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type { ObjectRow } from "./sources/types.ts";
import { museumInfo } from "./sources/registry.ts";

const DATA_DIR = process.env.MET_DATA_DIR
  ? path.resolve(process.env.MET_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.TRANSLATE_MODEL ?? "deepseek/deepseek-v4-flash";
const BATCH = 40;
const CONCURRENCY = 4;

interface Translations {
  model: string;
  titles: Record<string, string>;
  vocab: Record<string, string>;
}

// Registry-driven: MuseumInfo.translateFrom carries the ISO code (louvre "fr",
// rijksmuseum "nl", ...); this is just the display name for the prompt.
const LANGUAGE_NAMES: Record<string, string> = { fr: "French", nl: "Dutch" };

function systemPrompt(langCode: string): string {
  const lang = LANGUAGE_NAMES[langCode] ?? langCode;
  return `You translate ${lang} museum-catalog strings to English for a search index.
Artwork titles: use the conventional English title where one exists (e.g. "La Joconde" -> "Mona Lisa"), otherwise translate faithfully. Materials, techniques, periods and object types: use standard art-historical vocabulary (e.g. "huile sur toile" -> "oil on canvas"). Keep proper nouns and artist names unchanged. Return ONLY the JSON asked for, no explanations.`;
}

async function callOpenRouter(items: Record<string, string>, langCode: string): Promise<Record<string, string>> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY required (translation runs are pipeline-only)");
  const lang = LANGUAGE_NAMES[langCode] ?? langCode;
  const user = `Translate each ${lang} string to English. Input is a JSON object keyed by id; return a JSON object with the SAME ids mapping to the English translations.\n\n${JSON.stringify(items)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(langCode) },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      if (attempt >= 6) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 30_000)));
      continue;
    }
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    try {
      const out = JSON.parse(body.choices[0].message.content) as Record<string, string>;
      // Id-keyed contract: every requested id must come back a non-empty string.
      const missing = Object.keys(items).filter((k) => typeof out[k] !== "string" || !out[k].trim());
      if (missing.length) throw new Error(`missing ids: ${missing.slice(0, 5).join(",")}`);
      return out;
    } catch (err) {
      if (attempt >= 6) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function translateAll(
  todo: Map<string, string>, // id → source-language string
  label: string,
  langCode: string,
): Promise<Map<string, string>> {
  const ids = [...todo.keys()];
  const out = new Map<string, string>();
  let done = 0;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  let bi = 0;
  async function worker() {
    while (bi < batches.length) {
      const batch = batches[bi++];
      const req: Record<string, string> = {};
      for (const id of batch) req[id] = todo.get(id)!;
      const res = await callOpenRouter(req, langCode);
      for (const id of batch) out.set(id, res[id].trim());
      done += batch.length;
      if (done % 400 < BATCH) console.log(`${label}: ${done}/${ids.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const museumIdx = process.argv.indexOf("--museum");
  const museum = museumIdx >= 0 ? process.argv[museumIdx + 1] : "louvre";
  const langCode = museumInfo(museum).translateFrom ?? "fr";
  const snapDir =
    museum === "met"
      ? path.join(DATA_DIR, "snapshots")
      : path.join(DATA_DIR, "museums", museum, "snapshots");
  const objectsPath = path.join(snapDir, "objects.json.gz");
  const cachePath = path.join(snapDir, "translations.json");

  const rows: ObjectRow[] = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(objectsPath)).toString("utf8"),
  );
  const cache: Translations = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
    : { model: MODEL, titles: {}, vocab: {} };

  // Collect untranslated strings, deduped: titles keyed by exact source-
  // language title, facet values by exact source-language value (shared
  // across rows). Batch payloads use short numeric ids, folded back to the
  // source-language key after.
  const titleTodo = new Map<string, string>();
  const vocabTodo = new Map<string, string>();
  const titleStrings = [...new Set(rows.map((r) => r.title).filter((t) => t && cache.titles[t] === undefined))];
  titleStrings.forEach((t, i) => titleTodo.set(String(i), t));
  const vocabStrings = [
    ...new Set(
      rows
        .flatMap((r) => [r.culture, r.period, r.classification, r.medium])
        .filter((v) => v && cache.vocab[v] === undefined),
    ),
  ];
  vocabStrings.forEach((v, i) => vocabTodo.set(String(i), v));

  console.log(
    `translate[${museum}]: ${rows.length} rows — ${titleTodo.size} new titles, ${vocabTodo.size} new vocab values (model ${MODEL})`,
  );

  if (vocabTodo.size) {
    const res = await translateAll(vocabTodo, "vocab", langCode);
    for (const [id, src] of vocabTodo) cache.vocab[src] = res.get(id)!;
  }
  if (titleTodo.size) {
    const res = await translateAll(titleTodo, "titles", langCode);
    for (const [id, src] of titleTodo) cache.titles[src] = res.get(id)!;
  }
  fs.writeFileSync(cachePath + ".tmp", JSON.stringify(cache, null, 1));
  fs.renameSync(cachePath + ".tmp", cachePath);

  // Apply: titleAlt from titles (skip when English == source — no index value);
  // facets → English; source-language facet originals appended to tags
  // (searchable at the tags FTS weight).
  const applied = rows.map((r) => {
    const en = cache.titles[r.title];
    const srcFacets = [r.culture, r.period, r.classification, r.medium].filter(Boolean);
    const facet = (v: string) => (v && cache.vocab[v]) || v;
    const extraTags = srcFacets.filter((v) => cache.vocab[v] && cache.vocab[v] !== v);
    return {
      ...r,
      titleAlt: en && en !== r.title ? en : (r.titleAlt ?? ""),
      culture: facet(r.culture),
      period: facet(r.period),
      classification: facet(r.classification),
      medium: facet(r.medium),
      tags: [r.tags, ...extraTags].filter(Boolean).join("|"),
    };
  });
  fs.writeFileSync(objectsPath + ".tmp", zlib.gzipSync(JSON.stringify(applied)));
  fs.renameSync(objectsPath + ".tmp", objectsPath);
  const translated = applied.filter((r) => r.titleAlt).length;
  console.log(
    `translate[${museum}]: applied — ${translated}/${rows.length} rows carry titleAlt, ${Object.keys(cache.vocab).length} vocab entries cached`,
  );
}

main();
