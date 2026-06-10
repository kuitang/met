/**
 * J8b — Photo localization via artwork photo (no label in frame). Upload a
 * visitor photo of Wheat Field with Cypresses (436535_photo.jpg, ground
 * truth: Gallery 822, Floor 2) → embedding retrieval returns candidates →
 * the visitor confirms → room anchor set. @live variant runs the real
 * embedding index.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';

import { HAS_REAL_TARGET, HIGHLIGHT_STROKE, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

const FIXTURE = path.resolve(__dirname, '../fixtures/436535_photo.jpg');
const GT_OBJECT = 436535; // Wheat Field with Cypresses
const GT_GALLERY = '822';

async function runArtworkJourney(page: import('@playwright/test').Page) {
  await bootReal(page);

  await step(page, 'No label in frame — photographing the artwork itself', async () => {
    await page.getByTestId('locate-chip').click();
  });

  const chooser = page.waitForEvent('filechooser');
  const locateResponse = page.waitForResponse(
    (r) => r.url().includes('/api/v1/locate/photo') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await page.getByTestId('locate-photo-btn').click();
  await (await chooser).setFiles(FIXTURE);
  expect((await locateResponse).status()).toBe(200);

  // Retrieval candidates sheet: the true object is offered for confirmation.
  const candidate = page.getByTestId(`locate-photo-candidate-${GT_OBJECT}`);
  await expect(candidate).toBeVisible();
  await expect(candidate).toContainText('Wheat Field');
  await expect(candidate).toContainText(`Gallery ${GT_GALLERY}`);

  await step(page, 'Yes — that’s the painting in front of me', async () => {
    await candidate.click();
  });

  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${GT_GALLERY}`);
  // The anchor's floor follows the gallery (2) and the room highlights.
  await expect(page.getByTestId(`room-${GT_GALLERY}`)).toHaveAttribute(
    'stroke',
    HIGHLIGHT_STROKE,
  );
}

test('J8b photo artwork: upload → candidates → confirm → room anchor (mock)', async ({
  page,
}) => {
  await runArtworkJourney(page);
});

test('J8b @live: real embedding retrieval (needs LLM_LIVE=1 + non-mock server)', async ({
  page,
}) => {
  test.skip(process.env.LLM_LIVE !== '1', 'live LLM smoke runs only with LLM_LIVE=1');
  await runArtworkJourney(page);
});
