import fs from "fs";
const OPENAI_KEY = process.env.OPENAI_API_KEY, GEMINI_KEY = process.env.GEMINI_API_KEY;
const { queries, gallery } = JSON.parse(fs.readFileSync("real-eval.json"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = p => fs.readFileSync(p).toString("base64");
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function titleMatch(got, want) {
  const g = norm(got), w = norm(want);
  if (!g) return false;
  if (g.includes(w) || w.includes(g)) return true;
  const gw = new Set(g.split(" ")), ww = w.split(" ").filter(x => x.length > 2);
  return ww.length > 0 && ww.filter(x => gw.has(x)).length / ww.length >= 0.5;
}
const ID_SYS = `A visitor at The Metropolitan Museum of Art photographed an artwork. Identify it if you can. Respond ONLY with JSON: {"title": string|null, "artist": string|null, "confidence": number}. confidence in [0,1]; use null title if unsure.`;

async function callOpenAI(model, img) {
  const t0 = Date.now();
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, instructions: ID_SYS, reasoning: { effort: "low" }, text: { format: { type: "json_object" } },
      input: [{ role: "user", content: [{ type: "input_text", text: "Identify this artwork. Respond only with the JSON object." }, { type: "input_image", image_url: `data:image/jpeg;base64,${img}` }] }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 180));
  return { ms: Date.now() - t0, text: (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join(""), inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0 };
}
async function callGemini(model, img) {
  for (let a = 0; a < 5; a++) {
    const t0 = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ID_SYS }] },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: img } }, { text: "Identify this artwork." }] }],
        generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "MINIMAL" } },
      }),
    });
    if (r.status === 429) { await sleep(20000); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 180));
    const u = j.usageMetadata || {};
    return { ms: Date.now() - t0, text: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join(""), inTok: u.promptTokenCount ?? 0, outTok: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
  }
  throw new Error("429s");
}
async function embed(path) {
  const img = b64(path);
  for (let a = 0; a < 6; a++) {
    const t0 = Date.now();
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent", {
      method: "POST", headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: img } }] }, outputDimensionality: 768 }),
    });
    if (r.status === 429) { await sleep(20000); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 180));
    const v = j.embedding.values, n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return { v: v.map(x => x / n), ms: Date.now() - t0 };
  }
  throw new Error("429s");
}

const MODELS = [
  { id: "gpt-5.4-mini", call: i => callOpenAI("gpt-5.4-mini", i), gap: 300, in$: 0.75, out$: 4.5 },
  { id: "gpt-5.4-nano", call: i => callOpenAI("gpt-5.4-nano", i), gap: 300, in$: 0.2, out$: 1.25 },
  { id: "gemini-3-flash-preview", call: i => callGemini("gemini-3-flash-preview", i), gap: 4500, in$: 0.5, out$: 3.0 },
  { id: "gemini-3.1-flash-lite", call: i => callGemini("gemini-3.1-flash-lite", i), gap: 4500, in$: 0.25, out$: 1.5 },
];

async function llmLane(m) {
  const rows = [];
  for (const q of queries) {
    try {
      const r = await m.call(b64(`metds/${q.path}`));
      let p = null; try { p = JSON.parse(r.text); } catch {}
      rows.push({ model: m.id, id: q.MET_id, ok: p && titleMatch(p.title, q.title), ms: r.ms, cost: r.inTok * m.in$ / 1e6 + r.outTok * m.out$ / 1e6, got: p?.title?.slice(0, 60) ?? null });
    } catch (e) { rows.push({ model: m.id, id: q.MET_id, ok: false, ms: null, error: String(e).slice(0, 120) }); }
    await sleep(m.gap);
  }
  return rows;
}
async function embLane() {
  const g = [];
  for (const it of gallery) { try { g.push({ ...it, emb: (await embed(`realgallery/${it.id}.jpg`)).v }); } catch {} await sleep(450); }
  const rows = [];
  for (const q of queries) {
    try {
      const e = await embed(`metds/${q.path}`);
      const scored = g.map(x => ({ id: x.id, sim: x.emb.reduce((s, v, i) => s + v * e.v[i], 0) })).sort((a, b) => b.sim - a.sim);
      const rank = scored.findIndex(s => s.id === q.MET_id) + 1;
      rows.push({ model: "gemini-embedding-2", id: q.MET_id, rank, top1: rank === 1, top5: rank >= 1 && rank <= 5, ms: e.ms });
    } catch (e) { rows.push({ model: "gemini-embedding-2", id: q.MET_id, rank: 0, error: String(e).slice(0, 120) }); }
    await sleep(450);
  }
  return rows;
}

const [emb, ...llm] = await Promise.all([embLane(), ...MODELS.map(llmLane)]);
fs.writeFileSync("results/real-guest-photos.json", JSON.stringify({ emb, llm: llm.flat() }, null, 1));
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`\n=== REAL GUEST PHOTOS (n=${queries.length}, gallery=${gallery.length}) ===`);
for (const rows of llm) {
  const m = rows[0].model, errs = rows.filter(r => r.error).length;
  const cost = rows.filter(r => r.cost).reduce((s, r) => s + r.cost, 0) / Math.max(1, rows.filter(r => r.cost).length);
  console.log(`${m.padEnd(24)} ID acc ${rows.filter(r => r.ok).length}/${rows.length} | p50 ${med(rows.map(r => r.ms))}ms | $${cost.toFixed(5)}/call${errs ? ` | ${errs} errors` : ""}`);
}
console.log(`gemini-embedding-2       top-1 ${emb.filter(r => r.top1).length}/${emb.length} | top-5 ${emb.filter(r => r.top5).length}/${emb.length} | p50 ${med(emb.map(r => r.ms))}ms`);
