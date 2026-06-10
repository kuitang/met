import { expect, test, type Page } from '@playwright/test';

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
 */

const FIRST_PAINT = { timeout: 45_000 };
const VIEW = { width: 390, height: 844 };
const HALF_VISIBLE = 340;
const FULL_TOP = 12; // FULL_TOP_GAP; insets.top === 0 on web

test.use({ viewport: VIEW });

const sheetTop = async (page: Page) => (await page.getByTestId('room-sheet').boundingBox())!.y;

/** Mouse-drag the sheet handle by dy px (negative = up), paced for velocity. */
async function dragHandle(page: Page, dy: number) {
  const h = (await page.getByTestId('sheet-handle').boundingBox())!;
  const cx = h.x + h.width / 2;
  const cy = h.y + h.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cx, cy + (dy * i) / 8);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150); // settle the velocity tracker → position decides
  await page.mouse.up();
  await page.waitForTimeout(800); // let the spring settle
}

async function openDendurSheet(page: Page) {
  await page.goto('/');
  await page.getByTestId('room-131').click(FIRST_PAINT);
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await page.waitForTimeout(800);
}

test('room tap opens the sheet at the HALF detent', async ({ page }) => {
  await openDendurSheet(page);
  expect(Math.abs((await sheetTop(page)) - (VIEW.height - HALF_VISIBLE))).toBeLessThan(3);
});

test('drag up → FULL; two drags down → HEADER-ONLY; map stays tappable', async ({ page }) => {
  await openDendurSheet(page);

  await dragHandle(page, -420);
  expect(Math.abs((await sheetTop(page)) - FULL_TOP)).toBeLessThan(3);

  await dragHandle(page, 380);
  expect(Math.abs((await sheetTop(page)) - (VIEW.height - HALF_VISIBLE))).toBeLessThan(3);

  await dragHandle(page, 350);
  // HEADER-ONLY: only the header strip is visible (its height varies with the
  // title's line count, so bound it rather than pin it).
  const headerVisible = VIEW.height - (await sheetTop(page));
  expect(headerVisible).toBeGreaterThan(60);
  expect(headerVisible).toBeLessThan(170);

  // The map above the docked header must stay interactive: tapping another
  // room swaps the sheet content and resets it to HALF.
  await page.getByTestId('room-130').click();
  await page.waitForTimeout(800);
  await expect(page.getByTestId('room-sheet')).toContainText('Gallery 130');
  expect(Math.abs((await sheetTop(page)) - (VIEW.height - HALF_VISIBLE))).toBeLessThan(3);
});

test('handle tap cycles upward: half → full → header → half', async ({ page }) => {
  await openDendurSheet(page);
  const tap = async () => {
    await page.getByTestId('sheet-handle').click();
    await page.waitForTimeout(700);
    return sheetTop(page);
  };
  expect(Math.abs((await tap()) - FULL_TOP)).toBeLessThan(3); // half → full
  const headerVisible = VIEW.height - (await tap()); // full → header (wrap)
  expect(headerVisible).toBeGreaterThan(60);
  expect(headerVisible).toBeLessThan(170);
  expect(Math.abs((await tap()) - (VIEW.height - HALF_VISIBLE))).toBeLessThan(3); // header → half
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
