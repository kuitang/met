/**
 * imageCdn — the ONE module that knows where image bytes live.
 *
 * Primary source: pre-generated JPEG derivatives in the PUBLIC Tigris bucket
 * `musewalk-img` (anonymous GET, CORS `GET/HEAD from *`), produced by
 * data/src/thumbnails.ts and addressed by `objects.thumbKey` in met.sqlite
 * (`img/{objectID}/{sha256(imageUrl)[:12]}` — content-addressed, immutable).
 * Loading straight from the bucket keeps image bytes OFF the app server:
 * the tiny Fly VM serves no thumbnail traffic and pays no image egress.
 *
 * The base URL is a baked constant on purpose: it is origin-independent
 * infrastructure (like images.metmuseum.org), identical for every deploy
 * origin (custom domain, fly.dev, PR previews), so it does not violate
 * origin portability — scripts/check-origin-portability.mjs allowlists it.
 *
 * Variants (sizes chosen per context):
 *   t320  — 320 px max-dim  → list-row thumbnails (results, room sheet)
 *   c1080 — 1080 px max-dim → object-detail hero
 *
 * Fallback chain (imageSources returns ordered candidates; the components
 * advance on load error):
 *   1. `{base}/{thumbKey}/{variant}.jpg` — only when the object has a
 *      thumbKey (objects newer than the last thumbnail run have '').
 *   2. Web: `/api/v1/img/{objectID}` server proxy — the COEP-safe fallback
 *      (the raw Met CDN sends no CORS/CORP headers, so the isolated web app
 *      cannot embed it). Native: the direct Met CDN URL (no COEP there).
 *   Stub provider (`dataVersion === 'stub'`): direct Met CDN URL only — the
 *   mockup runs with no API server and no real artifact.
 *
 * Web <img> elements for bucket URLs must set crossorigin="anonymous":
 * Tigris does not send Cross-Origin-Resource-Policy, so under the app's
 * COEP `require-corp` the response is only embeddable via a CORS load
 * (which the bucket's `Access-Control-Allow-Origin: *` satisfies).
 */
import { Platform } from 'react-native';

import { apiBase } from './apiBase';

export const IMAGE_CDN_BASE = 'https://musewalk-img.fly.storage.tigris.dev';

export type ImageVariant = 't320' | 'c1080';

/** True when `src` needs crossorigin="anonymous" on a web <img> (see header). */
export function needsCrossOrigin(src: string): boolean {
  return src.startsWith(IMAGE_CDN_BASE);
}

/**
 * Ordered candidate URLs for an object's picture. Never empty for an object
 * with an image; the caller advances to the next entry on load error.
 */
export function imageSources(
  o: { objectID: number; img: string; thumbKey?: string },
  variant: ImageVariant,
  dataVersion: string,
): string[] {
  if (dataVersion === 'stub') return [o.img]; // mockup: no server, no artifact
  const fallback =
    Platform.OS === 'web'
      ? `${apiBase()}/api/v1/img/${o.objectID}?v=${encodeURIComponent(dataVersion)}`
      : o.img;
  return o.thumbKey ? [`${IMAGE_CDN_BASE}/${o.thumbKey}/${variant}.jpg`, fallback] : [fallback];
}
