#!/usr/bin/env node
/**
 * After a `journeys` run, copy test-results/**\/video.webm into
 * e2e/recordings/J{n}-{slug}.webm.
 *
 * Contract: journey spec files are named e2e/journeys/j{n}-{slug}.spec.ts
 * (e.g. j9-navigate-reroute.spec.ts → J9-navigate-reroute.webm). Playwright
 * 1.58 names each result directory "{spec-stem}-{dashified test title}-
 * {project}" (e.g. "j9-navigate-reroute-J9-nav-…-journeys"), which is how
 * videos are matched back to their spec. Longer spec stems are matched first
 * so "j8-…" never swallows "j8b-…". Multiple videos per spec get -2, -3…
 * suffixes.
 *
 * Usage: node collect-videos.mjs   (runs automatically via `npm run journeys`)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, 'test-results');
const journeysDir = path.join(here, 'journeys');
const recordingsDir = path.join(here, 'recordings');

if (!existsSync(resultsDir)) {
  console.error(`No ${resultsDir} — run \`npx playwright test --project=journeys\` first.`);
  process.exit(1);
}

const specs = existsSync(journeysDir)
  ? readdirSync(journeysDir).filter((f) => /^j\d+[a-z]?-.+\.spec\.ts$/i.test(f))
  : [];

if (specs.length === 0) {
  console.error(`No j{n}-{slug}.spec.ts files found in ${journeysDir}; nothing to collect.`);
  process.exit(0);
}

/** Recursively find .webm files under dir. */
function findWebms(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findWebms(p));
    else if (entry.endsWith('.webm')) out.push(p);
  }
  return out;
}

mkdirSync(recordingsDir, { recursive: true });
const resultEntries = readdirSync(resultsDir).filter((d) =>
  statSync(path.join(resultsDir, d)).isDirectory(),
);

let copied = 0;
// Longest stem first so e.g. "j8b-photo-artwork" claims its dirs before
// "j8-photo-label" is considered (prefix matching below).
const orderedSpecs = [...specs].sort((a, b) => b.length - a.length);
const claimed = new Set();
for (const spec of orderedSpecs) {
  // j9-navigate-reroute.spec.ts → n="9", slug="navigate-reroute"
  const m = spec.match(/^j(\d+[a-z]?)-(.+)\.spec\.ts$/i);
  const [, n, slug] = m;
  // Playwright result dir: "{spec stem}-{dashified test title}-{project}".
  const prefix = `${spec.replace(/\.spec\.ts$/i, '')}-`;
  const videos = resultEntries
    .filter((d) => d.startsWith(prefix) && !claimed.has(d) && (claimed.add(d), true))
    .flatMap((d) => findWebms(path.join(resultsDir, d)));

  videos.forEach((video, i) => {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const dest = path.join(recordingsDir, `J${n}-${slug}${suffix}.webm`);
    copyFileSync(video, dest);
    console.log(`${video} → ${dest}`);
    copied++;
  });
}

console.log(`Collected ${copied} recording(s) into ${recordingsDir}`);
