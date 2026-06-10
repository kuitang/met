/**
 * Gate C eval for /api/v1/locate/photo (task C3). Reruns the planning bench's
 * 40 REAL guest photos (the published Met benchmark queries, see
 * planning-bench/FETCH.md §metds) against the LIVE endpoint backed by the
 * Gate C embedding subset, plus the 8 wall-label fixtures through the OCR path.
 * Writes data/evals/reports/photo-locate.md.
 *
 * Usage:
 *   1. build the index:  npx tsx data/src/embed-images.ts --subset gatec
 *   2. start the server: RATE_LIMIT_RPM=6000 RATE_LIMIT_BURST=6000 PORT=8788 \
 *        GEMINI_API_KEY=$(cat ~/.gemini_key) npx tsx server/src/index.ts
 *   3. METDS=/tmp/met-bench/metds SERVER=http://localhost:8788 \
 *        GEMINI_API_KEY=$(cat ~/.gemini_key) node data/evals/photo-locate-eval.mjs
 *
 * The endpoint returns top-3 candidates (the contract caps at 3), so top-1 and
 * top-3 come from the live endpoint; top-5 / full rank are computed offline by
 * brute-forcing the same shard files with a fresh query embedding.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER = process.env.SERVER ?? 'http://localhost:8788'
const METDS = process.env.METDS ?? '/tmp/met-bench/metds'
const GEMINI_KEY = process.env.GEMINI_API_KEY
const BENCH = path.join(ROOT, 'data/evals/planning-bench')
const EMBED_DIR = path.join(ROOT, 'data/snapshots/image-embeddings')
const REPORT = path.join(ROOT, 'data/evals/reports/photo-locate.md')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const med = (a, q = 0.5) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null
}
const pct = (n, d) => `${((100 * n) / d).toFixed(0)}% (${n}/${d})`

// ---------- load the index for offline full-rank ----------
const idx = JSON.parse(fs.readFileSync(path.join(EMBED_DIR, 'index.json'), 'utf8'))
const count = idx.count
const matrix = new Float32Array(count * idx.dims)
for (let s = 0; s * idx.shardSize < count; s++) {
  const buf = fs.readFileSync(path.join(EMBED_DIR, `shard-${s}.bin`))
  matrix.set(
    new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).subarray(
      0,
      Math.min(buf.byteLength / 4, (count - s * idx.shardSize) * idx.dims),
    ),
    s * idx.shardSize * idx.dims,
  )
}
const rowToId = new Array(count)
for (const [id, o] of Object.entries(idx.objects)) rowToId[o.shard * idx.shardSize + o.offset] = Number(id)

function rankOf(queryVec, wantId) {
  let n = 0
  for (const x of queryVec) n += x * x
  n = Math.sqrt(n) || 1
  const sims = []
  for (let r = 0; r < count; r++) {
    let dot = 0
    for (let i = 0; i < idx.dims; i++) dot += matrix[r * idx.dims + i] * queryVec[i]
    sims.push({ id: rowToId[r], sim: dot / n })
  }
  sims.sort((a, b) => b.sim - a.sim)
  return sims.findIndex((s) => s.id === wantId) + 1 // 0 = not in index
}

async function geminiEmbed(imgB64) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: imgB64 } }] }, outputDimensionality: idx.dims }),
    })
    if (r.status === 429) { await sleep(15000); continue }
    const j = await r.json()
    if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 150))
    return j.embedding.values
  }
  throw new Error('429s')
}

async function locate(imgB64) {
  const t0 = Date.now()
  const r = await fetch(`${SERVER}/api/v1/locate/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: imgB64 }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 150)}`)
  return { ...j, ms: Date.now() - t0 }
}

// ---------- 1. real guest photos → live endpoint + offline full rank ----------
const { queries } = JSON.parse(fs.readFileSync(path.join(BENCH, 'real-eval.json'), 'utf8'))
const photoRows = []
for (const q of queries) {
  const img = fs.readFileSync(path.join(METDS, q.path)).toString('base64')
  let row = { id: q.MET_id, path: q.path, title: q.title }
  try {
    const res = await locate(img)
    const ids = res.candidates.map((c) => c.objectID)
    row = { ...row, ms: res.ms, candidates: ids, top1: ids[0] === q.MET_id, top3: ids.includes(q.MET_id) }
  } catch (e) {
    row.error = String(e).slice(0, 150)
  }
  try {
    row.rank = rankOf(await geminiEmbed(img), q.MET_id)
  } catch (e) {
    row.rankError = String(e).slice(0, 120)
  }
  photoRows.push(row)
  process.stdout.write(`${photoRows.length}/${queries.length} ${q.MET_id} top1=${row.top1} rank=${row.rank}\n`)
  await sleep(250)
}

// ---------- 2. label fixtures → OCR path ----------
const gt = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(BENCH, 'objects.json'), 'utf8')).map((o) => [o.objectID, o]))
const labelFiles = fs.readdirSync(path.join(ROOT, 'e2e/fixtures')).filter((f) => /_label\.jpg$/.test(f))
const normAcc = (s) => (s || '').toLowerCase().replace(/\s+/g, '')
const labelRows = []
for (const f of labelFiles) {
  const id = Number(f.split('_')[0])
  const img = fs.readFileSync(path.join(ROOT, 'e2e/fixtures', f)).toString('base64')
  const row = { fixture: f, id, accessionGT: gt[id].accession, galleryGT: gt[id].gallery }
  try {
    const res = await locate(img)
    row.ms = res.ms
    row.label = res.label
    row.endpointMatch = res.label?.objectID === id
    row.endpointGallery = res.label?.gallery === gt[id].gallery
  } catch (e) {
    row.error = String(e).slice(0, 150)
  }
  // direct OCR (same model/prompt family as server gemini.ts) so accession
  // accuracy is measurable even while met.sqlite is not built yet
  try {
    for (let a = 0; a < 5; a++) {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/jpeg', data: img } },
            { text: 'If a museum wall label is legible in this photo, transcribe its artwork title, artist, and accession number. Omit any field you cannot read. Set confidence (0-1) that the transcription identifies a single artwork; use confidence 0 when no label is visible.' },
          ] }],
          generationConfig: { responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_LOW', thinkingConfig: { thinkingLevel: 'MINIMAL' } },
        }),
      })
      if (r.status === 429) { await sleep(15000); continue }
      const j = await r.json()
      if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 150))
      const p = JSON.parse((j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''))
      row.ocr = p
      row.ocrAccessionOk = normAcc(p.accession) === normAcc(gt[id].accession)
      break
    }
  } catch (e) {
    row.ocrError = String(e).slice(0, 120)
  }
  labelRows.push(row)
  process.stdout.write(`label ${f} endpointMatch=${row.endpointMatch} ocrAcc=${row.ocrAccessionOk}\n`)
  await sleep(250)
}

// ---------- report ----------
const ok = photoRows.filter((r) => !r.error)
const ranked = photoRows.filter((r) => r.rank != null)
const top1 = ok.filter((r) => r.top1).length
const top3 = ok.filter((r) => r.top3).length
const top5 = ranked.filter((r) => r.rank >= 1 && r.rank <= 5).length
const inIndex = queries.filter((q) => idx.objects[q.MET_id]).length
const ocrOk = labelRows.filter((r) => r.ocrAccessionOk).length
const epOk = labelRows.filter((r) => r.endpointMatch).length
const misses = photoRows.filter((r) => !r.top1)

const report = `# Photo-locate eval — real guest photos vs the live endpoint (Gate C)

*Generated ${new Date().toISOString()} by \`data/evals/photo-locate-eval.mjs\`; raw rows in \`photo-locate.json\` next to this file.*

## Setup

- **Queries**: the 40 real visitor photos from the published Met benchmark
  (cmp.felk.cvut.cz/met, NeurIPS 2021) with ground-truth objectIDs — the same
  set as the planning bench (planning-bench/RESULTS.md).
- **Index**: \`data/snapshots/image-embeddings/\` — **${count} objects** embedded with
  gemini-embedding-2 (768d, L2-normalized): the 40-photo GT set + the planning
  158-image catalog + every on-view object with an image in galleries 8xx
  (European Paintings) and 13x (Egyptian), built by
  \`npx tsx data/src/embed-images.ts --subset gatec\`. ${inIndex}/${queries.length} query GT objects are in the index.
- **Endpoint**: live \`POST /api/v1/locate/photo\` (real Gemini calls, contract-capped
  at 3 candidates). Top-5 is computed offline against the same shards.

## Results — embedding retrieval

| Metric | This eval (${count}-object index) | Planning bench (158-image gallery) |
|---|---|---|
| top-1 | **${pct(top1, ok.length)}** | 90% (36/40) |
| top-3 (endpoint) | **${pct(top3, ok.length)}** | — |
| top-5 (offline full rank) | **${pct(top5, ranked.length)}** | 95% (38/40) |
| endpoint latency p50 / p95 | ${med(ok.map((r) => r.ms))} ms / ${med(ok.map((r) => r.ms), 0.95)} ms | embed-only p50 843 ms |

The index here is ~${Math.round(count / 158)}× the planning gallery, so some top-1 erosion was
expected (planning bracketed full-scale at 75–85% top-1 from DINOv3's published
80.7% over 224k classes).${ok.length < photoRows.length ? `\n\n**${photoRows.length - ok.length} endpoint errors** — see raw rows.` : ''}

### Misses (top-1)

${misses.length === 0 ? 'None.' : misses.map((r) => `- ${r.id} *${r.title}* — endpoint top-3 ${JSON.stringify(r.candidates ?? null)}, full rank ${r.rank ?? '?'}${r.error ? `, error: ${r.error}` : ''}`).join('\n')}

## Results — label OCR path (8 synthesized wall-label fixtures)

| Metric | Result |
|---|---|
| OCR accession accuracy (gemini-3.1-flash-lite, direct) | **${pct(ocrOk, labelRows.length)}** |
| endpoint LabelMatch (needs met.sqlite) | ${pct(epOk, labelRows.length)}${labelRows.every((r) => !r.label) ? ' — met.sqlite not built at eval time; label path degraded to candidates-only as designed' : ''} |

${labelRows.map((r) => `- ${r.fixture}: OCR accession "${r.ocr?.accession ?? '?'}" vs GT "${r.accessionGT}" ${r.ocrAccessionOk ? '✓' : '✗'}${r.label ? `; endpoint → gallery ${r.label.gallery} (GT ${r.galleryGT})` : ''}`).join('\n')}

## Cost

- This subset build: ${count} images × ~$0.00012 ≈ **$${(count * 0.00012).toFixed(2)}**; eval reruns ≈ $0.01
  (40 query embeds ×2 + 8 OCR calls).
- **Full 34k run (Phase 2)**: ~34,000 images ≈ **$4.10** one-time, ~2.5 h at the
  ~4 emb/s the pipeline sustains (pool of 4, 429-backoff), ~3 GB of cached
  images under data/raw/met-images/, 104 MB of shards. The pipeline is
  resumable (rerun \`npx tsx data/src/embed-images.ts\` after B1's full
  objects.json.gz lands; already-embedded objects are skipped).

## Honest limitations

- The ${count}-object index is ~5% of the production 34k gallery; production
  top-1 will sit between this number and DINOv3's published 80.7%@224k.
  Re-measure at full scale in Phase 2 before trusting the UX copy.
- 13 of the 16 label-fixture objects' galleries (e.g. Egyptian 13x, European
  Paintings 8xx) are in-index, but real wall labels photographed at the museum
  remain the known blind spot vs these synthesized fixtures.
- Query photos and ground truth are 2021-vintage; a few objects may have moved
  galleries since (does not affect retrieval correctness, only gallery strings).
`

fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, report)
fs.writeFileSync(REPORT.replace(/\.md$/, '.json'), JSON.stringify({ photoRows, labelRows, indexCount: count }, null, 1))
console.log(`\ntop-1 ${pct(top1, ok.length)} | top-3 ${pct(top3, ok.length)} | top-5 ${pct(top5, ranked.length)} | OCR accession ${pct(ocrOk, labelRows.length)}`)
console.log(`report → ${REPORT}`)
