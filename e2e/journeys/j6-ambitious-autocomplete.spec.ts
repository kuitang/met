/**
 * J6 — Ambitious autocomplete. A multi-word query that spans FTS columns
 * (title + medium/classification) matches locally, no LLM involved.
 * Fixture: "gold swords" once arms & armor hydrates into data/met.sqlite;
 * until then a validated "<medium-word> <title-word>" pair derived from the
 * snapshot (helpers/db.ts runs the exact autocomplete SQL to pick it).
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J6 ambitious autocomplete: multi-word cross-field query matches locally', async ({
  page,
}) => {
  await bootReal(page);

  await step(page, `Vague but local: “${F.multiWordQuery}”`, async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill(F.multiWordQuery);
  });

  // The known-matching object (validated against the same FTS SQL the app
  // runs) is among the suggestions — instantly, from the on-device index.
  const hit = page.getByTestId(`suggestion-${F.multiWordHit.objectID}`);
  await expect(hit).toBeVisible();
  await expect(hit).toContainText(F.multiWordHit.title);
  if (F.multiWordQuery === 'gold swords') {
    // Full-catalog showcase: arms & armor classification surfaces.
    await expect(page.locator('[data-testid^="suggestion-"]').first()).toContainText(/Sword/i);
  }
});
