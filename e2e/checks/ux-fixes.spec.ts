import { expect, test, type Page } from '@playwright/test';

/**
 * Live-testing bug-fix regression suite (stub provider, like mockup.spec):
 *
 *  Bug 1 — amenity search: tapping a result offers DIRECTIONS (nearest-first
 *          ranking already orders the rows); "I'm here" is the explicit
 *          secondary action — tapping never silently moves the visitor.
 *  Bug 2 — room sheet: both DIRECTIONS and I'M HERE, ≥44pt.
 *  Bug 3 — current location (HOME glyph, blue) vs target (STAR glyph, Met
 *          red) markers + floor-chip bubbles. Shapes, not red/green, carry
 *          the distinction (colorblind-safe).
 *  Bug 4 — RoutePolyline renders inside FloorMap's pan/zoom transform: the
 *          path stays anchored to the floor plan in every gesture state
 *          (transform-consistency assertion below).
 *  Bug 5 — persistent HOME header button: one tap from a 3-deep stack lands
 *          on the home map with the anchor intact.
 */

const HOME_BLUE = '#1B6CA8';
const MET_RED = '#e4002b';

/* ------------------------------------------------------------------ */
/* Bug 1 — amenity search offers directions                            */
/* ------------------------------------------------------------------ */

test('amenity tap routes to that amenity from the anchor — location unchanged', async ({
  page,
}) => {
  await page.goto('/?room=131');
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
  await page.getByTestId('home-search-bar').click();
  await page.getByTestId('search-input').fill('bathroom'); // synonym still matches

  // Rows are ranked nearest-first by graph distance; the top row is the
  // nearest restroom, and tapping it asks for DIRECTIONS to exactly that row.
  const rows = page.locator('[data-testid^="amenity-restroom-"]');
  await expect(rows.first()).toBeVisible();
  const nearestId = (await rows.first().getAttribute('data-testid'))!.replace('amenity-', '');
  await rows.first().click();
  await expect(page).toHaveURL(new RegExp(`/route/131/${nearestId}`));
  await expect(page.getByTestId('route-summary')).toContainText('Restrooms');

  // The visitor was NOT teleported: home still shows the Gallery 131 anchor.
  await page.getByTestId('home-button').last().click();
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
});

test("amenity 'I'm here' is the explicit secondary re-anchor action", async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('bathroom');
  const imHere = page.getByTestId('amenity-im-here-restroom-1');
  await expect(imHere).toBeVisible();
  const box = (await imHere.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5); // HIG tap target
  await imHere.click();
  await expect(page.getByTestId('locate-chip')).toContainText('Restrooms');
});

/* ------------------------------------------------------------------ */
/* Bug 2 — room sheet dual actions                                     */
/* ------------------------------------------------------------------ */

test("room sheet: equal-weight Directions and I'm-here, both ≥44pt", async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('room-131').click();
  await expect(page.getByTestId('room-sheet')).toBeVisible();

  const directions = page.getByTestId('room-directions');
  const imHere = page.getByTestId('room-im-here');
  await expect(directions).toBeVisible();
  await expect(imHere).toBeVisible();
  const dBox = (await directions.boundingBox())!;
  const iBox = (await imHere.boundingBox())!;
  for (const b of [dBox, iBox]) {
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.width).toBeGreaterThanOrEqual(43.5);
  }
  // Equal weight: same size, side by side.
  expect(Math.abs(dBox.width - iBox.width)).toBeLessThan(10);
  expect(Math.abs(dBox.height - iBox.height)).toBeLessThan(2);

  // I'M HERE re-anchors to this room and closes the sheet.
  await imHere.click();
  await expect(page.getByTestId('room-sheet')).toHaveCount(0);
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
  await expect(page.getByTestId('marker-home')).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* Bug 3 — home/star markers + floor-chip bubbles                      */
/* ------------------------------------------------------------------ */

test('home map shows the blue HOME glyph at the anchor + chip bubble', async ({ page }) => {
  await page.goto('/?room=131');
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
  const home = page.getByTestId('marker-home');
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute('fill', HOME_BLUE); // never red/green pairing
  await expect(page.getByTestId('chip-badge-home-1')).toBeVisible();
});

test('route view: home vs star markers and cross-floor chip bubbles', async ({ page }) => {
  // 131 (floor 1) → 822 (floor 2): a cross-floor route.
  await page.goto('/route/131/822');
  await expect(page.getByTestId('route-summary')).toBeVisible();

  // Floor 1 active: current location renders as the blue HOME glyph; the
  // target is on floor 2, so its chip carries the star bubble at a glance.
  await expect(page.getByTestId('marker-home')).toBeVisible();
  await expect(page.getByTestId('marker-home')).toHaveAttribute('fill', HOME_BLUE);
  await expect(page.getByTestId('marker-target')).toHaveCount(0);
  await expect(page.getByTestId('chip-badge-home-1')).toBeVisible();
  await expect(page.getByTestId('chip-badge-target-2')).toBeVisible();

  // Switch to floor 2: the Met-red STAR target marker appears.
  await page.getByTestId('floor-chip-2').click();
  await expect(page.getByTestId('marker-target')).toBeVisible();
  await expect(page.getByTestId('marker-target')).toHaveAttribute('fill', MET_RED);
});

/* ------------------------------------------------------------------ */
/* Bug 4 — polyline anchored under pan/zoom                            */
/* ------------------------------------------------------------------ */

/** Screen-space geometry of a known room polygon vs the route polyline. */
function measureOverlay(page: Page) {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="room-great-hall"]')!
      .getBoundingClientRect();
    const p = document
      .querySelector('[data-testid="route-polyline"]')!
      .getBoundingClientRect();
    return {
      rx: r.x,
      rw: r.width,
      pw: p.width,
      // Center-to-center offset: must scale with zoom and survive pans.
      dcx: p.x + p.width / 2 - (r.x + r.width / 2),
      dcy: p.y + p.height / 2 - (r.y + r.height / 2),
    };
  });
}

test('route polyline pans and zooms WITH the floor plan', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('route-summary')).toBeVisible();
  await expect(page.getByTestId('route-polyline')).toBeVisible();

  const before = await measureOverlay(page);

  // --- zoom (desktop wheel path) -------------------------------------
  const map = page.getByTestId('floor-map');
  const bb = (await map.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.wheel(0, -480);
  // Condition, not a pause: poll until the room polygon has actually scaled.
  await expect
    .poll(async () => (await measureOverlay(page)).rw / before.rw)
    .toBeGreaterThan(1.5);

  const zoomed = await measureOverlay(page);
  const k = zoomed.rw / before.rw;

  // Transform consistency: the polyline scaled exactly with the room
  // polygon, and its offset from the room scaled by the same factor.
  expect(Math.abs(zoomed.pw / before.pw - k)).toBeLessThan(0.1 * k);
  const dist = Math.hypot(before.dcx, before.dcy);
  const zDist = Math.hypot(zoomed.dcx, zoomed.dcy);
  expect(Math.abs(zDist / dist - k)).toBeLessThan(0.1 * k);

  // --- pan (drag) ------------------------------------------------------
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + 80, bb.y + bb.height / 2 + 50, { steps: 8 });
  await page.mouse.up();
  // Condition, not a pause: poll until the map has actually moved.
  await expect
    .poll(async () => (await measureOverlay(page)).rx - zoomed.rx)
    .toBeGreaterThan(40);

  const panned = await measureOverlay(page);
  // …and the polyline stayed glued to it (relative offset unchanged).
  expect(Math.abs(panned.dcx - zoomed.dcx)).toBeLessThan(2);
  expect(Math.abs(panned.dcy - zoomed.dcy)).toBeLessThan(2);
});

/* ------------------------------------------------------------------ */
/* Bug 5 — one-tap return home                                         */
/* ------------------------------------------------------------------ */

test('HOME button: one tap from a 3-deep stack, anchor intact', async ({ page }) => {
  await page.goto('/?room=131');
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');

  // search → object → route: a 3-deep stack.
  await page.getByTestId('home-search-bar').click();
  await page.getByTestId('search-input').fill('Monet');
  await page.getByTestId('suggestion-438008').click();
  await expect(page.getByTestId('object-title')).toContainText('Water Lilies');
  await page.getByTestId('navigate-here').click();
  // Origin honesty: the route starts from the live anchor, not the Great Hall.
  await expect(page).toHaveURL(/\/route\/131\/822/);

  // Every non-home screen carries the ≥44pt house-glyph header button; the
  // top-most (route) one is a single tap home.
  const homeBtn = page.getByTestId('home-button').last();
  const box = (await homeBtn.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  await homeBtn.click();

  await expect(page.getByTestId('home-search-bar')).toBeVisible();
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131'); // anchor survived
});

test('HOME button is present on search, results, object, and locate too', async ({ page }) => {
  for (const route of ['/search', '/results?q=Monet', '/object/436535', '/locate']) {
    await page.goto(route);
    await expect(page.getByTestId('home-button').last()).toBeVisible();
  }
});
