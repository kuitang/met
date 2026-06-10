import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imgRateLimit, llmRateLimit } from './middleware/ratelimit.js'
import { dataRoutes, getDataVersion } from './routes/data.js'
import { healthRoutes } from './routes/health.js'
import { imgRoutes } from './routes/img.js'
import { interpretRoutes } from './routes/interpret.js'
import { locateRoutes } from './routes/locate.js'

const app = new Hono()

// Cross-origin isolation on EVERY response: expo-sqlite's wasm backend needs
// SharedArrayBuffer on web. The Met image CDN sends no CORS/CORP headers, so
// require-corp would block it — web clients load images through our
// /api/v1/img proxy instead (gate-review accepted).
app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  c.res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
})

// Every API response carries the current artifact version so stale clients
// know to re-pull /api/v1/data/met.sqlite.
app.use('/api/*', async (c, next) => {
  await next()
  c.res.headers.set('x-data-version', await getDataVersion())
})

app.use('/api/v1/search/interpret', llmRateLimit)
app.use('/api/v1/locate/photo', llmRateLimit)
app.use('/api/v1/img/*', imgRateLimit)

app.route('/api/v1/health', healthRoutes)
app.route('/api/v1/data', dataRoutes)
app.route('/api/v1/img', imgRoutes)
app.route('/api/v1/search/interpret', interpretRoutes)
app.route('/api/v1/locate/photo', locateRoutes)

// Unknown API paths get the error envelope, not the SPA fallback
app.all('/api/*', (c) =>
  c.json({ error: { code: 'not_found', message: 'No such API route' } }, 404),
)

// Static Expo web export (apps/mobile: `npm run export:web`), SPA fallback.
// serveStatic roots are resolved against cwd, so compute relative to this file.
const distRoot = path.relative(
  process.cwd(),
  fileURLToPath(new URL('../../apps/mobile/dist', import.meta.url)),
)
app.use('*', serveStatic({ root: distRoot }))
app.get('*', serveStatic({ root: distRoot, path: 'index.html' }))

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'Not found' } }, 404),
)
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`met-navigator server listening on :${info.port} (static: ${distRoot})`)
})
