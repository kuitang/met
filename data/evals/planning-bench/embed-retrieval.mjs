import fs from "fs";
const KEY = process.env.GEMINI_API_KEY;
const objs = JSON.parse(fs.readFileSync("objects.json"));
const distract = JSON.parse(fs.readFileSync("gallery.json"));

async function embed(path) {
  const img = fs.readFileSync(path).toString("base64");
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now();
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent", {
      method: "POST", headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: img } }] }, outputDimensionality: 768 }),
    });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 20000)); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
    const v = j.embedding.values;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return { v: v.map(x => x / n), ms: Date.now() - t0 };
  }
  throw new Error("rate limited");
}

const galleryItems = [
  ...objs.map(o => ({ id: o.objectID, title: o.title, path: `images/${o.objectID}_orig.jpg` })),
  ...distract.map(o => ({ id: o.objectID, title: o.title, path: `gallery/${o.objectID}.jpg` })),
];
console.log(`gallery: ${galleryItems.length} catalog images; queries: ${objs.length} degraded photos`);

const embTimes = [];
for (const g of galleryItems) {
  const e = await embed(g.path); g.emb = e.v; embTimes.push(e.ms);
  await new Promise(s => setTimeout(s, 500));
}
let top1 = 0, top5 = 0, results = [];
for (const o of objs) {
  const e = await embed(`images/${o.objectID}_photo.jpg`); embTimes.push(e.ms);
  const scored = galleryItems.map(g => ({ id: g.id, title: g.title, sim: g.emb.reduce((s, x, i) => s + x * e.v[i], 0) }))
    .sort((a, b) => b.sim - a.sim);
  const rank = scored.findIndex(s => s.id === o.objectID) + 1;
  if (rank === 1) top1++;
  if (rank >= 1 && rank <= 5) top5++;
  results.push({ id: o.objectID, title: o.title.slice(0, 50), famous: o.isHighlight, rank, best: scored[0].title.slice(0, 40), sim: +scored[0].sim.toFixed(3) });
  await new Promise(s => setTimeout(s, 500));
}
fs.writeFileSync("results/embed-retrieval.json", JSON.stringify(results, null, 1));
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(results.map(r => `rank ${String(r.rank).padStart(2)} ${r.famous ? "F" : "o"} ${r.title}`).join("\n"));
console.log(`\ngemini-embedding-2 image retrieval over ${galleryItems.length}-img gallery: top-1 ${top1}/${objs.length}, top-5 ${top5}/${objs.length}; embed p50 ${med(embTimes)}ms`);
