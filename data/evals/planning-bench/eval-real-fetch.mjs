import fs from "fs";
const API = "https://collectionapi.metmuseum.org/public/collection/v1";
const ts = JSON.parse(fs.readFileSync("metds/testset.json"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// deterministic spread over the 1132 met queries
const metQ = ts.filter(t => t.MET_id != null);
const step = Math.floor(metQ.length / 90);
const candidates = Array.from({ length: 90 }, (_, i) => metQ[i * step]);

const meta = {};
async function obj(id) {
  if (meta[id] !== undefined) return meta[id];
  try {
    const o = await (await fetch(`${API}/objects/${id}`)).json();
    meta[id] = (o && o.primaryImageSmall) ? { id, title: o.title, artist: o.artistDisplayName, img: o.primaryImageSmall, dept: o.department } : null;
  } catch { meta[id] = null; }
  await sleep(110);
  return meta[id];
}

const queries = [];
for (const c of candidates) {
  const o = await obj(c.MET_id);
  if (o) queries.push({ ...c, title: o.title, artist: o.artist });
  if (queries.length >= 40) break;
}
// distractors: other met-query objects (confusables guests actually photographed) — up to 260
const distractors = [];
for (let i = 1; i < metQ.length && distractors.length < 260; i += 4) {
  const id = metQ[i].MET_id;
  if (queries.some(q => q.MET_id === id) || distractors.some(d => d.id === id)) continue;
  const o = await obj(id);
  if (o) distractors.push(o);
}
fs.mkdirSync("realgallery", { recursive: true });
const galleryIds = [...new Set([...queries.map(q => q.MET_id), ...distractors.map(d => d.id)])];
let n = 0;
for (const id of galleryIds) {
  const o = meta[id];
  try {
    const buf = Buffer.from(await (await fetch(o.img)).arrayBuffer());
    fs.writeFileSync(`realgallery/${id}.jpg`, buf); n++;
  } catch {}
  await sleep(110);
}
fs.writeFileSync("real-eval.json", JSON.stringify({ queries, gallery: galleryIds.filter(id => fs.existsSync(`realgallery/${id}.jpg`)).map(id => ({ id, title: meta[id].title })) }, null, 1));
console.log(`queries: ${queries.length}, gallery images: ${n}`);
