/**
 * Playwright globalSetup: pre-warm the server's image-proxy disk cache
 * (GET /api/v1/img/{objectID}) for every object the journey recordings open,
 * so videos never show the cold-cache grey block on object pages (a CDN
 * miss → proxy fill can take seconds; warmed, the hero paints immediately
 * and helpers/journey.ts:awaitHeroImage is instant).
 *
 * No-op without JOURNEY_TARGET (the checks project runs against stub data).
 * The ID set comes from the same loadJourneyFixtures() the specs read, so it
 * is exact by construction. 404s are fine — imageless objects exist and
 * render no hero image.
 */
import { loadJourneyFixtures } from './helpers/db';

export default async function prewarmImages(): Promise<void> {
  const target = process.env.JOURNEY_TARGET;
  if (!target) return;

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
