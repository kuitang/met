import { expect, test, type Page } from '@playwright/test';

import { settledInBand } from '../helpers/settle';

/**
 * Nav mode (variant D — "the map IS the app"): navigation renders as the HOME
 * screen in a modal nav mode (`/?nav=<from>:<to>`), not a separate screen.
 *  - entering hides the top chrome (wordmark + search bar) and bottom chrome
 *    (locate chip); the NavSheet teardown owns the bottom band;
 *  - the sheet runs on the SAME DetentSheet machinery as the room sheet:
 *    FULL / HALF / HEADER-ONLY drag + handle-tap cycle (user-confirmed
 *    requirement);
 *  - ✕ exits in place; browser back exits the pushed nav entry;
 *  - the sheet's top border is a route progress bar; I'M HERE advances it;
 *  - cross-floor steps auto-switch the visible floor; the polyline draws
 *    off-floor segments dimmed;
 *  - retarget via the header title → search → room row swaps the target;
 *  - arrival hands off to the destination's artifacts teardown (WHAT'S HERE).
 */

const VIEW = { width: 390, height: 844 };
const HALF_VISIBLE = 340;
const FULL_TOP = 12; // FULL_TOP_GAP; insets.top === 0 on web
const TOL = 3;

test.use({ viewport: VIEW });

/** `?nav=from:to` — expo-router may percent-encode the separator. */
const navURL = (from: string, to: string) => new RegExp(`[?&]nav=${from}(:|%3A)${to}`);

const settleAtHalf = (page: Page, nonce: string) =>
  settledInBand(
    page,
    'nav-sheet',
    VIEW.height - HALF_VISIBLE - TOL,
    VIEW.height - HALF_VISIBLE + TOL,
    nonce,
  );
const settleAtFull = (page: Page, nonce: string) =>
  settledInBand(page, 'nav-sheet', FULL_TOP - TOL, FULL_TOP + TOL, nonce);
const settleAtHeader = (page: Page, nonce: string) =>
  settledInBand(page, 'nav-sheet', VIEW.height - 190, VIEW.height - 60, nonce);

/** Mouse-drag the nav-sheet handle by dy px (same idiom as sheet-detents). */
async function dragHandle(page: Page, dy: number) {
  const h = (await page.getByTestId('nav-sheet-handle').boundingBox())!;
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

test('deep link enters nav mode: chrome gone, ✕ restores it in place', async ({ page }) => {
  // /route/* keeps working as a redirect into home-nav-mode.
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('nav-sheet')).toBeVisible();
  await expect(page).toHaveURL(navURL('great-hall', '822'));
  await expect(page.getByTestId('route-summary')).toContainText('Van Gogh');

  // MODAL: the top chrome (search bar) and the locate chip are gone — the
  // map + the nav sheet are the whole app (single history entry here, so no
  // background home screen can shadow these counts).
  await expect(page.getByTestId('home-search-bar')).toHaveCount(0);
  await expect(page.getByTestId('locate-chip')).toHaveCount(0);
  // Floor chips stay — they are map controls.
  await expect(page.getByTestId('floor-chip-1')).toBeVisible();

  // ✕ exits in place: browse chrome returns.
  await page.getByTestId('nav-close').click();
  await expect(page.getByTestId('nav-sheet')).toHaveCount(0);
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
  await expect(page.getByTestId('locate-chip')).toBeVisible();
});

test('room sheet DIRECTIONS pushes nav mode; browser back exits it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('room-131').click();
  await page.getByTestId('room-directions').click();
  await expect(page).toHaveURL(navURL('great-hall', '131'));
  await expect(page.getByTestId('nav-sheet').last()).toBeVisible();

  // Back = exit nav mode (modal semantics): pops to the plain home entry.
  await page.goBack();
  await expect(page.getByTestId('nav-sheet')).toHaveCount(0);
  await expect(page.getByTestId('home-search-bar').last()).toBeVisible();
});

test('nav sheet runs the identical three-detent drag machinery', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('nav-sheet')).toBeVisible();
  await settleAtHalf(page, 'open');

  await dragHandle(page, -420);
  await settleAtFull(page, 'drag-full');
  // +300 (not the midpoint-grazing +380): release velocity projection must
  // not carry the snap past HALF into HEADER (observed flake at +380).
  await dragHandle(page, 300);
  await settleAtHalf(page, 'drag-half');
  await dragHandle(page, 350);
  await settleAtHeader(page, 'drag-header');

  // HEADER-ONLY keeps destination + step counter + ✕ on screen (max-map nav).
  await expect(page.getByTestId('route-summary')).toContainText('Step 1 of');
  await expect(page.getByTestId('nav-close')).toBeVisible();
});

test('handle tap cycles upward, wrapping — same a11y affordance as the room sheet', async ({
  page,
}) => {
  // Pure click-cycles, never right after a drag: DetentSheet swallows clicks
  // within 300ms of a pan end (web ghost-click guard), so a drag-then-tap
  // sequence is inherently racy — and not what the cycle affordance is for.
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('nav-sheet')).toBeVisible();
  await settleAtHalf(page, 'open');
  await page.getByTestId('nav-sheet-handle').click();
  await settleAtFull(page, 'cycle-full'); // half → full
  await page.getByTestId('nav-sheet-handle').click();
  await settleAtHeader(page, 'cycle-header'); // full → header (wrap)
  await page.getByTestId('nav-sheet-handle').click();
  await settleAtHalf(page, 'cycle-half'); // header → half
});

test('I\'M HERE advances progress; cross-floor step auto-switches the floor', async ({
  page,
}) => {
  await page.goto('/route/great-hall/822'); // floor 1 → floor 2 in the stub
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');

  // Off-floor (floor 2) segment renders dimmed alongside the solid floor-1 run.
  expect(
    await page.locator('[data-testid="route-polyline"] polyline').count(),
  ).toBeGreaterThanOrEqual(2);

  const progressW = async () =>
    (await page.getByTestId('nav-progress').boundingBox())?.width ?? 0;
  const before = await progressW();
  await page.getByTestId('im-here').click();
  await expect(page.getByTestId('route-summary')).toContainText('Step 2 of');
  expect(await progressW()).toBeGreaterThan(before); // top-border progress fill

  // Walk the rest: the elevator/stairs step must flip the map to floor 2
  // (target marker only renders on the destination's visible floor).
  for (let i = 0; i < 12; i++) {
    if ((await page.getByTestId('route-arrived').count()) > 0) break;
    await page.getByTestId('im-here').click();
  }
  await expect(page.getByTestId('route-arrived')).toBeVisible();
  await expect(page.getByTestId('marker-target')).toBeVisible();
});

test('retarget: header title opens search; a room row swaps the target in place', async ({
  page,
}) => {
  await page.goto('/route/great-hall/131');
  await expect(page.getByTestId('route-summary')).toContainText('Temple of Dendur');

  await page.getByTestId('route-summary').click(); // title block = retarget
  await page.getByTestId('search-input').fill('822');
  await page.getByTestId('gallery-822').click();

  // Same nav session, new destination — still no browse chrome.
  await expect(page.getByTestId('route-summary')).toContainText('Van Gogh');
  await expect(page).toHaveURL(navURL('great-hall', '822'));
  await expect(page.getByTestId('home-search-bar')).toHaveCount(0);
});

test("arrival: WHAT'S HERE hands off to the destination's artifacts teardown", async ({
  page,
}) => {
  await page.goto('/route/great-hall/131');
  for (let i = 0; i < 12; i++) {
    if ((await page.getByTestId('route-arrived').count()) > 0) break;
    await page.getByTestId('im-here').click();
  }
  await expect(page.getByTestId('route-arrived')).toContainText("You've arrived");

  await page.getByTestId('arrived-whats-here').click();
  // Nav exits; the destination's room sheet (artifacts teardown) opens,
  // anchored at the destination.
  await expect(page.getByTestId('nav-sheet')).toHaveCount(0);
  await expect(page.getByTestId('room-sheet')).toContainText('Temple of Dendur');
  await page.getByTestId('room-sheet-close').click();
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
});

test('cross-venue target: honest no-route notice with a one-tap exit', async ({ page }) => {
  await page.goto('/?nav=great-hall:nowhere');
  await expect(page.getByTestId('route-not-found')).toContainText('No route found');
  await page.getByTestId('nav-close').click();
  await expect(page.getByTestId('route-not-found')).toHaveCount(0);
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
});
