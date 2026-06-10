/**
 * J9 — Navigate + checkpoint advance + recalc (the centerpiece). Gallery 131
 * (Temple of Dendur) → the Van Gogh's gallery 822 (Annenberg Collection):
 * real-graph route + instructions; "I'm here" checkpoints advance the steps
 * monotonically; a confident off-route fix triggers exactly one "Rerouting…"
 * recalc from the new anchor; arrival state at the end.
 *
 * Positioning honesty (gps.md + shared/positioning): GPS can NEVER claim a
 * room, so mid-route advancing is checkpoint/anchor-driven by design — the
 * walkAlong segment shows live GPS fixes failing to clobber the fresh manual
 * room anchor (that's the fusion rule under test, not a limitation of the
 * spec).
 */
import { expect, test, type Page } from '@playwright/test';

import { countObjectsIn, loadJourneyFixtures } from '../helpers/db';
import { fix, walkAlong } from '../helpers/geo';
import { FIFTH_AVE_ENTRANCE, HAS_REAL_TARGET, bootReal, tapRoom } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

const MET_RED = 'rgb(228, 0, 43)';

/** Index of the visually active step card (Met-red border). */
async function activeStepIndex(page: Page): Promise<number> {
  return page.evaluate((red) => {
    for (const c of document.querySelectorAll('[data-testid^="route-step-"]')) {
      if (getComputedStyle(c).borderColor === red) {
        return Number((c.getAttribute('data-testid') ?? '').split('-').pop());
      }
    }
    return -1;
  }, MET_RED);
}

test('J9 navigate 131→822: route, checkpoint advance, one reroute, arrival', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await fix(context, FIFTH_AVE_ENTRANCE.lat, FIFTH_AVE_ENTRANCE.lon, 40);
  await bootReal(page);

  await step(page, 'Arriving — GPS puts me at wing level only', async () => {
    await page.getByTestId('locate-chip').click();
    await expect(page.getByTestId('gps-status')).toContainText('Near Great Hall', {
      timeout: 15_000,
    });
  });

  await step(page, 'I’m in Gallery 131 — the Temple of Dendur', async () => {
    await page.getByTestId('locate-input').fill('131');
    await page.getByTestId('locate-room-btn').click();
  });
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');

  // Live GPS fixes while "walking" (real gallery centroids en route): the
  // fresh manual room anchor must win — GPS never claims or clobbers a room.
  await step(page, 'Walking — noisy indoor GPS cannot steal a fresh room fix', async () => {
    await walkAlong(context, F.walkCoords, { intervalMs: 500, accuracyM: 45 });
  });
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');

  await step(page, 'Destination: the Van Gogh in Gallery 822, floor 2', async () => {
    await page.getByTestId('floor-chip-2').click();
    await tapRoom(page, '822');
  });
  await expect(page.getByTestId('room-sheet')).toContainText('Annenberg');

  await step(page, 'Directions', async () => {
    await page.getByTestId('room-directions').click();
  });

  const summary = page.getByTestId('route-summary');
  await expect(summary).toContainText('Temple of Dendur');
  await expect(summary).toContainText('Annenberg');
  await expect(page.getByTestId('route-step-0')).toContainText('Start in Gallery 131');
  expect(await activeStepIndex(page)).toBe(0);

  // --- checkpoint advance: monotone step progression --------------------
  await step(page, '“I’m here” at each checkpoint — steps advance', async () => {
    let prev = 0;
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('im-here').click();
      await page.waitForTimeout(400);
      const cur = await activeStepIndex(page);
      expect(cur).toBeGreaterThanOrEqual(prev + 1); // strictly monotone
      prev = cur;
    }
  });

  // --- off-route fix → exactly one reroute --------------------------------
  await step(page, 'Wrong turn! A confident fix lands OFF the route', async () => {
    await page.getByTestId('simulate-fix').click();
  });
  await expect(page.getByTestId('rerouting-toast')).toBeVisible();
  await expect(summary).not.toContainText('Temple of Dendur'); // new origin
  await expect(summary).toContainText('Annenberg'); // same destination
  await expect(page.getByTestId('rerouting-toast')).toHaveCount(0, { timeout: 5_000 });
  expect(await activeStepIndex(page)).toBe(0); // recalc restarts the steps

  // --- walk the rest: no second reroute, then arrival ----------------------
  await step(page, 'Back on track — walking the recalculated route', async () => {
    let prev = -1;
    for (let i = 0; i < 45; i++) {
      if ((await page.getByTestId('route-arrived').count()) > 0) break;
      // Reroute must have fired exactly once per deviation (machine re-armed
      // only by an on-route advance, and we stay on-route from here).
      await expect(page.getByTestId('rerouting-toast')).toHaveCount(0);
      await page.getByTestId('im-here').click();
      await page.waitForTimeout(250);
      const cur = await activeStepIndex(page);
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });

  await expect(page.getByTestId('route-arrived')).toBeVisible();
  await expect(page.getByTestId('route-arrived')).toContainText("You've arrived");
  if (countObjectsIn('822') > 0) {
    await expect(page.getByTestId('arrived-whats-here')).toBeVisible();
  } else {
    console.log('[J9] gallery 822 has no objects in the partial snapshot — ' +
      'the "What\'s here" arrival CTA assertion re-arms after full hydration.');
  }
});
