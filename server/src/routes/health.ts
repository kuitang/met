import { Hono } from 'hono'
import type { components } from '@met/shared'
import { getDataVersion } from './data.js'

export const healthRoutes = new Hono()

healthRoutes.get('/', async (c) => {
  const body: components['schemas']['Health'] = {
    ok: true,
    dataVersion: await getDataVersion(),
    llm: process.env.GEMINI_API_KEY ? 'up' : 'degraded',
  }
  return c.json(body)
})
