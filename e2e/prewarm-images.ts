/**
 * Playwright globalSetup, two jobs:
 *
 * 1. probeTarget — pay one-time target costs HERE, not inside the first test,
 *    so every test runs under the tight timeout budget (playwright.config):
 *      - dev-server mode: GET / and every <script src> bundle. The first
 *        bundle request triggers the Metro compile (tens of seconds locally);
 *        absorbing it in setup is what lets the expect timeout stay at 7 s.
 *      - CHECKS_STATIC mode: the same fetches validate the export in
 *        milliseconds — a missing/broken dist fails the run in seconds with
 *        a real error (the canary project then checks the rendered DOM).
 *    (Playwright starts webServer before globalSetup, so the target is up.)
 *
 * 2. prewarm the server's image-proxy disk cache (GET /api/v1/img/{objectID})
 *    for every object the journey recordings open, so videos never show the
 *    cold-cache grey block on object pages (a CDN miss → proxy fill can take
 *    seconds; warmed, the hero paints immediately and
 *    helpers/journey.ts:awaitHeroImage is instant). JOURNEY_TARGET only.
 *    The ID set comes from the same loadJourneyFixtures() the specs read, so
 *    it is exact by construction. 404s are fine — imageless objects exist
 *    and render no hero image.
 */
import { loadJourneyFixtures } from './helpers/db';

/** Bounded fetch helper: dev-mode Metro compiles can take a while. */
async function fetchOk(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function probeTarget(base: string): Promise<void> {
  const t0 = Date.now();
  const html = await fetchOk(`${base}/`, 30_000);
  if (!/<div id="root">/.test(html)) {
    throw new Error(`probe: ${base}/ returned HTML without the #root mount — broken export?`);
  }
  // Compile/validate every entry bundle (dev Metro compiles on first request;
  // 5 min bound is for that compile, the static export answers in ms).
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    const url = src.startsWith('http') ? src : `${base}${src}`;
    const js = await fetchOk(url, 300_000);
    if (js.length < 10_000) throw new Error(`probe: bundle ${url} is ${js.length} B — truncated?`);
  }
  console.log(`[probe] ${base} shell + ${scripts.length} bundle(s) ready in ${Date.now() - t0} ms`);
}

export default async function globalSetup(): Promise<void> {
  const target = process.env.JOURNEY_TARGET;
  // Local webServer modes (static export or dev server): probe + pre-compile.
  // Same port resolution as playwright.config.ts (E2E_PORT override).
  if (!target) {
    await probeTarget(`http://localhost:${Number(process.env.E2E_PORT ?? 8081)}`);
    return;
  }

  const F = loadJourneyFixtures();
  const ids = new Set<number>([
    // J2/J11/J15 open the top gallery's first three objects.
    ...F.galleryObjects.slice(0, 3).map((o) => o.objectID),
    F.artifact.objectID, // J4 + J13 (object page + deep-link round trip)
    F.multiWordHit.objectID, // J6 suggestion target
  ]);
  if (F.cloistersObject) ids.add(F.cloistersObject.objectID); // J14 search step
  if (F.washingtonPresent) ids.add(11417); // J7 ranked result

  let warmed = 0;
  for (const id of ids) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${target}/api/v1/img/${id}`, {
          signal: AbortSignal.timeout(20_000),
        });
        // Consume the body: the proxy tees the upstream stream to disk, and a
        // fully delivered body means the cache file is (or is about to be)
        // committed — a follow-up request dedupes onto the finished write.
        await res.arrayBuffer();
        if (res.ok) warmed++;
        if (res.ok || res.status === 404) break;
      } catch {
        /* transient (server still booting, CDN hiccup) — retry */
      }
    }
  }
  console.log(`[prewarm] image proxy warmed for ${warmed}/${ids.size} journey objects`);
}
