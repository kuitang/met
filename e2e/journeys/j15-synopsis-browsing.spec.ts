/**
 * J15 — Synopsis browsing (the Bloomberg-Connects pain-point killer): from
 * one object, ‹/› pages through everything in the same room sequentially —
 * no re-search, no list backtracking. Order matches the provider's in-room
 * ordering (highlights first), straight from the local DB.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, awaitHeroImage, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J15 synopsis browsing: next/previous through the room, no re-search', async ({
  page,
}) => {
  const objs = F.galleryObjects;
  expect(objs.length).toBeGreaterThanOrEqual(3);
  const n = objs.length;

  await bootReal(page, `/object/${objs[0].objectID}`);
  await expect(page.getByTestId('object-title')).toHaveText(objs[0].title);
  await awaitHeroImage(page); // recording: each page turn shows a painted hero
  await expect(page.getByTestId('object-position')).toHaveText(
    `1 of ${n} in Gallery ${F.galleryId}`,
  );

  await step(page, 'Next piece in this room ›', async () => {
    await page.getByTestId('object-next').click();
  });
  await expect(page.getByTestId('object-title')).toHaveText(objs[1].title);
  await awaitHeroImage(page);
  await expect(page.getByTestId('object-position')).toHaveText(
    `2 of ${n} in Gallery ${F.galleryId}`,
  );
  expect(page.url()).toContain(`/object/${objs[1].objectID}`);

  await step(page, 'And the next ›', async () => {
    await page.getByTestId('object-next').click();
  });
  await expect(page.getByTestId('object-title')).toHaveText(objs[2].title);
  await awaitHeroImage(page);
  await expect(page.getByTestId('object-position')).toHaveText(
    `3 of ${n} in Gallery ${F.galleryId}`,
  );

  await step(page, '‹ Back one', async () => {
    await page.getByTestId('object-prev').click();
  });
  await expect(page.getByTestId('object-title')).toHaveText(objs[1].title);
  await awaitHeroImage(page);
  await expect(page.getByTestId('object-position')).toHaveText(
    `2 of ${n} in Gallery ${F.galleryId}`,
  );
});
