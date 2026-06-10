/**
 * J13 — Deep links. Cold-load /object/{id} and /route/131/822?avoid=stairs:
 * the full state hydrates from the URL alone; the object page's Share button
 * copies the canonical URL — i.e. URL state round-trips.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, awaitHeroImage, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J13 deep links: cold object + route URLs hydrate; share copies canonical URL', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // --- /object/{id} cold ----------------------------------------------------
  await step(page, `Cold deep link: /object/${F.artifact.objectID}`, async () => {
    await bootReal(page, `/object/${F.artifact.objectID}`);
  });
  await expect(page.getByTestId('object-title')).toHaveText(F.artifact.title);
  await awaitHeroImage(page); // recording: hero painted, not the grey block
  await expect(page.getByTestId('object-gallery-chip')).toContainText(
    F.artifact.galleryNumber,
  );

  // Share → the canonical URL is on the clipboard (round trip).
  await step(page, 'Share — copies the canonical link', async () => {
    await page.getByTestId('object-share').click();
  });
  await expect(page.getByTestId('object-share')).toContainText('Link copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).pathname).toBe(`/object/${F.artifact.objectID}`);

  // …and the copied URL itself cold-loads back to the same object.
  await step(page, 'The copied link round-trips', async () => {
    await bootReal(page, new URL(copied).pathname);
  });
  await expect(page.getByTestId('object-title')).toHaveText(F.artifact.title);
  await awaitHeroImage(page);

  // --- /route/131/822?avoid=stairs cold --------------------------------------
  await step(page, 'Cold deep link: /route/131/822?avoid=stairs', async () => {
    await bootReal(page, '/route/131/822?avoid=stairs');
  });
  await expect(page.getByTestId('route-summary')).toContainText('Temple of Dendur');
  await expect(page.getByTestId('route-summary')).toContainText('Annenberg');
  // The avoid=stairs param hydrated the toggle.
  await expect(page.getByTestId('avoid-stairs')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('route-step-0')).toContainText('Start in Gallery 131');
});
