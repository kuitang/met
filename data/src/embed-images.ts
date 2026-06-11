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
 * RESUMABLE + CONTENT-ADDRESSED: an objectID already in index.json is skipped
 * unless its imageHash (sha256 of the imageUrl it was embedded from) differs
 * from the snapshot's current imageUrl — the index is the durable embedding
 * cache, the corpus is NEVER re-embedded. index.json is flushed every 25
 * embeds, so a killed run loses at most a few vectors' bookkeeping (orphan
 * bytes at a shard tail are truncated on the next run).
 *
 * COMPACTION (--compact, run by the nightly pipeline before embedding): drops
 * (a) entries whose objectID is no longer in the snapshot (tombstones),
 * (b) entries whose imageHash no longer matches the snapshot imageUrl (they
 *     re-embed as new), and
 * (c) orphan vector rows no entry references — historical re-embeds appended
 *     a fresh row and re-pointed the map entry, leaving stale twins behind
 *     (3,017 of them measured on 2026-06-10) — then rewrites the shards
 *     densely and refreshes entry metadata from the snapshot. Entries from
 *     before content-addressing (no imageHash) are kept and backfilled with
 *     the current imageUrl hash (re-embedding 30k vectors to learn what we
 *     already have is exactly what the cache exists to avoid).
 *
 * Usage (Node 24):
 *   npx tsx data/src/embed-images.ts                 # all imageUrl rows in objects.json.gz (~34k, ≈$4, ~2.5h first time; only new/changed after)
 *   npx tsx data/src/embed-images.ts --compact       # tombstone + compaction only (no Gemini)
 *   npx tsx data/src/embed-images.ts --subset gatec  # Gate C eval subset (~1.6k, ≈$0.20)
 *   npx tsx data/src/embed-images.ts --ids ids.json  # explicit JSON array of objectIDs
 *   --limit N caps any of the above. MET_DATA_DIR overrides the data root
 *   (snapshots read/written under $MET_DATA_DIR/snapshots) like build-db.ts.
 *
 * Object metadata comes from data/snapshots/objects.json.gz (B1 pipeline) when
 * present; otherwise each id is hydrated from the Met API (cached under
 * data/raw/met-objects/{id}.json, ~30 req/s, well under the 80 req/s cap).
 */
import { GoogleGenAI } from '@google/genai'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '../..')
// MET_DATA_DIR overrides the data root (same contract as build-db.ts /
// synonyms.ts); the raw image/object caches stay repo-level — they are
// content-keyed by objectID and shared across staging dirs.
const DATA_ROOT = process.env.MET_DATA_DIR
  ? path.resolve(process.env.MET_DATA_DIR)
  : path.join(ROOT, 'data')
const SNAPSHOT = path.join(DATA_ROOT, 'snapshots/objects.json.gz')
const IMG_CACHE = path.join(ROOT, 'data/raw/met-images')
const OBJ_CACHE = path.join(ROOT, 'data/raw/met-objects')
const OUT_DIR = path.join(DATA_ROOT, 'snapshots/image-embeddings')
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

export interface IndexEntry {
  shard: number
  offset: number
  title: string
  artist: string
  gallery: string
  /** sha256 hex of the imageUrl the vector was embedded from (content address). */
  imageHash?: string
}

export interface Index {
  model: string
  dims: number
  normalized: boolean
  shardSize: number
  count: number
  objects: Record<string, IndexEntry>
}

export const imageHash = (imageUrl: string): string =>
  createHash('sha256').update(imageUrl).digest('hex')

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
/** `ignoreCache`: the disk cache is keyed by objectID only, so a re-embed
 * triggered by an imageUrl change must NOT trust the cached bytes. */
async function imageFor(meta: ObjMeta, ignoreCache = false): Promise<Buffer | null> {
  const cache = path.join(IMG_CACHE, `${meta.objectID}.jpg`)
  if (!ignoreCache && fs.existsSync(cache)) return fs.readFileSync(cache)
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
let _ai: GoogleGenAI | null = null
const ai = {
  get models() {
    if (!_ai) _ai = new GoogleGenAI({})
    return _ai.models
  },
}
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

function saveIndexTo(dir: string, idx: Index) {
  const p = path.join(dir, 'index.json')
  fs.writeFileSync(p + '.tmp', JSON.stringify(idx))
  fs.renameSync(p + '.tmp', p)
}
const saveIndex = (idx: Index) => saveIndexTo(OUT_DIR, idx)

// ---------- tombstone + compaction (see header) ----------
export interface CurrentObject {
  title: string
  artist: string
  gallery: string
  imageHash: string
}

export interface CompactionPlan {
  /** Old row numbers to keep, with their objectID, in old-row order. */
  keep: Array<{ row: number; objectID: number }>
  dropped: { offView: number; imageChanged: number; orphanRows: number }
}

/**
 * Pure planning step (unit-tested without shards): decide which vector rows
 * survive. A row survives iff an index entry references it, its objectID is
 * still in the current snapshot, and its content address (imageHash) — when it
 * has one — still matches the snapshot's imageUrl.
 */
export function planCompaction(idx: Index, current: Map<number, CurrentObject>): CompactionPlan {
  const keep: Array<{ row: number; objectID: number }> = []
  let offView = 0
  let imageChanged = 0
  const referenced = new Set<number>()
  for (const [id, e] of Object.entries(idx.objects)) {
    const row = e.shard * idx.shardSize + e.offset
    referenced.add(row)
    const cur = current.get(Number(id))
    if (!cur) {
      offView++
      continue
    }
    if (e.imageHash && e.imageHash !== cur.imageHash) {
      imageChanged++
      continue
    }
    keep.push({ row, objectID: Number(id) })
  }
  keep.sort((a, b) => a.row - b.row)
  return {
    keep,
    dropped: { offView, imageChanged, orphanRows: idx.count - referenced.size },
  }
}

/**
 * Apply a compaction plan: rewrite the shard files densely in keep-order and
 * emit a fresh index whose entry metadata (title/artist/gallery/imageHash) is
 * refreshed from the snapshot. Atomic per file (tmp + rename); stale shard
 * files beyond the new count are deleted.
 */
export function applyCompaction(
  dir: string,
  idx: Index,
  plan: CompactionPlan,
  current: Map<number, CurrentObject>,
): Index {
  const vecBytes = idx.dims * 4
  const oldShard = new Map<number, Buffer>()
  const readRow = (row: number): Buffer => {
    const s = Math.floor(row / idx.shardSize)
    if (!oldShard.has(s)) oldShard.set(s, fs.readFileSync(path.join(dir, `shard-${s}.bin`)))
    const off = (row % idx.shardSize) * vecBytes
    const buf = oldShard.get(s)!.subarray(off, off + vecBytes)
    if (buf.length !== vecBytes) throw new Error(`shard-${s}.bin truncated at row ${row}`)
    return buf
  }

  const next: Index = {
    model: idx.model,
    dims: idx.dims,
    normalized: idx.normalized,
    shardSize: idx.shardSize,
    count: plan.keep.length,
    objects: {},
  }
  const shardCount = Math.ceil(plan.keep.length / idx.shardSize)
  for (let s = 0; s < shardCount; s++) {
    const rows = plan.keep.slice(s * idx.shardSize, (s + 1) * idx.shardSize)
    const buf = Buffer.concat(rows.map((r) => readRow(r.row)))
    const p = path.join(dir, `shard-${s}.bin`)
    fs.writeFileSync(p + '.tmp', buf)
    fs.renameSync(p + '.tmp', p)
  }
  plan.keep.forEach(({ objectID }, newRow) => {
    const cur = current.get(objectID)!
    next.objects[objectID] = {
      shard: Math.floor(newRow / idx.shardSize),
      offset: newRow % idx.shardSize,
      title: cur.title,
      artist: cur.artist,
      gallery: cur.gallery,
      imageHash: cur.imageHash, // backfills pre-content-addressing entries
    }
  })
  saveIndexTo(dir, next)
  // remove shard files past the new tail (also handles count shrinking to 0)
  for (let s = shardCount; ; s++) {
    const p = path.join(dir, `shard-${s}.bin`)
    if (!fs.existsSync(p)) break
    fs.rmSync(p)
  }
  return next
}

function currentFromSnapshot(snapshot: Map<number, ObjMeta>): Map<number, CurrentObject> {
  const m = new Map<number, CurrentObject>()
  for (const o of snapshot.values()) {
    if (!o.imageUrl) continue // no image → nothing to keep a vector for
    m.set(o.objectID, {
      title: o.title,
      artist: o.artist,
      gallery: o.gallery,
      imageHash: imageHash(o.imageUrl),
    })
  }
  return m
}

function runCompaction(): void {
  const snapshot = loadSnapshot()
  if (!snapshot) throw new Error(`--compact needs ${SNAPSHOT}`)
  const idx = loadIndex()
  const current = currentFromSnapshot(snapshot)
  const plan = planCompaction(idx, current)
  const next = applyCompaction(OUT_DIR, idx, plan, current)
  console.log(
    `compacted: ${idx.count} rows → ${next.count} ` +
      `(dropped ${plan.dropped.orphanRows} orphan/duplicate rows, ` +
      `${plan.dropped.offView} off-view, ${plan.dropped.imageChanged} image-changed)`,
  )
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

  // Content-addressed skip: an id is done iff an entry exists AND (when both
  // sides have a content address) the entry's imageHash matches the snapshot's
  // current imageUrl. Hash-mismatched ids re-embed (append + re-point; the
  // orphaned old row is reclaimed by the next --compact).
  const needsEmbed = (id: number): boolean => {
    const e = idx.objects[id]
    if (!e) return true
    const url = snapshot?.get(id)?.imageUrl
    return Boolean(url && e.imageHash && e.imageHash !== imageHash(url))
  }
  const todo = ids.filter(needsEmbed).slice(0, limit === Infinity ? undefined : limit)
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
        // an existing entry here means a content-address mismatch → stale cache
        const buf = await imageFor(meta, Boolean(idx.objects[id]))
        if (!buf) { skipped++; continue }
        const vec = await embed(buf)
        // append serially (single-threaded JS — no interleaving within this block)
        const shard = Math.floor(idx.count / SHARD_SIZE)
        const offset = idx.count % SHARD_SIZE
        fs.appendFileSync(path.join(OUT_DIR, `shard-${shard}.bin`), Buffer.from(vec.buffer))
        idx.objects[id] = {
          shard,
          offset,
          title: meta.title,
          artist: meta.artist,
          gallery: meta.gallery,
          imageHash: imageHash(meta.imageUrl),
        }
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

// Run only when executed as a script (nightly.test.ts imports the compaction
// functions; importing must not kick off an embedding run).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  if (args.includes('--compact')) runCompaction()
  else void main()
}
