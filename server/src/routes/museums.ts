import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { components } from '@met/shared'

// GET /api/v1/museums — the multi-museum manifest, read straight from the
// artifact's meta.museums (written by data/src/build-db.ts from the registry).
// The client reads the identical JSON offline from its downloaded copy; this
// endpoint exists so the museum picker can show what a fresh download would
// contain (and per-museum freshness) before/without downloading.

const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url))
const SQLITE_PATH = path.join(DATA_DIR, 'met.sqlite')

type Manifest = components['schemas']['MuseumManifest']

let cached: { manifest: Manifest; mtimeMs: number } | null = null

function readManifest(): Manifest | null {
  if (!existsSync(SQLITE_PATH)) return null
  const db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true })
  try {
    const get = db.prepare('SELECT value FROM meta WHERE key = ?')
    const museumsRaw = (get.get('museums') as { value: string } | undefined)?.value
    const dataVersion = (get.get('dataVersion') as { value: string } | undefined)?.value
    const builtAt = (get.get('builtAt') as { value: string } | undefined)?.value
    if (!museumsRaw || !dataVersion || !builtAt) return null // pre-v2 artifact
    return { dataVersion, builtAt, museums: JSON.parse(museumsRaw) }
  } finally {
    db.close()
  }
}

export function invalidateMuseumsCache(): void {
  cached = null
}

export const museumsRoutes = new Hono()

museumsRoutes.get('/', (c) => {
  try {
    const mtimeMs = statSync(SQLITE_PATH).mtimeMs
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const manifest = readManifest()
      if (!manifest) throw new Error('no manifest')
      cached = { manifest, mtimeMs }
    }
    return c.json(cached.manifest)
  } catch {
    return c.json(
      { error: { code: 'data_unavailable', message: 'artifact not available yet' } },
      503,
    )
  }
})
