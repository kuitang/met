/**
 * J10 — Accessibility route. The same 131→822 trip with "Avoid stairs": the
 * route must use the elevator and no instruction may mention stairs, all the
 * way to arrival. (Graph-level guarantee additionally covered by
 * shared/routing.test.ts's J10 block.)
 */
import { expect, test } from '@playwright/test';

import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

test('J10 avoid stairs: elevator-only route 131→822, end to end', async ({ page }) => {
  test.setTimeout(240_000);
  // Deep link with ?avoid=stairs — the toggle hydrates from the URL.
  await bootReal(page, '/route/131/822?avoid=stairs');

  await expect(page.getByTestId('route-summary')).toContainText('Annenberg');
  const toggle = page.getByTestId('avoid-stairs');
  await expect(toggle).toContainText('✓');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await step(page, 'Avoid stairs is ON — walking the whole route', async () => {
    await expect(page.getByTestId('route-step-0')).toContainText('Start in Gallery 131');
  });

  // Walk to arrival, collecting every visible instruction along the way.
  const seen: string[] = [];
  for (let i = 0; i < 45; i++) {
    const cards = page.locator('[data-testid^="route-step-"]');
    for (const text of await cards.allTextContents()) seen.push(text);
    if ((await page.getByTestId('route-arrived').count()) > 0) break;
    await page.getByTestId('im-here').click();
    await page.waitForTimeout(250);
  }

  await expect(page.getByTestId('route-arrived')).toBeVisible();
  const all = seen.join('\n');
  expect(all).not.toMatch(/stairs/i); // no stairs instruction anywhere
  expect(all).toMatch(/elevator/i); // the elevator leg is explicit

  await step(page, 'Arrived — elevator only, not a single stair', async () => {
    await expect(page.getByTestId('route-arrived')).toContainText("You've arrived");
  });
  // Arrived on the destination floor: the STAR target marker is visible.
  await expect(page.getByTestId('marker-target').last()).toBeVisible();

  // Variant D: navigation already IS the home map — ✕ in the nav sheet
  // header is the one-tap exit that restores the browse chrome in place.
  await step(page, 'One tap back to browsing', async () => {
    await page.getByTestId('nav-close').click();
  });
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
});
