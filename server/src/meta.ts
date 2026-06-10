/**
 * Social-preview meta injection for the served index.html.
 *
 * The same web export serves a custom domain (musewalk.app), met-nav.fly.dev
 * and PR preview apps, so og:url / og:image MUST be absolute URLs derived
 * from the *request* origin at serve time — nothing absolute may be baked
 * into apps/mobile/dist (enforced by scripts/check-origin-portability.mjs).
 *
 * Scrapers (iMessage/Facebook/Slack/X) read server-rendered HTML only — no JS
 * execution — which is why this happens here and not in the client bundle.
 * iMessage shows og:title + the bare domain (og:site_name is unreliable), so
 * the brand lives in og:title itself. og:image:width/height kill the
 * first-share blank-image race on Facebook. share.png is 1200x630 PNG
 * (regenerate via assets/share/ — see its README).
 */

const TITLE = 'MuseWalk'
const OG_TITLE = 'MuseWalk — Find any artwork at The Met. Never get lost.'
const OG_DESCRIPTION =
  'An unofficial companion for The Metropolitan Museum of Art — search 45,000 artworks on view and get turn-by-turn directions.'

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * Request origin behind Fly's single trusted proxy: host comes from the Host
 * header (@hono/node-server puts it in c.req.url; Fly preserves the public
 * hostname), scheme from x-forwarded-proto — the Node socket is plain http
 * behind Fly's TLS termination, so the URL's own scheme is NOT trustworthy.
 */
export function requestOrigin(host: string, forwardedProto: string | undefined): string {
  const proto = forwardedProto?.split(',')[0]?.trim() || 'http'
  return `${proto}://${host}`
}

/**
 * Returns the index.html template with <title> replaced (not appended) and
 * the og/twitter/icon meta block injected before </head>. Pure — unit-tested
 * in meta.test.ts; index.ts wires it to the request.
 */
export function injectOgMeta(template: string, origin: string, pathname: string): string {
  const url = esc(origin + pathname)
  const image = esc(`${origin}/share.png`)
  const tags = [
    `<meta property="og:title" content="${esc(OG_TITLE)}" />`,
    `<meta property="og:description" content="${esc(OG_DESCRIPTION)}" />`,
    `<meta property="og:site_name" content="${esc(TITLE)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:alt" content="${esc(TITLE)} — floor plan of The Met with a navigation route" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${esc(`${origin}/apple-touch-icon.png`)}" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
  ].join('\n    ')
  const title = `<title>${esc(TITLE)}</title>`
  const withTitle = /<title>.*?<\/title>/s.test(template)
    ? template.replace(/<title>.*?<\/title>/s, title)
    : template.replace('</head>', `${title}</head>`)
  return withTitle.replace('</head>', `    ${tags}\n  </head>`)
}
