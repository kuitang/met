/**
 * J4 — Known artifact. Type a specific object's title → the top autocomplete
 * suggestion carries its gallery number inline → one tap opens the object
 * page. Fixture = a distinctive clean-titled on-view object read from
 * data/met.sqlite at spec load.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, awaitHeroImage, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J4 known artifact: title search → gallery inline → object page', async ({ page }) => {
  await bootReal(page);

  await step(page, `Looking for “${F.artifact.title}”`, async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill(F.artifact.title);
  });

  const row = page.getByTestId(`suggestion-${F.artifact.objectID}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(F.artifact.title);
  // The gallery number is right in the suggestion — no extra tap to find it.
  await expect(row).toContainText(`Gallery ${F.artifact.galleryNumber}`);

  await step(page, 'Open it', async () => {
    await row.click();
  });
  await expect(page.getByTestId('object-title')).toHaveText(F.artifact.title);
  await awaitHeroImage(page); // recording: hero painted, not the grey block
  await expect(page.getByTestId('object-gallery-chip')).toContainText(
    F.artifact.galleryNumber,
  );
  // Navigation entry point is live (gallery exists on the map).
  await expect(page.getByTestId('navigate-here')).toBeVisible();
});
