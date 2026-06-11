/**
 * DEMO — viewport-center zoom anchoring + the new + / − map buttons.
 *
 * A paced, captioned recording for the user — not a CI gate (the same
 * behavior is asserted in checks/ux-fixes.spec.ts). Over the REAL Fifth Ave
 * floor plan: pan well off-center, two-finger pinch in and out (the map
 * point under the viewport center stays put — the old math anchored to the
 * pre-pan center and dragged the map sideways while zooming), then step the
 * zoom with the new floating + / − buttons.
 *
 * Run (real stack): JOURNEY_TARGET=http://localhost:8923 \
 *   npx playwright test --project=journeys journeys/demo-zoom-fix.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

import { fix } from '../helpers/geo';
import { FIFTH_AVE_ENTRANCE, HAS_REAL_TARGET, bootReal, locateRoom } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
test.use({ hasTouch: true }); // two-finger pinch via CDP touch synthesis

/** Slow mouse pan; dismisses the room sheet a same-room drag-click opens. */
async function pan(page: Page, cx: number, cy: number, dx: number, dy: number) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(cx + (dx * i) / 14, cy + (dy * i) / 14);
    await page.waitForTimeout(28);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  if (await page.getByTestId('room-sheet').isVisible()) {
    await page.getByTestId('room-sheet-close').click();
    await expect(page.getByTestId('room-sheet')).toBeHidden();
  }
}

/** Paced two-finger pinch centered on (cx, cy): gap startGap → endGap. */
async function pinch(page: Page, cx: number, cy: number, startGap: number, endGap: number) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (gap: number) => [
    { x: cx, y: cy - gap / 2, id: 0 },
    { x: cx, y: cy + gap / 2, id: 1 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(startGap) });
  for (let i = 1; i <= 24; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pts(startGap + ((endGap - startGap) * i) / 24),
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('DEMO zoom fix: off-center pan, center-anchored pinch in/out, + / − buttons', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await fix(context, FIFTH_AVE_ENTRANCE.lat, FIFTH_AVE_ENTRANCE.lon, 40);
  await bootReal(page);

  const c = { x: 195, y: 422 }; // viewport center (390×844)

  await step(page, 'I’m in Gallery 131 — the Temple of Dendur', async () => {
    await locateRoom(page, '131');
    await page.waitForTimeout(1000);
  });

  await step(page, 'Pan the map well off-center…', async () => {
    await pan(page, c.x, c.y, 120, 150);
    await page.waitForTimeout(600);
  });

  await step(page, 'Pinch to zoom IN — anchored at the viewport center, not off-screen', async () => {
    await pinch(page, c.x, c.y, 110, 320);
    await page.waitForTimeout(800);
  });

  await step(page, 'Pinch to zoom OUT — same center anchor', async () => {
    await pinch(page, c.x, c.y, 320, 130);
    await page.waitForTimeout(800);
  });

  await step(page, 'New + / − buttons: one 1.4× spring step per tap', async () => {
    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(900);
    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(900);
    await page.getByTestId('zoom-out').click();
    await page.waitForTimeout(900);
    await page.getByTestId('zoom-out').click();
    await page.waitForTimeout(1200);
  });
});
