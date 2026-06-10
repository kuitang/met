import { Hono } from 'hono'
import { z } from 'zod'

/** Mirrors InterpretRequest in shared/openapi.yaml. */
export const interpretRequestSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).optional(),
})

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

  // Gate C: gemini-3.1-flash-lite rewrite (see gemini.ts interpretQuery) →
  // execute FTS5 against met.sqlite in-process → ranked results; escalate to
  // the ≤3-call search_catalog tool loop when the rewrite yields <3 rows.
  return c.json(
    { error: { code: 'not_implemented', message: 'Search interpretation ships with Gate C' } },
    501,
  )
})
