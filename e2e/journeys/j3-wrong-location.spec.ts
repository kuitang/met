/**
 * J3 — Wrong location / big GPS error. A Central Park outlier fix (±800 m,
 * ~1 km off-campus) is rejected outright — the app degrades to "GPS
 * unavailable" with the manual entry CTA instead of guessing, and a typed
 * room number wins. (gps.md eval: outlier rejection is load-bearing; accuracy
 * 800 m > GPS_MAX_ACCURACY_M and the point is past GPS_MAX_DISTANCE_M.)
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { fix } from '../helpers/geo';
import {
  CENTRAL_PARK_OUTLIER,
  HAS_REAL_TARGET,
  HIGHLIGHT_STROKE,
  bootReal,
} from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J3 wrong location: outlier GPS rejected, manual room entry wins', async ({
  page,
  context,
}) => {
  await fix(context, CENTRAL_PARK_OUTLIER.lat, CENTRAL_PARK_OUTLIER.lon, 800);
  await bootReal(page);

  await step(page, 'GPS thinks I am in Central Park, ±800 m — can the app tell?', async () => {
    await page.getByTestId('locate-chip').click();
  });

  // Confidence downgrade: the unusable fix is rejected, never mapped to a room.
  await expect(page.getByTestId('gps-status')).toContainText('GPS unavailable indoors', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('locate-chip')).not.toContainText('Gallery');

  await step(page, `Correcting it myself: I'm in Gallery ${F.galleryId}`, async () => {
    await page.getByTestId('locate-input').fill(F.galleryId);
    await page.getByTestId('locate-room-btn').click();
  });

  // The manual anchor wins.
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${F.galleryId}`);
  await expect(page.getByTestId(`room-${F.galleryId}`)).toHaveAttribute(
    'stroke',
    HIGHLIGHT_STROKE,
  );
});
