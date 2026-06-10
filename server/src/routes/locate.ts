import { Hono } from 'hono'
import { z } from 'zod'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // contract: client downscales to ≤4 MB decoded

/** Mirrors LocatePhotoRequest in shared/openapi.yaml. */
export const locatePhotoRequestSchema = z.object({
  imageBase64: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 (no data: URI prefix)'),
})

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
  const decodedBytes = Math.floor((parsed.data.imageBase64.length * 3) / 4)
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

  // Phase 2: run gemini.ts ocrLabel (deterministic met.sqlite accession match)
  // and embedImage → cosine vs the in-RAM 34k-vector index, concurrently.
  return c.json(
    { error: { code: 'not_implemented', message: 'Photo localization ships with Phase 2' } },
    501,
  )
})
