/**
 * J12 — Amenities. Anchored in a gallery, search "restroom": results are
 * ranked nearest-first by graph (walking) distance from the anchor, TAPPING
 * the nearest row opens DIRECTIONS to it (it must never silently move the
 * visitor's location — that's the explicit "I'm here" secondary action), and
 * the header HOME button is the one-tap way back with the anchor intact.
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

  // Main rows only ("I'm here" secondary buttons carry their own testID).
  const rows = page.locator(
    '[data-testid^="amenity-"]:not([data-testid^="amenity-im-here-"])',
  );
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Each row offers the explicit secondary re-anchor action.
  const firstRowId = (await rows.first().getAttribute('data-testid'))!.replace(/^amenity-/, '');
  await expect(page.getByTestId(`amenity-im-here-${firstRowId}`)).toBeVisible();

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

  // TAPPING the nearest row offers directions from the anchor to that row.
  await step(page, `Nearest is ~${distances[0]} m away — tap for directions`, async () => {
    await rows.first().click();
  });
  await expect(page).toHaveURL(new RegExp(`/route/${F.galleryId}/${firstRowId}`));
  await expect(page.getByTestId('route-summary')).toContainText(/Restroom/i);
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');

  // The tap did NOT relocate the visitor: one tap on the header HOME button
  // lands back on the map with the Gallery anchor untouched.
  await step(page, 'One tap home — my location never moved', async () => {
    await page.getByTestId('home-button').last().click();
  });
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${F.galleryId}`);
});
