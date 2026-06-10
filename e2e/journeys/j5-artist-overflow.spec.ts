/**
 * J5 — Artist overflow. Search the artist with the most on-view objects:
 * every suggestion shows its gallery inline, and "All N results" opens the
 * full page whose count matches the suggestion footer.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J5 artist overflow: suggestions w/ galleries → full results page', async ({ page }) => {
  // First two clean words of the artist name ("Claude Monet" → both; long
  // manufactory names → a distinctive prefix).
  const query = (F.artist.match(/[A-Za-z]+/g) ?? []).slice(0, 2).join(' ');
  await bootReal(page);

  await step(page, `Searching the artist: “${query}” (${F.artistCount} works on view)`, async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill(query);
  });

  const rows = page.locator('[data-testid^="suggestion-"]');
  await expect(rows.first()).toBeVisible();
  const visible = await rows.count();
  expect(visible).toBeGreaterThanOrEqual(Math.min(F.artistCount, 8) > 1 ? 2 : 1);
  // Every suggestion row carries a room (or an explicit not-on-view flag).
  for (let i = 0; i < visible; i++) {
    await expect(rows.nth(i)).toContainText(/Gallery \d+|Not on view/);
  }

  // Footer count and the results page must agree.
  const link = page.getByTestId('all-results-link');
  const total = Number(((await link.textContent()) ?? '').match(/All (\d+) result/)?.[1]);
  expect(total).toBeGreaterThanOrEqual(Math.min(F.artistCount, 2));

  await step(page, 'See all results', async () => {
    await link.click();
  });
  await expect(page.getByText(new RegExp(`^${total} results? ·`))).toBeVisible();
  // The list is virtualized (FlatList windowing): the DOM holds the initial
  // render window, not all `total` rows. Assert the window is populated and
  // never exceeds the advertised total.
  const resultRows = page.locator('[data-testid^="result-"]');
  const rendered = await resultRows.count();
  expect(rendered).toBeGreaterThanOrEqual(Math.min(total, 10));
  expect(rendered).toBeLessThanOrEqual(total);
  await expect(resultRows.first()).toContainText(/Gallery \d+|Not on view/);
});
