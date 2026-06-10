/**
 * GET /api/v1/img/:objectID — disk-cached proxy for Met CDN object images.
 * FALLBACK ONLY: clients load image bytes from the public Tigris bucket of
 * pre-generated derivatives first (objects.thumbKey →
 * apps/mobile/src/data/imageCdn.ts) — bytes bypass this server entirely on
 * the happy path. This route exists for objects without a thumbKey yet
 * (newer than the last thumbnail run / pre-thumbKey artifacts) and as the
 * web client's onError fallback when a bucket fetch fails.
 *
 * Why a proxy at all: the web client runs cross-origin isolated (COEP:
 * require-corp for SharedArrayBuffer/expo-sqlite) and images.metmuseum.org
 * sends no CORS/CORP headers (measured 2026-06-10), so the browser cannot
 * embed the Met CDN directly. Only objectIDs with a non-empty imageUrl in
 * met.sqlite are served — this is not an open proxy.
 *
 * Cache (Fly: single small VM, 1-3 GB volume at DATA_DIR, egress costs
 * money, machine may restart anytime):
 *  - Files live at DATA_DIR/img-cache/{objectID}.jpg on the volume, so the
 *    cache survives restarts and is shared across deploys.
 *  - Writes go to a temp file and are atomically renamed — a crash mid
 *    download never leaves a servable partial file; leftover *.tmp files are
 *    swept at startup.
 *  - Manifest-free LRU: total size = startup directory scan + per-write
 *    accounting. When it exceeds IMG_CACHE_MAX_MB (default 512) the
 *    oldest-mtime files are evicted down to 80%; cache hits touch mtime.
 *  - In-flight dedupe: concurrent misses for the same id share one upstream
 *    fetch (the first request tees its body to the client and to disk;
 *    followers await the disk write, then serve the cached file).
 *
 * Headers: long immutable Cache-Control (objectID→image is stable; catalog
 * updates bump dataVersion and clients cache-bust with ?v=), ACAO * + CORP
 * cross-origin so the cross-origin dev setup (expo :8081 page, API :8787)
 * embeds these images under COEP too. Images are public CC0 — `*` is correct.
 */
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url))
const SQLITE_PATH = path.join(DATA_DIR, 'met.sqlite')
const CACHE_DIR = path.join(DATA_DIR, 'img-cache')
const MAX_CACHE_BYTES = Number(process.env.IMG_CACHE_MAX_MB ?? 512) * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
// Browser UA, same precedent as data/src/objects.ts (Met CDN sits behind a WAF)
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const STATIC_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Access-Control-Allow-Origin': '*',
  // require-corp pages embed no-cors <img> only when the response opts in:
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const

// met.sqlite (read-only; same lazy-retry pattern as routes/locate.ts so the
// server picks the artifact up as soon as the nightly build lands).
let db: Database.Database | null = null
function imageUrlOf(objectID: number): string | null {
  if (!db) {
    try {
      db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true })
    } catch {
      return null
    }
  }
  const row = db
    .prepare('SELECT imageUrl FROM objects WHERE objectID = ?')
    .get(objectID) as { imageUrl: string } | undefined
  return row?.imageUrl || null
}

// ---------------------------------------------------------------------------
// Cache bookkeeping
// ---------------------------------------------------------------------------
let cacheBytes = 0
const cacheReady = (async () => {
  await mkdir(CACHE_DIR, { recursive: true })
  for (const f of await readdir(CACHE_DIR)) {
    const p = path.join(CACHE_DIR, f)
    if (f.endsWith('.tmp')) {
      await unlink(p).catch(() => {}) // crashed mid-download last run
      continue
    }
    cacheBytes += (await stat(p).catch(() => null))?.size ?? 0
  }
})()

/** Evict oldest-mtime files until the cache is back under 80% of the cap. */
async function evictIfNeeded(): Promise<void> {
  if (cacheBytes <= MAX_CACHE_BYTES) return
  const entries = []
  for (const f of await readdir(CACHE_DIR)) {
    if (f.endsWith('.tmp')) continue
    const s = await stat(path.join(CACHE_DIR, f)).catch(() => null)
    if (s) entries.push({ f, size: s.size, mtimeMs: s.mtimeMs })
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const target = MAX_CACHE_BYTES * 0.8
  for (const e of entries) {
    if (cacheBytes <= target) break
    await unlink(path.join(CACHE_DIR, e.f)).catch(() => {})
    cacheBytes -= e.size
    console.log(`img-cache: evicted ${e.f} (${e.size} B, total ${cacheBytes} B)`)
  }
}

// objectID → promise that resolves when its cache file is written (or failed)
const inflight = new Map<number, Promise<void>>()

export const imgRoutes = new Hono()

imgRoutes.get('/:objectID', async (c) => {
  await cacheReady
  const objectID = Number(c.req.param('objectID'))
  const url = Number.isInteger(objectID) && objectID > 0 ? imageUrlOf(objectID) : null
  if (!url) {
    return c.json(
      { error: { code: 'not_found', message: 'Unknown object or object has no image' } },
      404,
    )
  }

  const file = path.join(CACHE_DIR, `${objectID}.jpg`)
  const serveCached = async () => {
    const s = await stat(file).catch(() => null)
    if (!s) return null
    const now = new Date()
    utimes(file, now, now).catch(() => {}) // LRU touch
    return c.body(
      Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      200,
      {
        ...STATIC_HEADERS,
        'Content-Type': 'image/jpeg', // Met CDN serves JPEGs; cache is .jpg
        'Content-Length': String(s.size),
      },
    )
  }

  const hit = await serveCached()
  if (hit) return hit

  // Follower: another request is already downloading this id — wait for it
  // and serve the disk file it produced (one upstream fetch per burst).
  const pending = inflight.get(objectID)
  if (pending) {
    await pending
    const followed = await serveCached()
    if (followed) return followed
    return c.json(
      { error: { code: 'upstream_failed', message: 'Met image CDN fetch failed' } },
      502,
    )
  }

  // Leader: register the in-flight marker BEFORE fetching so concurrent
  // misses share this one upstream call. NOTE: no await between the
  // inflight.get above and this set — leader election is single-tick.
  let settle!: () => void
  inflight.set(objectID, new Promise<void>((resolve) => (settle = resolve)))
  const finish = () => {
    inflight.delete(objectID)
    settle()
  }

  console.log(`img-cache: miss ${objectID} -> ${url}`)
  let res: globalThis.Response | null = null
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    /* handled below */
  }
  if (!res?.ok || !res.body) {
    finish()
    return c.json(
      { error: { code: 'upstream_failed', message: 'Met image CDN fetch failed' } },
      502,
    )
  }

  // Stream to the client WHILE writing the cache file; atomic rename so a
  // partial download is never served (failed writes are unlinked, not cached).
  const [toClient, toDisk] = res.body.tee()
  const tmp = path.join(CACHE_DIR, `${objectID}.${Date.now()}.tmp`)
  void (async () => {
    try {
      await pipeline(
        Readable.fromWeb(toDisk as import('node:stream/web').ReadableStream),
        createWriteStream(tmp),
      )
      const s = await stat(tmp)
      await rename(tmp, file)
      cacheBytes += s.size
      await evictIfNeeded()
    } catch {
      await unlink(tmp).catch(() => {})
    } finally {
      finish()
    }
  })()

  const length = res.headers.get('content-length')
  return c.body(toClient as ReadableStream<Uint8Array>, 200, {
    ...STATIC_HEADERS,
    'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
    ...(length ? { 'Content-Length': length } : {}),
  })
})
