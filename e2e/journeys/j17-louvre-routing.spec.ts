/**
 * J17 — Louvre routing (D7 gate: fidelity "routed"). Selecting the Louvre in
 * the locate sheet's museum picker renders REAL Louvre floor geometry — the
 * data-driven floor chips flip to the Louvre's own -1/0/1/2 vocabulary (no
 * Met "G", floor 0 is genuinely "0" in Paris) — and routing works end-to-end
 * BETWEEN salles: anchor at Salle 345 (Vénus de Milo, floor 0) via
 * gallery-number entry, search "711", land on the Salle de la Joconde's room
 * sheet, DIRECTIONS → a real cross-floor route (the evals' landmark pair,
 * ~263 m, stairs 0→1) with the polyline on the map and room-grouped step
 * instructions, advanced once via the I'M-HERE checkpoint.
 *
 * Room identity is site-scoped throughout ("louvre:711" — the Met has its
 * own galleries 345 AND 711, see provider.ts): the search row testID, the
 * `?focus=` param, and the `?nav=` pair (its ':' separator carries the ids
 * with their own ':' escaped as '~' — provider.ts encodeNavId) all use the
 * scoped form, while every VISIBLE surface reads the bare salle number.
 */
import { expect, test } from '@playwright/test';

import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

test('J17 Louvre: venue switch, real floors, Salle 345 → 711 route', async ({ page }) => {
  test.setTimeout(120_000);
  await bootReal(page);

  await step(page, 'Paris! Switching museum: the Louvre (locate sheet)', async () => {
    await page.getByTestId('locate-chip').click();
    await page.getByTestId('venue-louvre').click();
    await page.goBack();
  });
  // Manual pick: chip flips, no auto-switch toast (same rule as J14).
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('Louvre');
  await expect(page.getByTestId('venue-toast')).toHaveCount(0);
  // Data-driven floors: the Louvre's own -1 / 0 / 1 / 2 — no Met "G".
  for (const label of ['-1', '0', '1', '2']) {
    await expect(page.getByTestId(`floor-chip-${label}`)).toBeVisible();
  }
  await expect(page.getByTestId('floor-chip-G')).toHaveCount(0);
  // Real geometry, not a schematic: dozens of salle polygons on the floor.
  expect(await page.locator('path[data-testid^="room-"]').count()).toBeGreaterThanOrEqual(20);

  await step(page, 'I’m in Salle 345 — the Vénus de Milo (floor 0)', async () => {
    await page.getByTestId('locate-chip').click();
    await page.getByTestId('locate-input').fill('345');
    await page.getByTestId('locate-room-btn').click();
  });
  // The typed number resolves against the ACTIVE venue: Louvre floor 0 —
  // never the Met's own Gallery 345 (Arts of Africa, floor 1).
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 345 · Floor 0');
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('Louvre');

  await step(page, 'Where is the Mona Lisa? Searching salle “711”', async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill('711');
  });
  const row = page.getByTestId('gallery-louvre:711');
  await expect(row).toContainText('Salle 711 - Salle de la Joconde');
  await expect(row).toContainText('Gallery 711'); // bare number, no scope prefix

  await step(page, 'One tap: map focused on the Salle de la Joconde', async () => {
    await row.click();
  });
  await expect(page).toHaveURL(/[?&]focus=louvre(:|%3A)711/);
  await expect(page.getByTestId('room-sheet')).toContainText('Salle de la Joconde');
  await expect(page.getByTestId('room-sheet')).toContainText('Floor 1');

  await step(page, 'Directions from my salle', async () => {
    await page.getByTestId('room-directions').click();
  });
  // Scoped ids ride the nav param with their ':' escaped ('~') so the pair
  // separator stays unambiguous — see provider.ts encodeNavId.
  await expect(page).toHaveURL(/[?&]nav=louvre~345(:|%3A)louvre~711/);
  const summary = page.getByTestId('route-summary');
  await expect(summary).toContainText('Salle de la Joconde');
  await expect(summary).toContainText('Gallery 711');
  await expect(page.getByTestId('route-step-0')).toContainText('Start in Gallery 345');
  // Cross-floor legibility (345 is floor 0, 711 is floor 1): home glyph on
  // the visible floor, home/target badges on the chips, polyline in the map
  // transform. (.last() — home stays mounted under the pushed nav entry.)
  await expect(page.getByTestId('route-polyline').last()).toBeVisible();
  await expect(page.getByTestId('marker-home').last()).toBeVisible();
  await expect(page.getByTestId('chip-badge-home-0').last()).toBeVisible();
  await expect(page.getByTestId('chip-badge-target-1').last()).toBeVisible();

  // Let the recording linger on the full route before walking.
  await step(page, 'A real route through the Louvre — ~263 m, cross-floor', async () => {
    await page.waitForTimeout(1_800); // recording aesthetic (journeys are discipline-exempt)
  });

  await step(page, '“I’m here” — the steps advance salle by salle', async () => {
    await page.getByTestId('im-here').click();
  });
  // Step 1 is now active; its room meta line reads the next salle en route.
  await expect(page.getByTestId('route-step-1')).toBeVisible();

  await step(page, 'Turn-by-turn to the Joconde — à bientôt!', async () => {
    await page.waitForTimeout(1_500); // recording aesthetic (journeys are discipline-exempt)
  });
});
