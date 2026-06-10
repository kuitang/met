import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { components } from '@met/shared'

// The data workspace (or the Fly volume via DATA_DIR=/data) holds the
// nightly-built met.sqlite plus a VERSION file written by the same build.
const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../../data', import.meta.url))
const SQLITE_PATH = path.join(DATA_DIR, 'met.sqlite')
const VERSION_PATH = path.join(DATA_DIR, 'VERSION')

/** Stub until the data pipeline exists: DATA_VERSION env > VERSION file > dev default. */
export async function getDataVersion(): Promise<string> {
  if (process.env.DATA_VERSION) return process.env.DATA_VERSION
  try {
    return (await readFile(VERSION_PATH, 'utf8')).trim()
  } catch {
    return '0.0.0-dev'
  }
}

async function sqliteStat() {
  try {
    return await stat(SQLITE_PATH)
  } catch {
    return null
  }
}

export const dataRoutes = new Hono()

dataRoutes.get('/version', async (c) => {
  const s = await sqliteStat()
  const body: components['schemas']['DataVersion'] = {
    dataVersion: await getDataVersion(),
    sqliteBytes: s?.size ?? 0,
    builtAt: (s?.mtime ?? new Date(0)).toISOString(),
  }
  return c.json(body)
})

dataRoutes.get('/met.sqlite', async (c) => {
  const s = await sqliteStat()
  if (!s) {
    return c.json(
      { error: { code: 'not_found', message: 'met.sqlite has not been built yet' } },
      404,
    )
  }
  const version = await getDataVersion()
  const etag = `"${version}"`
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && ifNoneMatch.replace(/^W\//, '').replaceAll('"', '') === version) {
    return c.body(null, 304, { ETag: etag })
  }
  return c.body(
    Readable.toWeb(createReadStream(SQLITE_PATH)) as ReadableStream<Uint8Array>,
    200,
    {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(s.size),
      ETag: etag,
    },
  )
})
