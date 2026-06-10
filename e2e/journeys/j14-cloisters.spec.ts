/**
 * J14 — The Cloisters. Venue switch on the map (data-driven floor chips
 * change to G/1), routing WITHIN the Cloisters works, and site isolation
 * holds: no route ever crosses between the two buildings. The
 * Cloisters-object search step is armed: build-db canonicalizes the Met API's
 * zero-padded Cloisters gallery numbers ("010" → "10"), so the fixture's
 * objects↔galleries join finds Cloisters-sited objects in the full catalog.
 * (The else branch remains as a guard for partial snapshots.)
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal, tapRoom } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J14 Cloisters: venue switch, in-venue route, site isolation', async ({ page }) => {
  await bootReal(page);

  // Venue moved into location state: the switch lives in the locate sheet's
  // segmented VENUE row (no site chips on the map).
  await step(page, 'Switching venue: The Cloisters (locate sheet)', async () => {
    await page.getByTestId('locate-chip').click();
    await page.getByTestId('venue-cloisters').click();
    await page.goBack();
  });
  // The home chip's second line reflects the new venue; a manual pick is the
  // user's own action, so no auto-switch toast appears.
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('The Cloisters');
  await expect(page.getByTestId('venue-toast')).toHaveCount(0);
  // Data-driven floors: the Cloisters has G and 1 only.
  await expect(page.getByTestId('floor-chip-1')).toBeVisible();
  await expect(page.getByTestId('floor-chip-G')).toBeVisible();
  await expect(page.getByTestId('floor-chip-2')).toHaveCount(0);
  expect(await page.locator('path[data-testid^="room-"]').count()).toBeGreaterThanOrEqual(5);

  // Site isolation: directions from the (Fifth Ave) Great Hall default anchor
  // to a Cloisters room must yield NO route — never a cross-venue path.
  await step(page, 'Fuentidueña Chapel — directions from Fifth Ave?', async () => {
    await tapRoom(page, '2');
    await expect(page.getByTestId('room-sheet')).toContainText('Fuentidueña');
    await page.getByTestId('room-directions').click();
  });
  await expect(page.getByTestId('route-not-found')).toBeVisible();
  await expect(page.getByTestId('route-not-found')).toContainText('No route found');

  // Routing within the Cloisters works (gallery 1 → Gothic Chapel, floor G).
  await step(page, 'But routing inside the Cloisters works: Gallery 1 → 9', async () => {
    await bootReal(page, '/route/1/9');
  });
  await expect(page.getByTestId('route-summary')).toContainText('Gothic Chapel');
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');

  if (F.cloistersObject) {
    // Full catalog: search a Cloisters-only object, gallery shown inline.
    const o = F.cloistersObject;
    await step(page, `Search a Cloisters object: “${o.title}”`, async () => {
      await bootReal(page, '/search');
      await page.getByTestId('search-input').fill(o.title);
    });
    await expect(page.getByTestId(`suggestion-${o.objectID}`)).toContainText(
      `Gallery ${o.galleryNumber}`,
    );
  } else {
    console.log(
      `[J14] no Cloisters-sited objects in the partial snapshot (${F.objectCount} objects) — ` +
        'the search step re-arms after full hydration.',
    );
  }
});
