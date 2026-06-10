/**
 * POST /api/v1/locate/photo — locate the visitor from a photo, one round trip.
 *
 * Two paths run concurrently (plan §positioning):
 *   (a) label OCR: gemini-3.1-flash-lite reads any wall label in frame →
 *       deterministic met.sqlite match (accession first, then exact title) →
 *       LabelMatch with the object's gallery + floor. If met.sqlite is not
 *       built yet the label path degrades silently (label: null) — the
 *       response still carries embedding candidates.
 *   (b) embedding retrieval: gemini-embedding-2 query vector → brute-force
 *       cosine against the in-RAM index (server/src/embeddings.ts) → top-3
 *       candidates. If the index is not built yet, candidates: [].
 * No LLM image *recognition* anywhere — the LLM only reads label text.
 *
 * LLM_MOCK=1: canned responses keyed by sha256 of the decoded image, generated
 * from the e2e fixture set (routes/locate-mock.json — e.g. the 250684_label.jpg
 * fixture → gallery 171). Unknown images get {label: null, candidates: []}.
 * Mock mode never touches Gemini, met.sqlite, or the embedding index, so e2e
 * runs are deterministic and free.
 */
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { components } from '@met/shared'
import { normalizeQuery } from '@met/shared/search'
import { loadEmbeddingIndex, searchByEmbedding } from '../embeddings.js'
import { createGemini, type GeminiClient, type LabelRead } from '../gemini.js'

type LocatePhotoResponse = components['schemas']['LocatePhotoResponse']
type LocateCandidate = components['schemas']['LocateCandidate']
type LabelMatch = components['schemas']['LabelMatch']

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // contract: client downscales to ≤4 MB decoded

/** Mirrors LocatePhotoRequest in shared/openapi.yaml. */
export const locatePhotoRequestSchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 (no data: URI prefix)'),
})

// ---------------------------------------------------------------------------
// met.sqlite (read-only; same DATA_DIR resolution as routes/data.ts) — retried
// per request so the server picks the artifact up as soon as B builds it.
// ---------------------------------------------------------------------------
const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url))
const SQLITE_PATH = path.join(DATA_DIR, 'met.sqlite')

let db: Database.Database | null = null
function getDb(): Database.Database | null {
  if (db) return db
  try {
    db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  return db
}

/** galleries.floor lookup; '' when the gallery (or the table) is unknown. */
function floorOf(database: Database.Database | null, gallery: string): string {
  if (!database || !gallery) return ''
  try {
    const row = database
      .prepare('SELECT floor FROM galleries WHERE galleryNumber = ? LIMIT 1')
      .get(gallery) as { floor: string } | undefined
    return row?.floor ?? ''
  } catch {
    return ''
  }
}

/** Accessions match ignoring case and whitespace ("31.3.166" styles vary in OCR). */
function normalizeAccession(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

interface ObjectRow {
  objectID: number
  accession: string
  title: string
  artist: string
  galleryNumber: string
}

/**
 * Deterministic label → object match: accession exact-match first (the
 * benchmarked 100% path), then exact title (normalized; disambiguated by
 * artist when several objects share a title). Ambiguous ⇒ no match — the
 * embedding candidates still cover the user.
 */
function matchLabel(database: Database.Database, label: LabelRead): ObjectRow | null {
  if (label.accession) {
    const row = database
      .prepare(
        "SELECT objectID, accession, title, artist, galleryNumber FROM objects WHERE replace(lower(accession), ' ', '') = ?",
      )
      .get(normalizeAccession(label.accession)) as ObjectRow | undefined
    if (row) return row
  }
  if (label.title) {
    const rows = database
      .prepare(
        'SELECT objectID, accession, title, artist, galleryNumber FROM objects WHERE title = ? COLLATE NOCASE',
      )
      .all(label.title) as ObjectRow[]
    let hits = rows
    if (hits.length === 0) {
      // normalized fallback (punctuation/diacritic noise in OCR)
      const want = normalizeQuery(label.title)
      hits = (
        database
          .prepare('SELECT objectID, accession, title, artist, galleryNumber FROM objects WHERE title <> ?')
          .all('') as ObjectRow[]
      ).filter((r) => normalizeQuery(r.title) === want)
    }
    if (hits.length > 1 && label.artist) {
      const want = normalizeQuery(label.artist)
      hits = hits.filter((r) => normalizeQuery(r.artist) === want)
    }
    if (hits.length === 1) return hits[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// LLM_MOCK fixtures: sha256(image bytes) → canned LocatePhotoResponse
// ---------------------------------------------------------------------------
type MockEntry = { fixture: string; label: LabelMatch | null; candidates: LocateCandidate[] }
let mockFixtures: Record<string, MockEntry> | null = null
function getMockFixtures(): Record<string, MockEntry> {
  if (!mockFixtures) {
    mockFixtures = JSON.parse(
      readFileSync(new URL('./locate-mock.json', import.meta.url), 'utf8'),
    )
  }
  return mockFixtures!
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
const MOCK = process.env.LLM_MOCK === '1'

let llm: GeminiClient | null = null
function getLlm(): GeminiClient {
  if (!llm) llm = createGemini()
  return llm
}

// Warm the embedding index at boot without blocking it.
if (!MOCK) void loadEmbeddingIndex()

export const locateRoutes = new Hono()

locateRoutes.post('/', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json(
      { error: { code: 'invalid_request', message: 'Request body must be JSON' } },
      400,
    )
  }
  const parsed = locatePhotoRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ')
    return c.json({ error: { code: 'invalid_request', message } }, 400)
  }
  const { imageBase64 } = parsed.data
  const decodedBytes = Math.floor((imageBase64.length * 3) / 4)
  if (decodedBytes > MAX_IMAGE_BYTES) {
    return c.json(
      {
        error: {
          code: 'payload_too_large',
          message: `Decoded image is ${decodedBytes} bytes; limit is ${MAX_IMAGE_BYTES}. Downscale before upload.`,
        },
      },
      413,
    )
  }

  if (MOCK) {
    const hash = createHash('sha256').update(Buffer.from(imageBase64, 'base64')).digest('hex')
    const entry = getMockFixtures()[hash]
    const body: LocatePhotoResponse = entry
      ? { label: entry.label, candidates: entry.candidates }
      : { label: null, candidates: [] }
    return c.json(body)
  }

  // Live: both paths concurrently; either may fail/degrade independently.
  const [ocr, emb] = await Promise.allSettled([
    getLlm().ocrLabel(imageBase64),
    getLlm().embedImage(imageBase64),
  ])
  if (ocr.status === 'rejected' && emb.status === 'rejected') {
    console.error('locate/photo: both paths failed', ocr.reason, emb.reason)
    return c.json(
      {
        error: {
          code: 'llm_unavailable',
          message: 'Photo localization is temporarily unavailable. Enter a gallery number instead.',
        },
      },
      503,
    )
  }

  const database = getDb()

  let candidates: LocateCandidate[] = []
  if (emb.status === 'fulfilled') {
    const hits = await searchByEmbedding(emb.value, 3)
    candidates = hits.map((h) => ({
      objectID: h.objectID,
      title: h.title,
      artist: h.artist,
      gallery: h.gallery,
      floor: floorOf(database, h.gallery),
      similarity: Number(h.similarity.toFixed(4)),
    }))
  } else {
    console.error('locate/photo: embedding path failed', emb.reason)
  }

  let label: LabelMatch | null = null
  if (ocr.status === 'fulfilled' && database && ocr.value.confidence > 0) {
    const row = matchLabel(database, ocr.value)
    if (row) {
      label = {
        objectID: row.objectID,
        gallery: row.galleryNumber,
        floor: floorOf(database, row.galleryNumber),
        accession: row.accession,
        confidence: ocr.value.confidence,
      }
    }
  } else if (ocr.status === 'rejected') {
    console.error('locate/photo: label path failed', ocr.reason)
  }

  const body: LocatePhotoResponse = { label, candidates }
  return c.json(body)
})
