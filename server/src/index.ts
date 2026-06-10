import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imgRateLimit, llmRateLimit } from './middleware/ratelimit.js'
import { dataRoutes, getDataVersion } from './routes/data.js'
import { healthRoutes } from './routes/health.js'
import { imgRoutes } from './routes/img.js'
import { interpretRoutes } from './routes/interpret.js'
import { locateRoutes } from './routes/locate.js'
import { adminRefreshRoutes, startRefreshScheduler } from './refresh.js'

const app = new Hono()

// Cross-origin isolation on EVERY response. The web SQLite backend no longer
// needs SharedArrayBuffer (main-thread @sqlite.org/sqlite-wasm — see
// ARCHITECTURE.md), but the headers stay for dev/prod parity and because the
// image design assumes isolation: the Met image CDN sends no CORS/CORP
// headers, so require-corp would block it — web clients load images through
// our /api/v1/img proxy instead (gate-review accepted).
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

// CORS for the LLM POST endpoints. Prod web is same-origin and never
// preflights, but the cross-origin clients need this: native apps POSTing at
// prod and metro web dev (:8081 page → :8787 API), whose JSON POSTs trigger
// an OPTIONS preflight. Same `*` opt-in the GET routes already carry
// (routes/data.ts, routes/img.ts) — no credentials, public API, no origin
// pinned. Registered BEFORE the rate limiters so 429s carry the headers too.
const llmCors = cors({
  origin: '*',
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  exposeHeaders: ['x-data-version', 'Retry-After'],
})
app.use('/api/v1/search/interpret', llmCors)
app.use('/api/v1/locate/photo', llmCors)

app.use('/api/v1/search/interpret', llmRateLimit)
app.use('/api/v1/locate/photo', llmRateLimit)
app.use('/api/v1/img/*', imgRateLimit)

app.route('/api/v1/health', healthRoutes)
app.route('/api/v1/data', dataRoutes)
app.route('/api/v1/img', imgRoutes)
app.route('/api/v1/search/interpret', interpretRoutes)
app.route('/api/v1/locate/photo', locateRoutes)
app.route('/api/v1/admin/refresh', adminRefreshRoutes)

// Unknown API paths get the error envelope, not the SPA fallback
app.all('/api/*', (c) =>
  c.json({ error: { code: 'not_found', message: 'No such API route' } }, 404),
)

// Static Expo web export (apps/mobile: `npm run export:web`), SPA fallback.
// serveStatic roots are resolved against cwd, so compute relative to this file.
//
// OG-META INJECTION SEAM (for the share-preview workstream): social-preview
// meta tags (og:url, og:image, canonical) MUST be emitted with the *request*
// origin — the same build serves a custom domain, met-nav.fly.dev, and PR
// preview apps, so nothing absolute may be baked into dist/index.html.
// Implementation point: replace the SPA-fallback line below with a handler
// that reads dist/index.html once, then per request injects tags built from
// the request origin: host = new URL(c.req.url).host (@hono/node-server
// derives it from the Host header, which Fly's single trusted proxy
// preserves as the public hostname), scheme = c.req.header(
// 'x-forwarded-proto') ?? 'http' (the Node socket is plain http behind
// Fly's TLS termination, so c.req.url's scheme is NOT trustworthy).
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

// Nightly data self-refresh (RUN_REFRESH=0 disables; see server/src/refresh.ts)
startRefreshScheduler()
