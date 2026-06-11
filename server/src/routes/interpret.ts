/**
 * POST /api/v1/search/interpret — LLM query interpretation, executed and
 * ranked server-side in one client round trip (search tier 3).
 *
 *   1. gemini-3.1-flash-lite structured rewrite → relaxed FTS5 execution
 *      against the server's met.sqlite (shared/search.ts builders) →
 *      ≥3 rows ⇒ { method: "rewrite" }.
 *   2. Otherwise escalate to the bounded (≤3 calls) search_catalog tool loop
 *      (gemini.ts agenticSearch) ⇒ { method: "agentic", why }.
 *
 * LLM_MOCK=1 swaps the Gemini client for llm-mock.ts at the gemini.ts call
 * boundary. Responses are LRU-cached by normalized query (1 h, max 500).
 * met.sqlite is opened read-only at first use; if it is missing the endpoint
 * answers 503 data_unavailable but the server still boots (and recovers as
 * soon as the artifact appears — it retries the open per request).
 */
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { components } from '@met/shared'
import { buildFullQuery, normalizeQuery, type SearchRow } from '@met/shared/search'
import {
  createGemini,
  type CatalogRow,
  type GeminiClient,
  type InterpretedQuery,
} from '../gemini.js'
import { createMockGemini } from '../llm-mock.js'
import { getVocabulary } from '../vocab.js'

type InterpretResponse = components['schemas']['InterpretResponse']
type SearchResult = components['schemas']['SearchResult']

/** Mirrors InterpretRequest in shared/openapi.yaml. */
export const interpretRequestSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).optional(),
})

// ---------------------------------------------------------------------------
// met.sqlite (read-only; same DATA_DIR resolution as routes/data.ts)
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

// ---------------------------------------------------------------------------
// Gemini client (mocked at this boundary when LLM_MOCK=1)
// ---------------------------------------------------------------------------
const llm: GeminiClient =
  process.env.LLM_MOCK === '1' ? createMockGemini() : createGemini()

// ---------------------------------------------------------------------------
// Query execution: shared/search.ts builders + relaxQuery, run on better-sqlite3
// ---------------------------------------------------------------------------

/**
 * Score-aware escalation threshold (gate-review approved upgrade): escalate to
 * the agentic loop when the rewrite's top hit is low-signal, not only when it
 * returns <3 rows. SQLite bm25 is negative (more negative = better), so
 * "weaker than 11.5" means score > -11.5.
 *
 * Measured 2026-06-10 against data/evals/search-cases.json llm-tier cases on
 * the full-scale (44,468-object, synonyms-indexed) DB, live flash-lite:
 *   - all 13 healthy llm-tier rewrites: top-1 between -12.60 and -53.98
 *   - genuinely low-signal/out-of-catalog probes ("mona lisa" -5.59,
 *     "dinosaur bones" -10.42): top-1 always weaker than -10.5
 * -11.5 sits mid-gap → 0 false escalations on the golden set, catches the
 * query-terms-barely-in-catalog failure mode. The OTHER Gate C failure mode
 * (strong-but-wrong rows, e.g. pre-synonyms "roman household god" at -29.33)
 * is NOT score-separable and is fixed at the index instead (synonyms column,
 * data/src/synonyms.ts). Full experiment: docs/SEARCH.md.
 */
const WEAK_TOP_SCORE = -11.5

/**
 * Execute an interpreted query. Filter values (artist, classification, …)
 * are folded into the relaxed OR match rather than hard WHERE clauses: they
 * hit the weighted FTS columns, so bm25 ranks rows satisfying more of them
 * first without zeroing recall when the LLM over-constrains.
 */
function searchRows(
  database: Database.Database,
  interpreted: InterpretedQuery,
  limit: number,
): SearchRow[] {
  const input = [
    interpreted.ftsQuery,
    interpreted.filters.artist,
    interpreted.filters.classification,
    interpreted.filters.material,
    interpreted.filters.culture_or_period,
  ]
    .filter(Boolean)
    .join(' ')
  const q = buildFullQuery(input, {}, { relaxed: true, limit })
  if (q === null) return []
  return database.prepare(q.sql).all(...q.params) as SearchRow[]
}

function toResult(row: SearchRow): SearchResult {
  return {
    objectID: row.objectID,
    title: row.title,
    artist: row.artist,
    galleryNumber: row.galleryNumber,
    floor: row.floor ?? '',
    site: row.site as SearchResult['site'],
    score: row.score,
  }
}

// ---------------------------------------------------------------------------
// LRU response cache: normalized query → response, 1 h TTL, max 500 entries
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX = 500
const cache = new Map<string, { body: InterpretResponse; expires: number }>()

function cacheGet(key: string): InterpretResponse | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    cache.delete(key)
    return null
  }
  cache.delete(key) // re-insert → most recently used
  cache.set(key, hit)
  return hit.body
}

function cacheSet(key: string, body: InterpretResponse): void {
  cache.set(key, { body, expires: Date.now() + CACHE_TTL_MS })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export const interpretRoutes = new Hono()

interpretRoutes.post('/', async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json(
      { error: { code: 'invalid_request', message: 'Request body must be JSON' } },
      400,
    )
  }
  const parsed = interpretRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ')
    return c.json({ error: { code: 'invalid_request', message } }, 400)
  }
  const { query, maxResults = 10 } = parsed.data

  const database = getDb()
  if (!database) {
    return c.json(
      {
        error: {
          code: 'data_unavailable',
          message: 'met.sqlite has not been built yet; interpretation needs the catalog.',
        },
      },
      503,
    )
  }

  const cacheKey = `${normalizeQuery(query)}|${maxResults}`
  const cached = cacheGet(cacheKey)
  if (cached) return c.json(cached)

  const vocab = getVocabulary(database)
  let body: InterpretResponse
  try {
    // Tier 3a: structured rewrite, executed relaxed.
    const interpreted = await llm.interpretQuery(query, vocab)
    const rows = searchRows(database, interpreted, maxResults)
    if (rows.length >= 3 && rows[0].score <= WEAK_TOP_SCORE) {
      body = {
        results: rows.map(toResult),
        method: 'rewrite',
        interpretedQuery: interpreted,
      }
    } else {
      // Tier 3b: bounded agentic escalation (<3 rows OR weak top score). The
      // tool runs the same executor; rows seen by the model are the only
      // candidates the final ranking may cite (hallucinated IDs are dropped).
      const seen = new Map<number, SearchRow>()
      const classificationStmt = (ids: number[]) =>
        database
          .prepare(
            `SELECT objectID, classification FROM objects
             WHERE objectID IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as { objectID: number; classification: string }[]
      const executeTool = (toolQuery: InterpretedQuery): CatalogRow[] => {
        const toolRows = searchRows(database, toolQuery, 10)
        for (const r of toolRows) seen.set(r.objectID, r)
        const classifications = new Map(
          toolRows.length
            ? classificationStmt(toolRows.map((r) => r.objectID)).map((r) => [
                r.objectID,
                r.classification,
              ])
            : [],
        )
        return toolRows.map((r) => ({
          objectID: r.objectID,
          title: r.title,
          artist: r.artist,
          classification: classifications.get(r.objectID) ?? '',
          galleryNumber: r.galleryNumber,
        }))
      }
      const agentic = await llm.agenticSearch(query, vocab, executeTool)
      const ranked = agentic.objectIDs
        .map((id) => seen.get(id))
        .filter((r): r is SearchRow => r !== undefined)
        .slice(0, maxResults)
      body = {
        results: ranked.map(toResult),
        method: 'agentic',
        interpretedQuery: agentic.searches.at(-1) ?? interpreted,
        why: agentic.why,
      }
    }
  } catch (err) {
    console.error('interpret: LLM call failed', err)
    return c.json(
      {
        error: {
          code: 'llm_unavailable',
          message: 'Query interpretation is temporarily unavailable; plain search still works.',
        },
      },
      503,
    )
  }

  cacheSet(cacheKey, body)
  return c.json(body)
})
