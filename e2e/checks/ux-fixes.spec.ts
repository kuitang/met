import { expect, test, type Page } from '@playwright/test';

/**
 * Live-testing bug-fix regression suite (stub provider, like mockup.spec):
 *
 *  Bug 1 — amenity search (grammar updated by the gallery/amenity search
 *          row PR, superseding the PR #8 tap-routes-directly behavior):
 *          rows carry NO inline actions; tapping a row opens the amenity
 *          sheet on the home map, where DIRECTIONS and I'M HERE live —
 *          tapping never silently moves the visitor.
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
/* Bug 1 — amenity rows: one anatomy, one tap → dual-action sheet      */
/* ------------------------------------------------------------------ */

test('amenity tap opens the amenity sheet; DIRECTIONS routes from the anchor — location unchanged', async ({
  page,
}) => {
  await page.goto('/?room=131');
  await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
  await page.getByTestId('home-search-bar').click();
  await page.getByTestId('search-input').fill('bathroom'); // synonym still matches

  // Rows are ranked nearest-first by graph distance; the top row is the
  // nearest restroom. Rows carry NO inline buttons (one row anatomy).
  const rows = page.locator('[data-testid^="amenity-restroom-"]');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('[data-testid^="amenity-im-here-"]')).toHaveCount(0);
  const nearestId = (await rows.first().getAttribute('data-testid'))!.replace('amenity-', '');

  // One tap → home map with the amenity sheet open (thin variant: kind
  // glyph, name, floor, DIRECTIONS / I'M HERE).
  await rows.first().click();
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-amenity-glyph')).toContainText('WC');
  await page.getByTestId('room-directions').click();
  await expect(page).toHaveURL(new RegExp(`[?&]nav=131(:|%3A)${nearestId}`));
  await expect(page.getByTestId('route-summary')).toContainText('Restrooms');

  // The visitor was NOT teleported: exiting nav (✕ in the sheet header — nav
  // mode has no top chrome) still shows the Gallery 131 anchor.
  await page.getByTestId('nav-close').click();
  await expect(page.getByTestId('locate-chip').last()).toContainText('Gallery 131');
});

test("amenity sheet 'I'm here' is the explicit re-anchor action", async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('bathroom');
  await page.getByTestId('amenity-restroom-1').click();
  const imHere = page.getByTestId('room-im-here');
  await expect(imHere).toBeVisible();
  const box = (await imHere.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(43.5); // HIG tap target
  await imHere.click();
  await expect(page.getByTestId('room-sheet')).toHaveCount(0);
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
/* Zoom anchoring — every zoom path pivots on the VIEWPORT CENTER      */
/* ------------------------------------------------------------------ */
/*
 * Regression for the off-center pinch bug: the transform is translate(t)
 * then scale(s) about the view center C, and the old code changed s at
 * constant t — whose invariant point is C + t, the map point that was under
 * the center BEFORE any pan (measured drift = exactly the pan offset).
 * Fixed by t' = t·s'/s on every zoom path (pinch / wheel / buttons).
 *
 * Measurement (same style as the polyline scale-identity test above): track
 * a known room's bbox across the zoom; for a uniform scale k about a fixed
 * point F, x' = F + k(x − F) ⇒ F = (x' − k·x)/(1 − k). F must equal the
 * viewport center within 2px, at multiple off-center pans, both directions.
 */

/** Screen-space bbox of the Great Hall polygon. */
async function roomBox(page: Page) {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="room-great-hall"]')!
      .getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  });
}

/** Fixed point of the screen-space scale taking box a to box b. */
function zoomFixedPoint(a: { x: number; y: number; w: number }, b: typeof a) {
  const k = b.w / a.w;
  return { k, fx: (b.x - k * a.x) / (1 - k), fy: (b.y - k * a.y) / (1 - k) };
}

async function mapCenter(page: Page) {
  const bb = (await page.getByTestId('floor-map').boundingBox())!;
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}

async function panBy(page: Page, c: { x: number; y: number }, dx: number, dy: number) {
  const before = await roomBox(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 8 });
  await page.mouse.up();
  // Condition, not a pause: the room polygon actually moved with the drag.
  await expect
    .poll(async () => Math.abs((await roomBox(page)).x - before.x))
    .toBeGreaterThan(Math.abs(dx) / 2);
  // A drag that starts and ends inside the same room fires a DOM click on
  // release, opening the room sheet over the bottom band — dismiss it so it
  // cannot intercept the zoom controls / pinch fingers under test.
  if (await page.getByTestId('room-sheet').isVisible()) {
    await page.getByTestId('room-sheet-close').click();
    await expect(page.getByTestId('room-sheet')).toBeHidden();
  }
}

test('wheel zoom anchors the viewport center at off-center pans, both directions', async ({
  page,
}) => {
  for (const pan of [
    { dx: 120, dy: 150 },
    { dx: -130, dy: -100 },
  ]) {
    await page.goto('/');
    await expect(page.getByTestId('room-great-hall')).toBeVisible();
    const c = await mapCenter(page);
    await panBy(page, c, pan.dx, pan.dy);

    for (const deltaY of [-480, 300]) {
      const before = await roomBox(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.wheel(0, deltaY);
      const grew = deltaY < 0;
      await expect
        .poll(async () => {
          const k = (await roomBox(page)).w / before.w;
          return grew ? k : 1 / k;
        })
        .toBeGreaterThan(1.25);
      const { fx, fy } = zoomFixedPoint(before, await roomBox(page));
      expect(Math.abs(fx - c.x)).toBeLessThan(2);
      expect(Math.abs(fy - c.y)).toBeLessThan(2);
    }
  }
});

test.describe('two-finger pinch', () => {
  test.use({ hasTouch: true }); // CDP touch synthesis needs a touch-enabled context

test('pinch anchors the viewport center when panned off-center', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'CDP touch synthesis is chromium-only');
  await page.goto('/');
  await expect(page.getByTestId('room-great-hall')).toBeVisible();
  const c = await mapCenter(page);
  await panBy(page, c, 120, 150);

  const cdp = await page.context().newCDPSession(page);
  const pts = (gap: number) => [
    { x: c.x, y: c.y - gap / 2, id: 0 },
    { x: c.x, y: c.y + gap / 2, id: 1 },
  ];
  // Both directions: spread (zoom in), then squeeze (zoom out).
  for (const [startGap, endGap] of [
    [120, 300],
    [300, 140],
  ]) {
    const before = await roomBox(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(startGap) });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: pts(startGap + ((endGap - startGap) * i) / 10),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const grew = endGap > startGap;
    await expect
      .poll(async () => {
        const k = (await roomBox(page)).w / before.w;
        return grew ? k : 1 / k;
      })
      .toBeGreaterThan(1.3); // the pinch actually scaled
    const { fx, fy } = zoomFixedPoint(before, await roomBox(page));
    expect(Math.abs(fx - c.x)).toBeLessThan(2);
    expect(Math.abs(fy - c.y)).toBeLessThan(2);
  }
  await cdp.detach();
});
});

test('zoom buttons: 44pt targets, ~1.4× per tap, center-anchored, clamped at max', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('room-great-hall')).toBeVisible();
  const c = await mapCenter(page);
  await panBy(page, c, 100, 120); // off-center first — anchoring must still hold

  for (const id of ['zoom-in', 'zoom-out']) {
    const bb = (await page.getByTestId(id).boundingBox())!;
    expect(bb.width).toBeGreaterThanOrEqual(43.5);
    expect(bb.height).toBeGreaterThanOrEqual(43.5);
  }

  // + : spring-settles at ×1.4 (ζ≈1, no overshoot), fixed point = center.
  const before = await roomBox(page);
  await page.getByTestId('zoom-in').click();
  await expect.poll(async () => (await roomBox(page)).w / before.w).toBeGreaterThan(1.38);
  const zin = zoomFixedPoint(before, await roomBox(page));
  expect(zin.k).toBeLessThan(1.45);
  expect(Math.abs(zin.fx - c.x)).toBeLessThan(2);
  expect(Math.abs(zin.fy - c.y)).toBeLessThan(2);

  // − : back down by the same step, same anchor.
  const mid = await roomBox(page);
  await page.getByTestId('zoom-out').click();
  await expect.poll(async () => (await roomBox(page)).w / mid.w).toBeLessThan(0.73);
  const zout = zoomFixedPoint(mid, await roomBox(page));
  expect(Math.abs(zout.fx - c.x)).toBeLessThan(2);
  expect(Math.abs(zout.fy - c.y)).toBeLessThan(2);

  // Clamp: hammering + plateaus at the stub map's maxScale (4×).
  for (let i = 0; i < 6; i++) await page.getByTestId('zoom-in').click();
  await expect.poll(async () => (await roomBox(page)).w / before.w).toBeGreaterThan(3.9);
  expect((await roomBox(page)).w / before.w).toBeLessThan(4.1);
});

/* ------------------------------------------------------------------ */
/* Locate chip — hard horizontal limit, ellipsis, never edge-flush     */
/* ------------------------------------------------------------------ */

test.describe('locate chip at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('longest real gallery label truncates to one line with ≥16px right margin', async ({
    page,
  }) => {
    await page.goto('/?room=131');
    const chip = page.getByTestId('locate-chip');
    await expect(chip).toContainText('Gallery 131');
    const oneLine = (await chip.boundingBox())!.height;

    // The stub fixture has no long titles, so feed the chip's Text node the
    // longest REAL labels from met.sqlite (galleries: galleryNumber
    // "Exhibition Galleries 964 & 965"; amenities: "The Iris and B.Gerald
    // Cantor Roof Garden Bar"). The CSS contract under test (nowrap +
    // ellipsis + margin cap) is what real data exercises in production.
    for (const label of [
      'Gallery Exhibition Galleries 964 & 965 · Floor G',
      'The Iris and B.Gerald Cantor Roof Garden Bar · Floor 5',
    ]) {
      const m = await page.evaluate((text) => {
        const el = document.querySelector('[data-testid="locate-chip"]')!;
        const t = el.querySelector('div') as HTMLElement;
        t.textContent = text;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(t);
        return {
          right: r.right,
          h: r.height,
          winW: window.innerWidth,
          whiteSpace: cs.whiteSpace,
          textOverflow: cs.textOverflow,
          truncated: t.scrollWidth > t.clientWidth + 1,
        };
      }, label);
      expect(m.winW - m.right).toBeGreaterThanOrEqual(16); // breathing margin
      expect(m.h).toBeLessThanOrEqual(oneLine + 1); // never wraps
      expect(m.whiteSpace).toBe('nowrap');
      expect(m.textOverflow).toBe('ellipsis');
      expect(m.truncated).toBe(true); // the long title actually ellipsized
    }
  });
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
  await expect(page).toHaveURL(/[?&]nav=131(:|%3A)822/);

  // Nav mode owns the screen (no header chrome): the ≥44pt ✕ in the nav
  // sheet header is the single-tap exit back to browsing.
  const closeBtn = page.getByTestId('nav-close').last();
  const box = (await closeBtn.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  await closeBtn.click();

  await expect(page.getByTestId('home-search-bar').last()).toBeVisible();
  await expect(page.getByTestId('locate-chip').last()).toContainText('Gallery 131'); // anchor survived
});

test('HOME button is present on search, results, object, and locate too', async ({ page }) => {
  for (const route of ['/search', '/results?q=Monet', '/object/436535', '/locate']) {
    await page.goto(route);
    await expect(page.getByTestId('home-button').last()).toBeVisible();
  }
});
