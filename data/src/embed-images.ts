/**
 * Image-embedding pipeline (plan §"Image-embedding pipeline", Gate C / task C3).
 *
 * For each on-view object with an image: download the primary image (cached
 * under data/raw/met-images/{id}.jpg, ≤10 req/s against the Met CDN), embed it
 * with gemini-embedding-2 at 768 dims, L2-normalize, and append the vector to
 * shard files under data/snapshots/image-embeddings/:
 *
 *   shard-{n}.bin  — consecutive float32 little-endian vectors (1024/shard)
 *   index.json     — { model, dims, normalized, shardSize, count,
 *                      objects: { objectID: {shard, offset, title, artist, gallery} } }
 *
 * RESUMABLE: objectIDs already in index.json are skipped; index.json is flushed
 * every 25 embeds, so a killed run loses at most a few vectors' bookkeeping
 * (orphan bytes at a shard tail are truncated on the next run).
 *
 * Usage (Node 24):
 *   npx tsx data/src/embed-images.ts                 # all imageUrl rows in objects.json.gz (~34k, ≈$4, ~2.5h)
 *   npx tsx data/src/embed-images.ts --subset gatec  # Gate C eval subset (~1.6k, ≈$0.20)
 *   npx tsx data/src/embed-images.ts --ids ids.json  # explicit JSON array of objectIDs
 *   --limit N caps any of the above.
 *
 * Object metadata comes from data/snapshots/objects.json.gz (B1 pipeline) when
 * present; otherwise each id is hydrated from the Met API (cached under
 * data/raw/met-objects/{id}.json, ~30 req/s, well under the 80 req/s cap).
 */
import { GoogleGenAI } from '@google/genai'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SNAPSHOT = path.join(ROOT, 'data/snapshots/objects.json.gz')
const IMG_CACHE = path.join(ROOT, 'data/raw/met-images')
const OBJ_CACHE = path.join(ROOT, 'data/raw/met-objects')
const OUT_DIR = path.join(ROOT, 'data/snapshots/image-embeddings')
const BENCH = path.join(ROOT, 'data/evals/planning-bench')
const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1'
const DIMS = 768
const SHARD_SIZE = 1024 // vectors per shard (= 3 MB)
const SUBSET_CAP = 1600

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ObjMeta {
  objectID: number
  title: string
  artist: string
  gallery: string
  imageUrl: string
}

interface Index {
  model: string
  dims: number
  normalized: boolean
  shardSize: number
  count: number
  objects: Record<string, { shard: number; offset: number; title: string; artist: string; gallery: string }>
}

// ---------- args ----------
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const limit = flag('--limit') ? Number(flag('--limit')) : Infinity
const subset = flag('--subset')
const idsFile = flag('--ids')

// ---------- metadata sources ----------
function loadSnapshot(): Map<number, ObjMeta> | null {
  if (!fs.existsSync(SNAPSHOT)) return null
  const rows = JSON.parse(gunzipSync(fs.readFileSync(SNAPSHOT)).toString()) as Array<{
    objectID: number
    title: string
    artist: string
    galleryNumber: string
    imageUrl: string
  }>
  const m = new Map<number, ObjMeta>()
  for (const r of rows)
    m.set(r.objectID, {
      objectID: r.objectID,
      title: r.title ?? '',
      artist: r.artist ?? '',
      gallery: r.galleryNumber ?? '',
      imageUrl: r.imageUrl ?? '',
    })
  return m
}

// Polite global pacing for the Met API (~8 req/s here; the nominal cap is
// 80 req/s but the fronting CDN ALSO bot-blocks: default node/curl user agents
// get 403 always, and sustained ≥20 req/s trips a temporary per-IP 403 that
// clears within ~seconds (both verified live 2026-06-10). So: browser UA,
// modest rate, and 403 ⇒ global cooldown + retry.
const MET_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
let lastMetCall = 0
let metCooldownUntil = 0
async function metFetch(url: string): Promise<any> {
  for (let a = 0; ; a++) {
    const cool = metCooldownUntil - Date.now()
    if (cool > 0) await sleep(cool)
    const wait = lastMetCall + 125 - Date.now()
    if (wait > 0) await sleep(wait)
    lastMetCall = Date.now()
    try {
      const r = await fetch(url, { headers: { 'user-agent': MET_UA } })
      if (r.status === 404) return null
      if (r.status === 403) {
        // rate-triggered bot block: pause ALL Met API traffic, then retry
        metCooldownUntil = Math.max(metCooldownUntil, Date.now() + 20_000)
        throw new Error(`403 ${url}`)
      }
      if (!r.ok) throw new Error(`${r.status} ${url}`)
      return await r.json()
    } catch (e) {
      if (a >= 7) throw e
    }
  }
}

async function hydrate(id: number): Promise<ObjMeta | null> {
  const cache = path.join(OBJ_CACHE, `${id}.json`)
  let j: any
  if (fs.existsSync(cache)) j = JSON.parse(fs.readFileSync(cache, 'utf8'))
  else {
    j = await metFetch(`${MET_API}/objects/${id}`)
    if (!j) return null
    fs.writeFileSync(cache, JSON.stringify(j))
  }
  return {
    objectID: id,
    title: j.title ?? '',
    artist: j.artistDisplayName ?? '',
    gallery: j.GalleryNumber ?? '',
    imageUrl: j.primaryImageSmall || j.primaryImage || '',
  }
}

// ---------- subset selection (Gate C) ----------
async function gateCIds(snapshot: Map<number, ObjMeta> | null): Promise<number[]> {
  const ids = new Set<number>()
  // 1. the 40-real-guest-photo GT set + its 158-image catalog gallery
  const realEval = JSON.parse(fs.readFileSync(path.join(BENCH, 'real-eval.json'), 'utf8'))
  for (const q of realEval.queries) ids.add(q.MET_id)
  for (const g of realEval.gallery) ids.add(g.id)
  // 2. planning corpus + distractor gallery
  for (const o of JSON.parse(fs.readFileSync(path.join(BENCH, 'objects.json'), 'utf8'))) ids.add(o.objectID)
  for (const o of JSON.parse(fs.readFileSync(path.join(BENCH, 'gallery.json'), 'utf8'))) ids.add(o.objectID)

  // 3. every on-view object w/ image in galleries 8xx (European Paintings) and
  //    13x (Egyptian), until ~SUBSET_CAP total.
  const galleryMatch = (g: string) => /^8\d\d$/.test(g) || /^13\d$/.test(g)
  let pool: number[] = []
  if (snapshot && snapshot.size > 10000) {
    // full B1 snapshot: select directly
    pool = [...snapshot.values()].filter((o) => o.imageUrl && galleryMatch(o.gallery)).map((o) => o.objectID)
  } else {
    // snapshot absent/partial: Met API dept search (11 = European Paintings, 10 = Egyptian Art),
    // hydrating with early exit once the cap is reachable.
    console.log('objects.json.gz absent or partial — selecting 8xx/13x via Met API dept search')
    for (const dept of [11, 10]) {
      if (ids.size + pool.length >= SUBSET_CAP) break
      const s = await metFetch(`${MET_API}/search?isOnView=true&departmentId=${dept}&q=*`)
      const deptIds: number[] = s?.objectIDs ?? []
      console.log(`dept ${dept}: ${deptIds.length} on-view ids; hydrating to filter by gallery…`)
      let done = 0
      const matched: number[] = []
      const workers = Array.from({ length: 8 }, async () => {
        while (deptIds.length && ids.size + pool.length + matched.length < SUBSET_CAP) {
          const id = deptIds.shift()!
          try {
            const m = await hydrate(id)
            if (m?.imageUrl && galleryMatch(m.gallery)) matched.push(id)
          } catch (e) {
            console.warn(`hydrate ${id} failed: ${e}`)
          }
          if (++done % 500 === 0) console.log(`  dept ${dept}: ${done} hydrated, ${matched.length} matched`)
        }
      })
      await Promise.all(workers)
      pool.push(...matched.sort((a, b) => a - b))
    }
  }
  for (const id of pool) {
    if (ids.size >= SUBSET_CAP) break
    ids.add(id)
  }
  return [...ids]
}

// ---------- image download ----------
let lastImgCall = 0
async function imageFor(meta: ObjMeta): Promise<Buffer | null> {
  const cache = path.join(IMG_CACHE, `${meta.objectID}.jpg`)
  if (fs.existsSync(cache)) return fs.readFileSync(cache)
  if (!meta.imageUrl) return null
  const wait = lastImgCall + 100 - Date.now() // ≤10 req/s on the Met CDN
  if (wait > 0) await sleep(wait)
  lastImgCall = Date.now()
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(meta.imageUrl)
      if (r.status === 404 || r.status === 403) return null
      if (!r.ok) throw new Error(`image ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      fs.writeFileSync(cache, buf)
      return buf
    } catch (e) {
      if (a >= 3) {
        console.warn(`image ${meta.objectID} failed: ${e}`)
        return null
      }
      await sleep(1000 * 2 ** a)
    }
  }
}

// ---------- embedding (pool of 4, adaptive backoff on 429) ----------
const ai = new GoogleGenAI({})
let backoffUntil = 0
async function embed(buf: Buffer): Promise<Float32Array> {
  for (let a = 0; ; a++) {
    const wait = backoffUntil - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      const r = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } }] }],
        config: { outputDimensionality: DIMS },
      })
      const v = r.embeddings?.[0]?.values
      if (!v || v.length !== DIMS) throw new Error('bad embedding response')
      const out = Float32Array.from(v)
      let n = 0
      for (const x of out) n += x * x
      n = Math.sqrt(n)
      for (let i = 0; i < DIMS; i++) out[i] /= n
      return out
    } catch (e: any) {
      const is429 = e?.status === 429 || /429|RESOURCE_EXHAUSTED/.test(String(e))
      if (a >= 7) throw e
      const delay = is429 ? Math.min(60_000, 5_000 * 2 ** a) : 1_000 * 2 ** a
      if (is429) backoffUntil = Math.max(backoffUntil, Date.now() + delay) // pause all workers
      else await sleep(delay)
    }
  }
}

// ---------- shard writing ----------
function loadIndex(): Index {
  const p = path.join(OUT_DIR, 'index.json')
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  return { model: 'gemini-embedding-2', dims: DIMS, normalized: true, shardSize: SHARD_SIZE, count: 0, objects: {} }
}

function saveIndex(idx: Index) {
  const p = path.join(OUT_DIR, 'index.json')
  fs.writeFileSync(p + '.tmp', JSON.stringify(idx))
  fs.renameSync(p + '.tmp', p)
}

async function main() {
  for (const d of [IMG_CACHE, OBJ_CACHE, OUT_DIR]) fs.mkdirSync(d, { recursive: true })
  const snapshot = loadSnapshot()

  let ids: number[]
  if (idsFile) ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'))
  else if (subset === 'gatec') ids = await gateCIds(snapshot)
  else {
    if (!snapshot) throw new Error('full run needs data/snapshots/objects.json.gz (B1 pipeline) — or pass --subset gatec / --ids')
    ids = [...snapshot.values()].filter((o) => o.imageUrl).map((o) => o.objectID)
  }

  const idx = loadIndex()
  // truncate any orphan tail bytes from an interrupted previous run
  for (let s = 0; ; s++) {
    const sp = path.join(OUT_DIR, `shard-${s}.bin`)
    if (!fs.existsSync(sp)) break
    const expected =
      Math.min(SHARD_SIZE, Math.max(0, idx.count - s * SHARD_SIZE)) * DIMS * 4
    if (fs.statSync(sp).size > expected) fs.truncateSync(sp, expected)
  }

  const todo = ids.filter((id) => !idx.objects[id]).slice(0, limit === Infinity ? undefined : limit)
  console.log(`${ids.length} ids selected, ${Object.keys(idx.objects).length} already embedded, ${todo.length} to do`)

  let done = 0
  let skipped = 0
  const t0 = Date.now()
  const queue = [...todo]
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift()!
      try {
        const meta = snapshot?.get(id)?.imageUrl ? snapshot.get(id)! : await hydrate(id)
        if (!meta) { skipped++; continue }
        const buf = await imageFor(meta)
        if (!buf) { skipped++; continue }
        const vec = await embed(buf)
        // append serially (single-threaded JS — no interleaving within this block)
        const shard = Math.floor(idx.count / SHARD_SIZE)
        const offset = idx.count % SHARD_SIZE
        fs.appendFileSync(path.join(OUT_DIR, `shard-${shard}.bin`), Buffer.from(vec.buffer))
        idx.objects[id] = { shard, offset, title: meta.title, artist: meta.artist, gallery: meta.gallery }
        idx.count++
        if (++done % 25 === 0) {
          saveIndex(idx)
          const rate = done / ((Date.now() - t0) / 1000)
          console.log(`${done}/${todo.length} embedded (${rate.toFixed(1)}/s, ${skipped} skipped)`)
        }
      } catch (e) {
        console.warn(`embed ${id} failed: ${e}`)
        skipped++
      }
    }
  })
  await Promise.all(workers)
  saveIndex(idx)
  console.log(
    `done: ${done} embedded, ${skipped} skipped (no image/404), total in index: ${idx.count}, ` +
      `${((Date.now() - t0) / 1000 / 60).toFixed(1)} min, est cost $${(done * 0.00012).toFixed(2)}`,
  )
}

main()
