/**
 * J8 — Photo localization via wall label. Upload a label photo
 * (e2e/fixtures/544442_label.jpg, ground truth: Gallery 131, Floor 1) →
 * POST /api/v1/locate/photo OCRs the label → deterministic catalog match →
 * one tap anchors the visitor in the label's gallery. Ground truth holds for
 * both server modes: live Gemini OCR reads the real label's accession
 * (→ Gallery 131, the canonical recording mode); LLM_MOCK=1 serves the same
 * answer from a hash-keyed fixture.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';

import { HAS_REAL_TARGET, HIGHLIGHT_STROKE, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

const FIXTURE = path.resolve(__dirname, '../fixtures/544442_label.jpg');
const GT_GALLERY = '131'; // ground truth for 544442_label.jpg

async function runLabelJourney(page: import('@playwright/test').Page) {
  await bootReal(page);

  await step(page, 'Lost — photographing the wall label next to me', async () => {
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

  // The label was read and matched deterministically — gallery + floor known.
  const label = page.getByTestId('locate-photo-label');
  await expect(label).toBeVisible();
  await expect(label).toContainText(`Gallery ${GT_GALLERY}`);
  await expect(label).toContainText('Wall label');

  await step(page, 'That’s me — anchor to the label’s gallery', async () => {
    await label.click();
  });

  // Anchor gallery equals the fixture's ground truth, room highlighted.
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${GT_GALLERY}`);
  await expect(page.getByTestId(`room-${GT_GALLERY}`)).toHaveAttribute(
    'stroke',
    HIGHLIGHT_STROKE,
  );
}

test('J8 photo label: upload → OCR match → room anchor', async ({ page }) => {
  await runLabelJourney(page);
});
