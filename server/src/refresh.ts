/**
 * Nightly self-refresh: keep met.sqlite current without redeploys or manual
 * script runs (CLAUDE.md "Data refresh model").
 *
 * Schedule: a 60 s setInterval fires the job once per UTC day at
 * REFRESH_CRON_HOUR (default 4). RUN_REFRESH=0 disables the scheduler
 * (dev/test); POST /api/v1/admin/refresh (Bearer ADMIN_TOKEN) triggers the
 * same job manually either way.
 *
 * One refresh run:
 *   1. Objects delta, in-process at the measured-safe ≤10 req/s WAF budget:
 *      Met API `objects?metadataDate=` (changed IDs since the snapshot's
 *      fetchedAt) ∩ on-view, plus newly on-view IDs; re-hydrate only those,
 *      drop off-view rows, rewrite DATA_DIR/snapshots/objects.json.gz.
 *      Mirrors data/src/objects.ts row shape exactly (which stays the
 *      from-scratch/backfill tool — a delta run cannot bootstrap).
 *   2. Synonyms top-up: child `tsx data/src/synonyms.ts` (incremental — only
 *      vocab/titles new to the catalog hit Gemini, ≈$0). Skipped without
 *      GEMINI_API_KEY; failure is non-fatal (synonyms just go stale).
 *   3. Rebuild: child `tsx data/src/build-db.ts` with MET_DATA_DIR pointing at
 *      a staging dir whose snapshots/ symlinks DATA_DIR/snapshots — build-db's
 *      own verify gate runs before anything goes live.
 *   4. Atomic swap: stage/met.sqlite → DATA_DIR/met.sqlite.next (same fs),
 *      fsync, current met.sqlite kept as met.sqlite.prev (last-known-good),
 *      rename .next → met.sqlite, then write VERSION.
 *   5. Reload server handles: interpret's better-sqlite3 handle + response
 *      cache (vocab cache is keyed by handle, so it follows) and the
 *      photo-locate embedding index.
 *
 * Any step failing aborts the run and leaves the live artifact untouched —
 * the served met.sqlite only ever changes via the rename in step 4.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Hono } from 'hono'
import { reloadEmbeddingIndex } from './embeddings.js'
import { reopenInterpretDb } from './routes/interpret.js'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data')
const SNAP_DIR = path.join(DATA_DIR, 'snapshots')
const DB_PATH = path.join(DATA_DIR, 'met.sqlite')

const REFRESH_CRON_HOUR = Number(process.env.REFRESH_CRON_HOUR ?? 4)

// --- Met API client (same WAF etiquette as data/src/objects.ts: measured cap
// ~10 req/s, Imperva 403s are transient, session cookie keeps us one visitor)
const API = 'https://collectionapi.metmuseum.org/public/collection/v1'
const REQS_PER_SEC = 10
const CONCURRENCY = 4
const MAX_ATTEMPTS = 8
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const EXHIBITION_GALLERIES = new Set(['099', '199', '899', '964', '965', '999'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let cookie = ''
async function fetchJson(url: string): Promise<unknown> {
  let delay = 2000
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': UA, ...(cookie ? { cookie } : {}) },
      })
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      await sleep(delay)
      delay = Math.min(delay * 2, 60_000)
      continue
    }
    const setCookies = res.headers.getSetCookie()
    if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    if (res.ok) return res.json()
    if (res.status === 404) return null
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await sleep(res.status === 403 ? Math.max(delay, 60_000) : delay)
      delay = Math.min(delay * 2, 120_000)
      continue
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`)
  }
}

// Row shape contract with data/src/objects.ts + build-db.ts.
interface ObjectRow {
  objectID: number
  accession: string
  title: string
  artist: string
  culture: string
  period: string
  classification: string
  medium: string
  tags: string
  galleryNumber: string
  site: 'fifthAve' | 'cloisters'
  rotation: 'permanent' | 'exhibition'
  isHighlight: boolean
  imageUrl: string
  metadataDate: string
}

// galleryNumber → site from the committed geometry (same source as objects.ts).
let gallerySiteMap: Map<string, 'fifthAve' | 'cloisters'> | null = null
function siteForGallery(gallery: string): 'fifthAve' | 'cloisters' {
  if (!gallerySiteMap) {
    gallerySiteMap = new Map()
    try {
      const gj = JSON.parse(
        fs.readFileSync(path.join(SNAP_DIR, 'galleries.geojson'), 'utf8'),
      ) as { features: Array<{ properties: Record<string, unknown> }> }
      for (const f of gj.features) {
        const n = String(f.properties.galleryNumber ?? '').trim()
        const site = f.properties.site
        if (n && (site === 'fifthAve' || site === 'cloisters')) {
          gallerySiteMap.set(n, site)
          gallerySiteMap.set(n.replace(/^0+/, ''), site)
        }
      }
    } catch {
      console.warn('refresh: galleries.geojson unavailable — defaulting site to fifthAve')
    }
  }
  return (
    gallerySiteMap.get(gallery) ?? gallerySiteMap.get(gallery.replace(/^0+/, '')) ?? 'fifthAve'
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(obj: any): ObjectRow {
  const gallery = String(obj.GalleryNumber ?? '').trim()
  return {
    objectID: obj.objectID,
    accession: obj.accessionNumber ?? '',
    title: obj.title ?? '',
    artist: obj.artistDisplayName ?? '',
    culture: obj.culture ?? '',
    period: obj.period ?? '',
    classification: obj.classification ?? '',
    medium: obj.medium ?? '',
    tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => t.term).join('|') : '',
    galleryNumber: gallery,
    site: siteForGallery(gallery),
    rotation: EXHIBITION_GALLERIES.has(gallery) ? 'exhibition' : 'permanent',
    isHighlight: Boolean(obj.isHighlight),
    imageUrl: obj.primaryImageSmall ?? '',
    metadataDate: obj.metadataDate ?? '',
  }
}

/** Step 1: delta-update snapshots/objects.json.gz. Returns rows hydrated. */
async function refreshObjects(): Promise<number> {
  const snapPath = path.join(SNAP_DIR, 'objects.json.gz')
  const metaPath = path.join(SNAP_DIR, 'objects-meta.json')
  const known = new Map<number, ObjectRow>(
    (
      JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString('utf8')) as ObjectRow[]
    ).map((r) => [r.objectID, r]),
  )
  // Delta horizon: when the snapshot was last fetched (objects.ts writes it).
  // Fallback: 0000-00-00 never matches → metadataDate filter selects everything
  // changed, which is still bounded by the on-view intersection below.
  let since = '2000-01-01'
  try {
    since = (JSON.parse(fs.readFileSync(metaPath, 'utf8')).fetchedAt as string).slice(0, 10)
  } catch {
    console.warn(`refresh: no ${metaPath}; using full metadataDate horizon`)
  }

  const onView = (await fetchJson(`${API}/search?isOnView=true&q=*`)) as {
    total: number
    objectIDs: number[] | null
  }
  const onViewIds = new Set(onView.objectIDs ?? [])
  const changed = (await fetchJson(`${API}/objects?metadataDate=${since}`)) as {
    objectIDs: number[] | null
  } | null

  // Hydrate: anything on view we don't know yet, plus known-or-on-view objects
  // whose metadata changed since the last snapshot.
  const todo = new Set<number>()
  for (const id of onViewIds) if (!known.has(id)) todo.add(id)
  for (const id of changed?.objectIDs ?? []) {
    if (onViewIds.has(id) || known.has(id)) todo.add(id)
  }
  console.log(
    `refresh: ${onViewIds.size} on view, ${known.size} known, ${todo.size} to hydrate (since ${since})`,
  )

  const ids = [...todo]
  const interval = 1000 / REQS_PER_SEC
  let nextStart = Date.now()
  let i = 0
  async function worker(): Promise<void> {
    while (i < ids.length) {
      const id = ids[i++]
      const wait = nextStart - Date.now()
      nextStart = Math.max(nextStart, Date.now()) + interval
      if (wait > 0) await sleep(wait)
      const obj = await fetchJson(`${API}/objects/${id}`)
      if (obj === null || !String((obj as any).GalleryNumber ?? '').trim()) known.delete(id)
      else known.set(id, toRow(obj))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))

  // Drop rows that fell off view entirely (no longer in the on-view search).
  for (const id of [...known.keys()]) if (!onViewIds.has(id)) known.delete(id)

  const rows = [...known.values()].sort((a, b) => a.objectID - b.objectID)
  fs.writeFileSync(snapPath + '.tmp', zlib.gzipSync(JSON.stringify(rows)))
  fs.renameSync(snapPath + '.tmp', snapPath)
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        refreshedBy: 'server/src/refresh.ts',
        searchTotalOnView: onView.total,
        hydrated: ids.length,
        rows: rows.length,
      },
      null,
      2,
    ),
  )
  return ids.length
}

/** Child tsx runner for the data pipelines (kept reusable + locally runnable). */
function runPipeline(script: string, env: Record<string, string>): Promise<void> {
  const scriptPath = path.join(REPO_ROOT, 'data', 'src', script)
  const tsxBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const [cmd, args] = fs.existsSync(tsxBin)
    ? [tsxBin, [scriptPath]]
    : ['npx', ['tsx', scriptPath]]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)),
    )
  })
}

async function fsyncFile(p: string): Promise<void> {
  const fd = fs.openSync(p, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

let running = false
let lastRunDay = '' // UTC YYYY-MM-DD of the last scheduler-started run

/** The whole refresh job; returns false when one is already in flight. */
export async function runRefresh(trigger: 'cron' | 'admin'): Promise<boolean> {
  if (running) return false
  running = true
  const t0 = Date.now()
  console.log(`refresh: starting (${trigger})`)
  try {
    const hydrated = await refreshObjects()

    if (process.env.GEMINI_API_KEY) {
      try {
        await runPipeline('synonyms.ts', { MET_DATA_DIR: DATA_DIR })
      } catch (err) {
        console.warn('refresh: synonyms top-up failed (non-fatal):', err)
      }
    } else {
      console.log('refresh: no GEMINI_API_KEY — skipping synonyms top-up')
    }

    // Stage the rebuild so the live met.sqlite is untouched until the rename.
    const stage = path.join(DATA_DIR, '.refresh-stage')
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    fs.symlinkSync(SNAP_DIR, path.join(stage, 'snapshots'))
    await runPipeline('build-db.ts', { MET_DATA_DIR: stage })

    // Atomic swap with last-known-good: .next (fsynced) → met.sqlite, old → .prev
    const next = DB_PATH + '.next'
    fs.renameSync(path.join(stage, 'met.sqlite'), next) // same filesystem (DATA_DIR)
    await fsyncFile(next)
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_PATH + '.prev')
    fs.renameSync(next, DB_PATH)
    fs.copyFileSync(path.join(stage, 'VERSION'), path.join(DATA_DIR, 'VERSION'))
    fs.rmSync(stage, { recursive: true, force: true })

    // New artifact is live — point the in-process handles at it.
    reopenInterpretDb()
    reloadEmbeddingIndex()
    const version = fs.readFileSync(path.join(DATA_DIR, 'VERSION'), 'utf8').trim()
    console.log(
      `refresh: done in ${Math.round((Date.now() - t0) / 1000)}s — ` +
        `${hydrated} objects hydrated, dataVersion ${version}`,
    )
    return true
  } catch (err) {
    console.error('refresh: FAILED (live artifact untouched):', err)
    return true // a run happened (and failed); only "already running" is false
  } finally {
    running = false
  }
}

/** Daily scheduler. Call once at boot; no-op when RUN_REFRESH=0. */
export function startRefreshScheduler(): void {
  if (process.env.RUN_REFRESH === '0') {
    console.log('refresh: scheduler disabled (RUN_REFRESH=0)')
    return
  }
  console.log(`refresh: scheduled daily at ${REFRESH_CRON_HOUR}:00 UTC`)
  setInterval(() => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    if (now.getUTCHours() === REFRESH_CRON_HOUR && lastRunDay !== today && !running) {
      lastRunDay = today
      void runRefresh('cron')
    }
  }, 60_000).unref()
}

// --- POST /api/v1/admin/refresh (contract: shared/openapi.yaml triggerRefresh)
export const adminRefreshRoutes = new Hono()

adminRefreshRoutes.post('/', (c) => {
  const token = process.env.ADMIN_TOKEN
  if (!token) {
    // No token configured → the route does not exist, on purpose.
    return c.json({ error: { code: 'not_found', message: 'No such API route' } }, 404)
  }
  if (c.req.header('authorization') !== `Bearer ${token}`) {
    return c.json({ error: { code: 'unauthorized', message: 'Bad admin token' } }, 401)
  }
  if (running) {
    return c.json(
      { error: { code: 'refresh_in_progress', message: 'A refresh is already running' } },
      409,
    )
  }
  void runRefresh('admin')
  return c.json({ started: true }, 202)
})
