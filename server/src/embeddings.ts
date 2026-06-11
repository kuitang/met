/**
 * In-RAM image-embedding index for /api/v1/locate/photo.
 *
 * Loads the shards written by data/src/embed-images.ts (float32 little-endian,
 * L2-normalized, 768d) into ONE flat Float32Array plus a parallel metadata
 * array, then answers top-k queries by brute-force dot product (vectors are
 * pre-normalized, so dot = cosine). At the full 34k-image scale this is
 * ~104 MB and ~40 ms per query — no ANN index, on purpose (plan §positioning).
 *
 * Loading is lazy and memoized: the first call kicks it off (locate.ts fires
 * one at import time so the boot is non-blocking), every later call awaits the
 * same promise. A missing index resolves to null — the endpoint degrades to
 * label-OCR-only — and is retried on the next request so the server picks the
 * index up as soon as the pipeline writes it.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Same DATA_DIR resolution as routes/data.ts (baked into the Docker image at
// DATA_DIR=/app/data in prod).
const DATA_DIR =
  process.env.DATA_DIR ?? fileURLToPath(new URL('../../data', import.meta.url))
const EMBED_DIR = path.join(DATA_DIR, 'snapshots', 'image-embeddings')

export interface EmbeddedObject {
  objectID: number
  title: string
  artist: string
  gallery: string
}

interface EmbeddingIndex {
  dims: number
  count: number
  matrix: Float32Array // count × dims, row-major, L2-normalized rows
  objects: EmbeddedObject[] // row i ↔ objects[i]
}

interface IndexFile {
  dims: number
  shardSize: number
  count: number
  objects: Record<
    string,
    { shard: number; offset: number; title: string; artist: string; gallery: string }
  >
}

let index: EmbeddingIndex | null = null
let loading: Promise<EmbeddingIndex | null> | null = null

async function load(): Promise<EmbeddingIndex | null> {
  let meta: IndexFile
  try {
    meta = JSON.parse(await readFile(path.join(EMBED_DIR, 'index.json'), 'utf8'))
  } catch {
    return null // not built yet; retried on the next request
  }
  const { dims, shardSize, count } = meta
  const matrix = new Float32Array(count * dims)
  const shards = Math.ceil(count / shardSize)
  for (let s = 0; s < shards; s++) {
    const buf = await readFile(path.join(EMBED_DIR, `shard-${s}.bin`))
    // float32 little-endian on disk; Node runs LE platforms only in practice
    const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    matrix.set(view.subarray(0, Math.min(view.length, (count - s * shardSize) * dims)), s * shardSize * dims)
  }
  const objects: EmbeddedObject[] = new Array(count)
  for (const [id, o] of Object.entries(meta.objects)) {
    objects[o.shard * shardSize + o.offset] = {
      objectID: Number(id),
      title: o.title,
      artist: o.artist,
      gallery: o.gallery,
    }
  }
  console.log(`embedding index loaded: ${count} vectors × ${dims}d (${EMBED_DIR})`)
  return { dims, count, matrix, objects }
}

/** Memoized lazy load; resolves null (and allows a retry) while the index is absent. */
export function loadEmbeddingIndex(): Promise<EmbeddingIndex | null> {
  if (index) return Promise.resolve(index)
  if (!loading) {
    loading = load()
      .then((idx) => {
        index = idx
        if (!idx) loading = null // retry next call
        return idx
      })
      .catch((e) => {
        console.error('embedding index load failed:', e)
        loading = null
        return null
      })
  }
  return loading
}

export interface EmbeddingHit extends EmbeddedObject {
  similarity: number
}

/** Brute-force cosine top-k. Returns [] when the index is not built yet. */
export async function searchByEmbedding(
  query: Float32Array,
  k = 3,
): Promise<EmbeddingHit[]> {
  const idx = await loadEmbeddingIndex()
  if (!idx || idx.count === 0) return []
  if (query.length !== idx.dims)
    throw new Error(`query has ${query.length} dims, index has ${idx.dims}`)
  // normalize the query so dot = cosine (index rows are pre-normalized)
  let norm = 0
  for (let i = 0; i < query.length; i++) norm += query[i] * query[i]
  norm = Math.sqrt(norm) || 1
  const top: { row: number; sim: number }[] = []
  const { matrix, dims, count } = idx
  for (let row = 0; row < count; row++) {
    let dot = 0
    const base = row * dims
    for (let i = 0; i < dims; i++) dot += matrix[base + i] * query[i]
    const sim = dot / norm
    if (top.length < k) {
      top.push({ row, sim })
      top.sort((a, b) => b.sim - a.sim)
    } else if (sim > top[k - 1].sim) {
      top[k - 1] = { row, sim }
      top.sort((a, b) => b.sim - a.sim)
    }
  }
  return top.map((t) => ({ ...idx.objects[t.row], similarity: t.sim }))
}
