import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { injectOgMeta, requestOrigin } from './meta.js'

// Mirrors the head the Expo web export emits (title + favicon, no og tags).
const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MuseWalk</title>
  <link rel="icon" href="/favicon.ico" /></head>
  <body><div id="root"></div></body>
</html>`

const attr = (html: string, re: RegExp) => html.match(re)?.[1]
const ogContent = (html: string, prop: string) =>
  attr(html, new RegExp(`property="${prop}" content="([^"]*)"`))

describe('requestOrigin', () => {
  it('uses Host + x-forwarded-proto (Fly TLS termination)', () => {
    expect(requestOrigin('musewalk.app', 'https')).toBe('https://musewalk.app')
    expect(requestOrigin('met-nav-pr-9.fly.dev', 'https')).toBe('https://met-nav-pr-9.fly.dev')
  })
  it('falls back to http when no proxy header (local dev)', () => {
    expect(requestOrigin('localhost:8787', undefined)).toBe('http://localhost:8787')
  })
  it('takes the first proto from a multi-proxy list', () => {
    expect(requestOrigin('musewalk.app', 'https, http')).toBe('https://musewalk.app')
  })
})

describe('injectOgMeta', () => {
  const html = injectOgMeta(TEMPLATE, 'https://musewalk.app', '/')

  it('derives og:image and og:url from the request origin', () => {
    expect(ogContent(html, 'og:image')).toBe('https://musewalk.app/share.png')
    expect(ogContent(html, 'og:url')).toBe('https://musewalk.app/')
  })

  it('serves other origins (PR previews) from the same build', () => {
    const pr = injectOgMeta(TEMPLATE, 'https://met-nav-pr-9.fly.dev', '/')
    expect(ogContent(pr, 'og:image')).toBe('https://met-nav-pr-9.fly.dev/share.png')
    expect(ogContent(pr, 'og:url')).toBe('https://met-nav-pr-9.fly.dev/')
  })

  it('gives deep links a path-correct og:url, same og:image', () => {
    const deep = injectOgMeta(TEMPLATE, 'https://musewalk.app', '/object/123')
    expect(ogContent(deep, 'og:url')).toBe('https://musewalk.app/object/123')
    expect(ogContent(deep, 'og:image')).toBe('https://musewalk.app/share.png')
  })

  it('replaces <title> (no duplicates) and brands og:title for iMessage', () => {
    const renamed = injectOgMeta(TEMPLATE.replace('MuseWalk', 'Old Title'), 'https://musewalk.app', '/')
    expect(renamed.match(/<title>/g)).toHaveLength(1)
    expect(renamed).toContain('<title>MuseWalk</title>')
    expect(renamed).not.toContain('Old Title')
    // iMessage shows og:title + bare domain only — brand must be in og:title
    expect(ogContent(renamed, 'og:title')).toMatch(/^MuseWalk — /)
  })

  it('emits the full preview block: description, type, dimensions, twitter, icons', () => {
    expect(ogContent(html, 'og:description')).toContain('unofficial companion')
    expect(ogContent(html, 'og:type')).toBe('website')
    expect(ogContent(html, 'og:site_name')).toBe('MuseWalk')
    // width/height kill Facebook's first-share blank-image race
    expect(ogContent(html, 'og:image:width')).toBe('1200')
    expect(ogContent(html, 'og:image:height')).toBe('630')
    expect(ogContent(html, 'og:image:type')).toBe('image/png')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain('href="https://musewalk.app/apple-touch-icon.png"')
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />')
    expect(html.indexOf('</head>')).toBe(html.lastIndexOf('</head>'))
  })
})

describe('shipped share assets (apps/mobile/public)', () => {
  const publicDir = new URL('../../apps/mobile/public/', import.meta.url)
  const pngSize = (name: string) => {
    const buf = readFileSync(fileURLToPath(new URL(name, publicDir)))
    // PNG signature, then IHDR width/height at offsets 16/20 (big-endian)
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  it('share.png is a 1200x630 PNG under the 600 KB WhatsApp cap', () => {
    expect(pngSize('share.png')).toEqual({ width: 1200, height: 630 })
    const bytes = readFileSync(fileURLToPath(new URL('share.png', publicDir))).length
    expect(bytes).toBeLessThan(300 * 1024)
  })

  it('icons match their declared sizes', () => {
    expect(pngSize('apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
    expect(pngSize('icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(pngSize('icon-512.png')).toEqual({ width: 512, height: 512 })
  })

  it('site.webmanifest names MuseWalk and lists the icons', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('site.webmanifest', publicDir)), 'utf8'),
    )
    expect(manifest.name).toBe('MuseWalk')
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes).sort()).toEqual([
      '192x192',
      '512x512',
    ])
  })
})
