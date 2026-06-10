/**
 * Search vocabulary for the interpret prompt: the DB's actual distinct
 * `classification` and `culture` values (~1k tokens total). The prompt carries
 * vocabulary, never the catalog. Built once per Database handle and cached in
 * memory — the handle only changes when the nightly refresh swaps met.sqlite.
 */
import type DatabaseType from 'better-sqlite3'
import type { SearchVocabulary } from './gemini.js'

// Caps keep the prompt block ~1k tokens even if the data grows. Values are
// frequency-ordered so truncation drops only the rarest labels.
const MAX_CLASSIFICATIONS = 200
const MAX_CULTURES = 250

let cachedFor: DatabaseType.Database | null = null
let cached: SearchVocabulary | null = null

function distinctValues(
  db: DatabaseType.Database,
  column: 'classification' | 'culture',
  limit: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT ${column} AS v, COUNT(*) AS n FROM objects
       WHERE ${column} IS NOT NULL AND ${column} != ''
       GROUP BY ${column} ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as { v: string }[]
  return rows.map((r) => r.v)
}

export function getVocabulary(db: DatabaseType.Database): SearchVocabulary {
  if (cached && cachedFor === db) return cached
  cached = {
    classifications: distinctValues(db, 'classification', MAX_CLASSIFICATIONS),
    cultures: distinctValues(db, 'culture', MAX_CULTURES),
  }
  cachedFor = db
  return cached
}
