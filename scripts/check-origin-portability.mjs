#!/usr/bin/env node
/**
 * check-origin-portability — fail the build if the static web export bakes in
 * an absolute origin it must not.
 *
 * The SAME apps/mobile/dist must serve correctly at the custom domain
 * (https://musewalk.app), https://musewalk.fly.dev, and ephemeral PR preview
 * apps (https://musewalk-pr-{n}.fly.dev). Any absolute http(s) URL in the
 * bundle that points at a deploy origin or a dev machine (fly.dev, localhost,
 * private IPs, the app/domain name) is a portability bug: it pins the build
 * to one origin. API/image/share URLs must be derived at runtime
 * (same-origin '' on web — see apps/mobile/src/data/apiBase.ts).
 *
 * Allowed absolute URLs (legit external references, origin-independent):
 *  - *.metmuseum.org           Met CDN images, Open Access API, object links
 *  - fonts.googleapis.com / fonts.gstatic.com
 *  - schema/namespace + library-doc URLs that ship inside vendored bundles
 *    (w3.org, reactjs.org/react.dev error decoders, github.com, etc.) —
 *    these are never fetched as app origins; only the DENY list fails.
 *
 * Usage: node scripts/check-origin-portability.mjs [distDir]
 *        (default dist dir: apps/mobile/dist; CI runs this after export:web)
 * Exit:  0 clean, 1 violations found (or dist missing/empty).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] ?? 'apps/mobile/dist');

// Hard failures: any absolute URL whose host matches one of these pins the
// build to a deploy origin or a dev machine.
const DENY = [
  /(^|\.)fly\.dev$/i, // musewalk.fly.dev, musewalk-pr-7.fly.dev, any future app
  /^met-nav/i, // the legacy Fly app name leaking via any other TLD
  /^(www\.)?musewalk\.app$/i, // the canonical domain itself must not be baked in

  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./, // private ranges = somebody's dev LAN baked in
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

// Informational only (printed, never fails): external hosts we expect.
const EXPECTED = [
  /(^|\.)metmuseum\.org$/i,
  /(^|\.)fonts\.googleapis\.com$/i,
  /(^|\.)fonts\.gstatic\.com$/i,
  // Public Tigris image-derivative bucket (apps/mobile/src/data/imageCdn.ts):
  // origin-independent infra like the Met CDN — the same constant is correct
  // for every deploy origin, so baking it in is allowed by design.
  /^musewalk-images\.fly\.storage\.tigris\.dev$/i,
  // AIC IIIF image CDN (imageCdn.ts direct-IIIF fallback) — same reasoning.
  /(^|\.)artic\.edu$/i,
];

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.map', '.webmanifest']);
const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let files;
try {
  files = [...walk(distDir)];
} catch {
  console.error(`check-origin-portability: dist dir not found: ${distDir}`);
  console.error('Run `npm run export:web` first.');
  process.exit(1);
}
if (files.length === 0) {
  console.error(`check-origin-portability: dist dir is empty: ${distDir}`);
  process.exit(1);
}

const violations = []; // {file, host, count}
const otherHosts = new Map(); // host -> count (informational)
let scanned = 0;

for (const file of files) {
  if (!TEXT_EXT.has(path.extname(file))) continue;
  scanned++;
  const text = readFileSync(file, 'utf8');
  const counts = new Map();
  for (const m of text.matchAll(URL_RE)) {
    const host = m[0].replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  for (const [host, count] of counts) {
    if (DENY.some((re) => re.test(host))) {
      violations.push({ file: path.relative(distDir, file), host, count });
    } else if (!EXPECTED.some((re) => re.test(host))) {
      otherHosts.set(host, (otherHosts.get(host) ?? 0) + count);
    }
  }
}

if (otherHosts.size > 0) {
  console.log('Other absolute hosts in the bundle (informational, not failing):');
  for (const [host, count] of [...otherHosts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${host} ×${count}`);
  }
}

if (violations.length > 0) {
  console.error(`\nFAIL: origin-pinned URLs in ${distDir}:`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.host} ×${v.count}`);
  }
  console.error(
    '\nThe web export must be origin-portable (same build → custom domain,' +
      ' fly.dev, PR previews). Derive URLs at runtime instead — see' +
      ' apps/mobile/src/data/apiBase.ts. Most common cause: EXPO_PUBLIC_API_URL' +
      ' set during `expo export` (it must only be used for native builds).',
  );
  process.exit(1);
}

console.log(`check-origin-portability: OK (${scanned} text files scanned in ${distDir})`);
