import { expect, test, type Page } from '@playwright/test';

import { settledInBand } from '../helpers/settle';

/**
 * Room-sheet detents — the Home bottom sheet snaps between exactly three
 * positions (no continuous resize):
 *   FULL   sheet top 12px below the (web: zero) safe inset — full-screen list
 *   HALF   340px visible — the default split, set on every room selection
 *   HEADER handle + title row docked at the bottom; map tappable above
 *
 * The pan target is the header strip (handle + title); release projects the
 * gesture velocity ~150ms ahead and snaps to the nearest detent. Tapping the
 * handle cycles upward (header → half → full → header) for non-drag users.
 *
 * Geometry note: drags here cross the detent midpoint and then HOLD before
 * releasing, so the velocity projection is ~0 and the snap is settled by
 * position alone — synthetic mouse moves carry erratic velocity, and a real
 * fling is allowed to pass through a detent by design (e.g. full → header).
 *
 * Waits: every post-gesture wait is settledInBand (helpers/settle.ts) — the
 * sheet's top edge stable inside the expected detent band — never a fixed
 * pause. The in-gesture pauses below shape the synthetic INPUT (velocity is
 * a function of time) and are discipline-allowlisted.
 */

const VIEW = { width: 390, height: 844 };
const HALF_VISIBLE = 340;
const FULL_TOP = 12; // FULL_TOP_GAP; insets.top === 0 on web
const TOL = 3;

test.use({ viewport: VIEW });

const sheetTop = async (page: Page) => (await page.getByTestId('room-sheet').boundingBox())!.y;

/** Settle assertions for the three detents (band = expected position ± TOL). */
const settleAtHalf = (page: Page, nonce: string) =>
  settledInBand(
    page,
    'room-sheet',
    VIEW.height - HALF_VISIBLE - TOL,
    VIEW.height - HALF_VISIBLE + TOL,
    nonce,
  );
const settleAtFull = (page: Page, nonce: string) =>
  settledInBand(page, 'room-sheet', FULL_TOP - TOL, FULL_TOP + TOL, nonce);
// HEADER-ONLY: only the header strip is visible (its height varies with the
// title's line count, so bound it rather than pin it).
const settleAtHeader = (page: Page, nonce: string) =>
  settledInBand(page, 'room-sheet', VIEW.height - 170, VIEW.height - 60, nonce);

/** Mouse-drag the sheet handle by dy px (negative = up), paced for velocity. */
async function dragHandle(page: Page, dy: number) {
  const h = (await page.getByTestId('sheet-handle').boundingBox())!;
  const cx = h.x + h.width / 2;
  const cy = h.y + h.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cx, cy + (dy * i) / 8);
    // e2e-discipline: allow(16ms gesture pacing — this shapes the synthetic
    // drag's velocity, an input property; it does not wait on app state)
    await page.waitForTimeout(16);
  }
  // e2e-discipline: allow(150ms hold before release — zeroes the velocity
  // tracker so the snap is decided by position; a hold IS a duration)
  await page.waitForTimeout(150);
  await page.mouse.up();
}

async function openDendurSheet(page: Page) {
  await page.goto('/');
  await page.getByTestId('room-131').click();
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await settleAtHalf(page, 'open');
}

test('room tap opens the sheet at the HALF detent', async ({ page }) => {
  await openDendurSheet(page);
  expect(Math.abs((await sheetTop(page)) - (VIEW.height - HALF_VISIBLE))).toBeLessThan(TOL);
});

test('drag up → FULL; two drags down → HEADER-ONLY; map stays tappable', async ({ page }) => {
  await openDendurSheet(page);

  await dragHandle(page, -420);
  await settleAtFull(page, 'drag-1');

  await dragHandle(page, 380);
  await settleAtHalf(page, 'drag-2');

  await dragHandle(page, 350);
  await settleAtHeader(page, 'drag-3');

  // The map above the docked header must stay interactive: tapping another
  // room swaps the sheet content and resets it to HALF.
  await page.getByTestId('room-130').click();
  await expect(page.getByTestId('room-sheet')).toContainText('Gallery 130');
  await settleAtHalf(page, 'room-130');
});

test('handle tap cycles upward: half → full → header → half', async ({ page }) => {
  await openDendurSheet(page);
  await page.getByTestId('sheet-handle').click();
  await settleAtFull(page, 'cycle-full'); // half → full
  await page.getByTestId('sheet-handle').click();
  await settleAtHeader(page, 'cycle-header'); // full → header (wrap)
  await page.getByTestId('sheet-handle').click();
  await settleAtHalf(page, 'cycle-half'); // header → half
});

test('handle is a ≥44pt tap target and close still dismisses (HIG)', async ({ page }) => {
  await openDendurSheet(page);
  const h = (await page.getByTestId('sheet-handle').boundingBox())!;
  expect(h.height).toBeGreaterThanOrEqual(43.5);
  expect(h.width).toBeGreaterThanOrEqual(43.5);
  await page.getByTestId('room-sheet-close').click();
  await expect(page.getByTestId('room-sheet')).toHaveCount(0);
  // Bottom chrome (locate chip) returns once the sheet closes.
  await expect(page.getByTestId('locate-chip')).toBeVisible();
});
