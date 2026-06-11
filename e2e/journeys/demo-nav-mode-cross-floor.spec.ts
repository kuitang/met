/**
 * DEMO — nav mode, cross-floor (variant D: "the map IS the app").
 *
 * A paced, captioned recording for the user — not a CI gate (the same flows
 * are asserted in checks/nav-mode.spec.ts and journeys J9/J10). Gallery 131
 * (Temple of Dendur, F1) → the Van Gogh gallery 822 (Annenberg, F2):
 * entering nav mode from the room sheet, the three-detent nav sheet (HALF
 * steps → HEADER-ONLY max-map ribbon → FULL step list), checkpoint walking,
 * the elevator step auto-switching the visible floor with the home/star
 * floor-chip bubbles, arrival, WHAT'S HERE into the destination's artifacts
 * teardown, and ✕/DONE back to browse with the search bar restored.
 *
 * Run (real stack): JOURNEY_TARGET=http://localhost:8789 \
 *   npx playwright test --project=journeys journeys/demo-nav-mode-cross-floor.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

import { fix } from '../helpers/geo';
import {
  FIFTH_AVE_ENTRANCE,
  HAS_REAL_TARGET,
  bootReal,
  locateRoom,
  tapRoom,
} from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');

/** Mouse-drag the nav-sheet handle by dy px (same idiom as checks/nav-mode). */
async function dragHandle(page: Page, dy: number) {
  const h = (await page.getByTestId('nav-sheet-handle').boundingBox())!;
  const cx = h.x + h.width / 2;
  const cy = h.y + h.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx, cy + (dy * i) / 10);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(180); // zero the velocity tracker → position snap
  await page.mouse.up();
}

const sheetTop = async (page: Page) =>
  (await page.getByTestId('nav-sheet').last().boundingBox())!.y;

test('DEMO nav mode: 131 (F1) → Van Gogh in 822 (F2), detents, floor flip, arrival', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await fix(context, FIFTH_AVE_ENTRANCE.lat, FIFTH_AVE_ENTRANCE.lon, 40);
  await bootReal(page);

  await step(page, 'I’m standing in Gallery 131 — the Temple of Dendur (Floor 1)', async () => {
    await locateRoom(page, '131');
    await page.waitForTimeout(1200);
  });

  await step(page, 'Destination: the Van Gogh gallery — 822, up on Floor 2', async () => {
    await page.getByTestId('floor-chip-2').click();
    await page.waitForTimeout(800);
    await tapRoom(page, '822');
    await expect(page.getByTestId('room-sheet')).toContainText('Annenberg');
    await page.waitForTimeout(1200);
  });

  await step(page, 'DIRECTIONS — navigation takes over the map', async () => {
    await page.getByTestId('room-directions').click();
    await expect(page.getByTestId('nav-sheet').last()).toBeVisible();
    // Modal nav mode: the header is the destination identity. (The browse
    // entry stays mounted under the pushed nav entry, so chrome-gone is
    // asserted by count in checks/nav-mode.spec.ts, not here.)
    await expect(page.getByTestId('route-summary').last()).toContainText('Annenberg');
    await expect(page.getByTestId('route-step-0').last()).toContainText('Start in Gallery 131');
    await page.waitForTimeout(2000); // HALF detent: header + first steps
  });

  await step(page, 'Drag down to the ribbon — maximum map, progress still glanceable', async () => {
    await dragHandle(page, 350);
    await page.waitForTimeout(600);
    expect(await sheetTop(page)).toBeGreaterThan(640); // HEADER-ONLY band
    await expect(page.getByTestId('route-summary').last()).toContainText('Step 1 of');
    // Cross-floor legibility: home bubble on the F1 chip, star on F2.
    await expect(page.getByTestId('chip-badge-home-1').last()).toBeVisible();
    await expect(page.getByTestId('chip-badge-target-2').last()).toBeVisible();
    await page.waitForTimeout(1800);
  });

  await step(page, 'Back to half — walking the Floor 1 leg, “I’m here” at each checkpoint', async () => {
    await dragHandle(page, -210);
    await page.waitForTimeout(600);
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('im-here').last().click();
      await page.waitForTimeout(900);
    }
  });

  await step(page, 'The elevator step — the map switches to Floor 2 by itself', async () => {
    // Keep walking until the destination's star marker is on the visible
    // floor — that is the auto-switch (it only renders on the target floor).
    for (let i = 0; i < 20; i++) {
      if (await page.getByTestId('marker-target').last().isVisible().catch(() => false)) break;
      await page.getByTestId('im-here').last().click();
      await page.waitForTimeout(900);
    }
    await expect(page.getByTestId('marker-target').last()).toBeVisible();
    await expect(page.getByTestId('chip-badge-home-1').last()).toBeVisible();
    await page.waitForTimeout(1500);
  });

  await step(page, 'Drag up to FULL — the whole step list, progress bar on top', async () => {
    await dragHandle(page, -520);
    await page.waitForTimeout(600);
    expect(await sheetTop(page)).toBeLessThan(60); // FULL
    await page.waitForTimeout(1800);
  });

  await step(page, 'Walking the Floor 2 leg to the Van Gogh', async () => {
    for (let i = 0; i < 20; i++) {
      if ((await page.getByTestId('route-arrived').count()) > 0) break;
      await page.getByTestId('im-here').last().click();
      await page.waitForTimeout(700);
    }
    await expect(page.getByTestId('route-arrived').last()).toContainText("You've arrived");
    await page.waitForTimeout(1500);
  });

  await step(page, 'WHAT’S HERE — straight into Gallery 822’s artifacts', async () => {
    await page.getByTestId('arrived-whats-here').last().click();
    await expect(page.getByTestId('nav-sheet')).toHaveCount(0);
    await expect(page.getByTestId('room-sheet').last()).toContainText('Annenberg');
    await page.waitForTimeout(2000);
  });

  await step(page, 'Close the sheet — back to browsing, search bar restored', async () => {
    await page.getByTestId('room-sheet-close').last().click();
    await expect(page.getByTestId('home-search-bar').last()).toBeVisible();
    await expect(page.getByTestId('locate-chip').last()).toContainText('Gallery 822');
    await page.waitForTimeout(1500);
  });
});
