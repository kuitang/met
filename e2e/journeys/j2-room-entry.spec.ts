/**
 * J2 — Room entry. Type the gallery number posted at the room entrance into
 * the locate sheet → the room polygon highlights on the real map → its
 * objects list opens → one tap reaches the object page.
 * Fixture gallery = the open, polygon-mapped gallery with the most objects in
 * the current data/met.sqlite snapshot (self-adjusts after full hydration).
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import {
  HAS_REAL_TARGET,
  HIGHLIGHT_STROKE,
  awaitHeroImage,
  bootReal,
  locateRoom,
  tapRoom,
} from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J2 room entry: gallery number → highlight → objects → synopsis', async ({ page }) => {
  await bootReal(page);

  await step(
    page,
    `I'm standing in Gallery ${F.galleryId} — typing the number from the door frame`,
    async () => {
      await locateRoom(page, F.galleryId);
    },
  );

  // The room polygon is highlighted (Met-red stroke) on the real map.
  const room = page.getByTestId(`room-${F.galleryId}`);
  await expect(room).toBeVisible();
  await expect(room).toHaveAttribute('stroke', HIGHLIGHT_STROKE);

  await step(page, 'Tap the room to see everything on view in it', async () => {
    await tapRoom(page, F.galleryId);
  });
  const sheet = page.getByTestId('room-sheet');
  // The sheet renders the capped list but must report the TRUE count.
  const fmt = (x: number) => x.toLocaleString('en-US');
  await expect(sheet).toContainText(
    F.galleryTotal > F.galleryObjects.length
      ? `Showing ${fmt(F.galleryObjects.length)} of ${fmt(F.galleryTotal)} objects`
      : `${fmt(F.galleryTotal)} objects`,
  );
  expect(await page.locator('[data-testid^="sheet-object-"]').count()).toBeGreaterThan(0);

  const first = F.galleryObjects[0];
  await step(page, `Open “${first.title}”`, async () => {
    await page.getByTestId(`sheet-object-${first.objectID}`).click();
  });
  await expect(page.getByTestId('object-title')).toHaveText(first.title);
  await awaitHeroImage(page); // recording: hero painted, not the grey block
  await expect(page.getByTestId('object-gallery-chip')).toContainText(F.galleryId);
});
