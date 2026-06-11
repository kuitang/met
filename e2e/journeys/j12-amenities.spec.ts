/**
 * J12 — Amenities. Anchored in a gallery, search "restroom": results are
 * ranked nearest-first by graph (walking) distance from the anchor, and rows
 * carry NO inline actions (one row anatomy: kind glyph, name, floor chip).
 * TAPPING the nearest row opens the amenity sheet on the home map — the thin
 * dual-action variant (DIRECTIONS / I'M HERE) — it must never silently move
 * the visitor's location. DIRECTIONS routes from the anchor; the header HOME
 * button is the one-tap way back with the anchor intact.
 * (Grammar updated by the gallery/amenity search-row PR, superseding the
 * PR #8 tap-routes-directly behavior.)
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J12 amenities: "restroom" → nearest-first → amenity sheet → route', async ({
  page,
}) => {
  // Deep-link anchor (also exercised by J13) so distance has an origin.
  await bootReal(page, `/?room=${F.galleryId}`);
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${F.galleryId}`);

  await step(page, 'Nature calls: searching “restroom”', async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill('restroom');
  });

  const rows = page.locator('[data-testid^="amenity-"]');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // One row anatomy: no inline action buttons on any row.
  await expect(page.locator('[data-testid^="amenity-im-here-"]')).toHaveCount(0);
  const firstRowId = (await rows.first().getAttribute('data-testid'))!.replace(/^amenity-/, '');

  // Sorted by graph distance: the "~N m walk" labels must be non-decreasing.
  const distances: number[] = [];
  for (const text of await rows.allTextContents()) {
    const m = text.match(/~(\d+) m walk/);
    if (m) distances.push(Number(m[1]));
  }
  expect(distances.length).toBeGreaterThanOrEqual(2); // routable from the anchor
  for (let i = 1; i < distances.length; i++) {
    expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
  }

  // TAPPING the nearest row opens the amenity sheet (map focused, dual
  // actions) — the visitor's location does not move.
  await step(page, `Nearest is ~${distances[0]} m away — tap it`, async () => {
    await rows.first().click();
  });
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-amenity-glyph')).toBeVisible();
  await expect(page.getByTestId('room-im-here')).toBeVisible();

  // DIRECTIONS routes from the anchor to exactly that amenity.
  await step(page, 'DIRECTIONS from my gallery to the restroom', async () => {
    await page.getByTestId('room-directions').click();
  });
  await expect(page).toHaveURL(new RegExp(`[?&]nav=${F.galleryId}(:|%3A)${firstRowId}`));
  await expect(page.getByTestId('route-summary')).toContainText(/Restroom/i);
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');

  // The tap did NOT relocate the visitor: ✕ exits nav mode in place (variant
  // D — navigation has no top chrome) with the Gallery anchor untouched.
  await step(page, 'One tap back to browsing — my location never moved', async () => {
    await page.getByTestId('nav-close').click();
  });
  await expect(page.getByTestId('home-search-bar').last()).toBeVisible();
  await expect(page.getByTestId('locate-chip').last()).toContainText(`Gallery ${F.galleryId}`);
});
