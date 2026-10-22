import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

it('uses patched native SQLite while preserving FTS5 search', () => {
  const db = new Database(':memory:')
  try {
    // CVE-2026-11822 / CVE-2026-11824 are fixed in SQLite 3.53.2.
    const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    const [major, minor, patch] = version.split('.').map(Number)
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_053_002)
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(text); INSERT INTO docs VALUES ('museum gallery')")
    expect(db.prepare("SELECT count(*) AS count FROM docs WHERE docs MATCH ?").get('gallery')).toEqual({ count: 1 })
  } finally {
    db.close()
  }
})
