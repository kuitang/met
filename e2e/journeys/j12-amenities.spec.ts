/**
 * J12 — Amenities. Anchored in a gallery, search "restroom": results are
 * ranked nearest-first by graph (walking) distance from the anchor, each row
 * shows the distance, and the nearest one is routable.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J12 amenities: "restroom" → nearest-first by walking distance → route', async ({
  page,
}) => {
  // Deep-link anchor (also exercised by J13) so distance has an origin.
  await bootReal(page, `/?room=${F.galleryId}`);
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${F.galleryId}`);

  await step(page, 'Nature calls: searching “restroom”', async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill('restroom');
  });

  const rows = page.locator('[data-testid^="amenity-"]');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Sorted by graph distance: the "~N m walk" labels must be non-decreasing.
  const distances: number[] = [];
  for (const text of await rows.allTextContents()) {
    const m = text.match(/~(\d+) m walk/);
    if (m) distances.push(Number(m[1]));
  }
  expect(distances.length).toBeGreaterThanOrEqual(2); // routable from the anchor
  for (let i = 1; i < distances.length; i++) {
    expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
  }

  // The nearest restroom routes from the anchor.
  const nearestId = (await rows.first().getAttribute('data-testid'))!.replace(/^amenity-/, '');
  await step(page, `Nearest is ~${distances[0]} m away — directions`, async () => {
    await bootReal(page, `/route/${F.galleryId}/${nearestId}`);
  });
  await expect(page.getByTestId('route-summary')).toContainText(/Restroom/i);
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');
});
