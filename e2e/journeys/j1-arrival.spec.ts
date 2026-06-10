/**
 * J1 — Arrival. GPS fix at the Fifth Ave entrance (40.7794,-73.9632, ±40 m)
 * → the app anchors at wing level ("Near Great Hall · Floor 1"), renders the
 * real floor-1 map, and never claims a room from GPS (the load-bearing rule
 * from data/evals/reports/gps.md).
 */
import { expect, test } from '@playwright/test';

import { fix } from '../helpers/geo';
import { FIFTH_AVE_ENTRANCE, HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

test('J1 arrival: entrance GPS → wing-level anchor, floor 1, no room claim', async ({
  page,
  context,
}) => {
  await fix(context, FIFTH_AVE_ENTRANCE.lat, FIFTH_AVE_ENTRANCE.lon, 40);
  await bootReal(page);

  // Before any fix the chip is the red "unknown" call to action; its second
  // line always shows the active venue (venue is location state).
  await expect(page.getByTestId('locate-chip')).toContainText('Location unknown');
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('Fifth Avenue');

  await step(page, 'Just arrived at the Met — checking my location (GPS, ±40 m)', async () => {
    await page.getByTestId('locate-chip').click();
  });

  const gps = page.getByTestId('gps-status');
  await expect(gps).toContainText('Near Great Hall · Floor 1', { timeout: 15_000 });
  await expect(gps).toContainText('wing-level only');

  await step(page, 'GPS is honest indoors: wing-level only — never a room claim', async () => {
    await page.goBack();
  });

  const chip = page.getByTestId('locate-chip');
  await expect(chip).toContainText('Near Great Hall · Floor 1');
  await expect(chip).not.toContainText('Gallery'); // no room-level claim from GPS
  await expect(page.getByTestId('floor-map-real')).toBeVisible();
  expect(await page.locator('path[data-testid^="room-"]').count()).toBeGreaterThan(100);
});
