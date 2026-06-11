import { expect, test } from '@playwright/test';

/**
 * CANARY — the fail-fast gate the whole suite depends on (playwright.config:
 * checks + webkit-render declare `dependencies: ['canary']`, so a red canary
 * SKIPS them and surfaces the one real error in seconds instead of dozens of
 * identical element-not-found cascades; see CI runs 27312485379/27313603005:
 * 62 × ~46 s ≈ 25 wasted minutes each, for ONE root cause).
 *
 * It asserts the two failure classes history actually produced:
 *  - broken bundle / blank shell: #root stays empty (bad export, JS crash);
 *  - wrong-provider export ("Couldn't load museum data"): the shell mounts
 *    but no map/room ever renders — catches the Metro real→stub cache
 *    poisoning class even if the metro.config fingerprint fix regresses.
 *
 * Provider-agnostic on purpose: stub renders floor-map + rect rooms, the
 * real provider renders floor-map-real + path rooms; both must yield a room
 * polygon and the home search bar.
 */
test('canary: app shell, floor map, and a room render', async ({ page }) => {
  await page.goto('/');

  // Expo web mounts the app into div#root; empty #root means a broken bundle.
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByTestId('app-root')).toBeVisible();

  // The map shell (either provider's) with at least one room polygon, plus
  // the search bar — i.e. the app booted its data provider for real.
  // e2e-discipline: allow(10s — under JOURNEY_TARGET the real provider's
  // first-run met.sqlite download gates this; static stub mode renders in ms)
  const map = page.getByTestId('floor-map').or(page.getByTestId('floor-map-real'));
  await expect(map.first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid^="room-"]').first()).toBeVisible();
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
});
