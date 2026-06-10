import fs from "fs";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const objs = JSON.parse(fs.readFileSync("objects.json"));
const byId = Object.fromEntries(objs.map(o => [o.objectID, o]));

const MODELS = [
  { id: "gpt-5.4-mini", provider: "openai", in$: 0.75, out$: 4.50 },
  { id: "gpt-5.4-nano", provider: "openai", in$: 0.20, out$: 1.25 },
  { id: "gemini-3-flash-preview", provider: "gemini", in$: 0.50, out$: 3.00 },
  { id: "gemini-3.1-flash-lite", provider: "gemini", in$: 0.25, out$: 1.50 },
];

const b64 = p => fs.readFileSync(p).toString("base64");
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// ---------- provider calls (raw REST, structured JSON out, low/no reasoning) ----------
async function callOpenAI(model, sys, userText, imageB64) {
  const content = [{ type: "input_text", text: userText + " Respond only with the JSON object." }];
  if (imageB64) content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${imageB64}` });
  const body = {
    model, instructions: sys,
    input: [{ role: "user", content }],
    reasoning: { effort: "low" },
    text: { format: { type: "json_object" } },
  };
  for (const effort of ["low", "minimal", "medium"]) {
    body.reasoning.effort = effort;
    const t0 = Date.now();
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const j = await r.json();
    if (r.status === 400 && JSON.stringify(j).includes("effort")) continue; // unsupported effort, try next
    if (!r.ok) throw new Error(`${model} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("");
    return { ms, text, inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, effort };
  }
  throw new Error(`${model}: no accepted reasoning effort`);
}

async function callGemini(model, sys, userText, imageB64) {
  const parts = [];
  if (imageB64) parts.push({ inlineData: { mimeType: "image/jpeg", data: imageB64 } });
  parts.push({ text: userText });
  const mk = (thinking) => ({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", ...thinking },
  });
  const variants = [{ thinkingConfig: { thinkingLevel: "MINIMAL" } }, { thinkingConfig: { thinkingBudget: 0 } }, {}];
  let lastErr;
  for (const v of variants) {
    const t0 = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(mk(v)),
    });
    const ms = Date.now() - t0;
    const j = await r.json();
    if (r.status === 429) { await new Promise(s => setTimeout(s, 15000)); lastErr = "429"; continue; }
    if (!r.ok) { lastErr = `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 250)}`; continue; }
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    const u = j.usageMetadata || {};
    return { ms, text, inTok: u.promptTokenCount ?? 0, outTok: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), thinking: JSON.stringify(v) };
  }
  throw new Error(`${model}: ${lastErr}`);
}

const call = (m, sys, text, img) => m.provider === "openai" ? callOpenAI(m.id, sys, text, img) : callGemini(m.id, sys, text, img);

// ---------- tasks ----------
const QUERIES = [
  { q: "gold swords", expect: ["sword"] },
  { q: "monet", expect: ["monet"] },
  { q: "that huge painting of washington crossing a river in a boat", expect: ["washington"] },
  { q: "blue ming vases", expect: ["ming", "vase"] },
  { q: "ancient egyptian cat statues", expect: ["cat", "egypt"] },
  { q: "armor for horses", expect: ["armor", "horse"] },
  { q: "tiffany stained glass", expect: ["tiffany", "glass"] },
  { q: "paintings of the sea by dutch artists", expect: ["dutch"] },
  { q: "sphinx", expect: ["sphinx"] },
  { q: "impressionist gardens", expect: ["garden"] },
];
const INTERPRET_SYS = `You convert a museum visitor's search query into structured search parameters for The Met's collection database. Respond ONLY with JSON: {"keywords": string[], "artist": string|null, "classification": string|null, "material": string|null, "culture_or_period": string|null}. keywords are the essential search terms (singular nouns preferred).`;

const OCR_SYS = `You read photos of museum wall labels. Extract exactly what is printed. Respond ONLY with JSON: {"title": string|null, "artist": string|null, "date": string|null, "accession_number": string|null}. Use null for fields not present.`;

const ID_SYS = `A visitor at The Metropolitan Museum of Art photographed an artwork. Identify it if you can. Respond ONLY with JSON: {"title": string|null, "artist": string|null, "confidence": number}. confidence in [0,1]; use null title if unsure.`;

function titleMatch(got, want) {
  const g = norm(got), w = norm(want);
  if (!g) return false;
  if (g.includes(w) || w.includes(g)) return true;
  const gw = new Set(g.split(" ")), ww = w.split(" ").filter(x => x.length > 2);
  const hits = ww.filter(x => gw.has(x)).length;
  return ww.length > 0 && hits / ww.length >= 0.5;
}

async function runModel(m) {
  const rows = [];
  const safe = async (task, caseId, fn, score) => {
    try {
      const r = await fn();
      let parsed = null;
      try { parsed = JSON.parse(r.text); } catch { try { parsed = JSON.parse(r.text.replace(/^```json?\s*|\s*```$/g, "")); } catch {} }
      const ok = score(parsed, r.text);
      rows.push({ model: m.id, task, caseId, ok, ms: r.ms, inTok: r.inTok, outTok: r.outTok, out: (r.text || "").slice(0, 220) });
    } catch (e) {
      rows.push({ model: m.id, task, caseId, ok: false, ms: null, error: String(e).slice(0, 200) });
    }
    if (m.provider === "gemini") await new Promise(s => setTimeout(s, 4500)); // free-tier RPM safety
  };

  for (const c of QUERIES)
    await safe("interpret", c.q, () => call(m, INTERPRET_SYS, `Query: ${c.q}`),
      (p, raw) => c.expect.every(e => norm(raw).includes(e)));

  for (const f of fs.readdirSync("labels")) {
    const id = +f.split("_")[0], o = byId[id];
    await safe("label_ocr", String(id), () => call(m, OCR_SYS, "Extract the label fields.", b64(`labels/${f}`)),
      (p) => p && norm(p.accession_number).replace(/ /g, "") === norm(o.accession).replace(/ /g, ""));
  }

  for (const o of objs)
    await safe("artwork_id", String(o.objectID), () => call(m, ID_SYS, "Identify this artwork.", b64(`images/${o.objectID}_photo.jpg`)),
      (p) => p && titleMatch(p.title, o.title));

  return rows;
}

const RUN = process.env.ONLY ? MODELS.filter(m => m.provider === process.env.ONLY) : MODELS;
const all = (await Promise.all(RUN.map(runModel))).flat();
fs.writeFileSync(`results/llm-bench-${process.env.ONLY ?? "all"}.json`, JSON.stringify(all, null, 1));

// ---------- summarize ----------
const pct = x => (100 * x).toFixed(0) + "%";
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log("\n=== SUMMARY (accuracy | median ms | $/call) ===");
for (const m of RUN) {
  for (const task of ["interpret", "label_ocr", "artwork_id"]) {
    const rs = all.filter(r => r.model === m.id && r.task === task);
    const okRs = rs.filter(r => r.ms != null);
    const acc = rs.filter(r => r.ok).length / rs.length;
    const cost = okRs.length ? okRs.reduce((s, r) => s + r.inTok * m.in$ / 1e6 + r.outTok * m.out$ / 1e6, 0) / okRs.length : 0;
    const errs = rs.filter(r => r.error).length;
    console.log(`${m.id.padEnd(24)} ${task.padEnd(11)} acc ${pct(acc).padStart(4)} | p50 ${String(med(okRs.map(r => r.ms))).padStart(6)}ms | $${cost.toFixed(5)}/call${errs ? ` | ${errs} ERRORS` : ""}`);
  }
}
// famous vs obscure split for artwork_id
for (const m of RUN) {
  const rs = all.filter(r => r.model === m.id && r.task === "artwork_id");
  const f = rs.filter(r => byId[+r.caseId]?.isHighlight), ob = rs.filter(r => !byId[+r.caseId]?.isHighlight);
  console.log(`${m.id.padEnd(24)} artwork_id  famous ${f.filter(r => r.ok).length}/${f.length}  obscure ${ob.filter(r => r.ok).length}/${ob.length}`);
}
