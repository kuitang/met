import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gate A mockup smoke — every screen renders and the core interactions work,
 * all against StubDataProvider (apps/mobile/src/data/stub.json).
 *
 * The final describe block also regenerates the Gate A review screenshots in
 * docs/mockup/*.png (390x844). Run:
 *   lsof -ti:8081 | xargs -r kill && npx playwright test --project=checks
 */

// First navigation may trigger the dev-server bundle build; be generous once.
const FIRST_PAINT = { timeout: 45_000 };

test('home renders map shell, search bar, and locate chip', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible(FIRST_PAINT);
  await expect(page.getByTestId('floor-map')).toBeVisible();
  await expect(page.getByTestId('home-search-bar')).toBeVisible();
  await expect(page.getByTestId('locate-chip')).toBeVisible();
  // Floor chips 1/2 are interactive; G is a disabled placeholder.
  await expect(page.getByTestId('floor-chip-1')).toBeVisible();
  await expect(page.getByTestId('floor-chip-2')).toBeVisible();
});

test('home room tap opens the room sheet with directions', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('room-131').click(FIRST_PAINT);
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await expect(page.getByTestId('room-sheet')).toContainText('Temple of Dendur');
  await page.getByTestId('room-directions').click();
  await expect(page).toHaveURL(/\/route\/great-hall\/131/);
});

test('search "Monet" shows suggestion rows with gallery chips', async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('Monet', FIRST_PAINT);
  // Water Lilies hangs in Gallery 822, which is on the stub map → full chip.
  const waterLilies = page.getByTestId('suggestion-438008');
  await expect(waterLilies).toBeVisible();
  await expect(waterLilies).toContainText('Water Lilies');
  await expect(waterLilies).toContainText('Gallery 822 · F2');
  // Garden at Sainte-Adresse: real gallery (818) not drawn in the stub map →
  // number-only chip.
  const sainteAdresse = page.getByTestId('suggestion-437133');
  await expect(sainteAdresse).toContainText('Gallery 818');
  await expect(page.getByTestId('all-results-link')).toBeVisible();
});

test('search amenity intent surfaces restrooms', async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('restroom', FIRST_PAINT);
  await expect(page.getByTestId('amenity-restroom-1')).toBeVisible();
  await expect(page.getByTestId('amenity-restroom-2')).toBeVisible();
});

test('weak query offers Ask differently → interpreted results', async ({ page }) => {
  await page.goto('/search');
  await page
    .getByTestId('search-input')
    .fill('that huge painting of washington crossing a river in a boat', FIRST_PAINT);
  await page.getByTestId('ask-differently').click();
  await expect(page.getByTestId('interpreted-banner')).toBeVisible();
  // Washington Crossing the Delaware must rank first (planning-bench golden).
  await expect(page.getByTestId('result-11417')).toBeVisible();
});

test('results page renders rows and all filter chips', async ({ page }) => {
  await page.goto('/results?q=Monet');
  await expect(page.getByTestId('result-438008')).toBeVisible(FIRST_PAINT);
  for (const chip of [
    'filter-floor-1',
    'filter-floor-2',
    'filter-site-fifth',
    'filter-site-cloisters',
    'filter-rotation-permanent',
    'filter-rotation-exhibition',
    'filter-has-image',
  ]) {
    await expect(page.getByTestId(chip)).toBeVisible();
  }
  // Floor filter actually filters: Monets are F2 (822) or unmapped (818).
  await page.getByTestId('filter-floor-1').click();
  await expect(page.getByTestId('result-438008')).toHaveCount(0);
  await page.getByTestId('filter-floor-1').click();
  await expect(page.getByTestId('result-438008')).toBeVisible();
});

test('object page renders synopsis card with Navigate here', async ({ page }) => {
  await page.goto('/object/436535');
  await expect(page.getByTestId('object-title')).toContainText(
    'Wheat Field with Cypresses',
    FIRST_PAINT,
  );
  await expect(page.getByTestId('object-image')).toBeVisible();
  await expect(page.getByTestId('object-gallery-chip')).toContainText('GALLERY 822');
  await expect(page.getByTestId('object-position')).toContainText('in Gallery 822');
  await expect(page.getByTestId('object-met-link')).toBeVisible();
  await page.getByTestId('navigate-here').click();
  await expect(page).toHaveURL(/\/route\/great-hall\/822/);
});

test('object page next/prev cycles within the gallery (J15)', async ({ page }) => {
  await page.goto('/object/436535');
  const position = page.getByTestId('object-position');
  await expect(position).toContainText('in Gallery 822', FIRST_PAINT);
  const before = await position.textContent();
  await page.getByTestId('object-next').click();
  await expect(position).not.toHaveText(before!);
  await page.getByTestId('object-prev').click();
  await expect(position).toHaveText(before!);
});

test('route view renders steps; I\'m-here advances to arrival', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('route-summary')).toContainText(
    'Great Hall',
    FIRST_PAINT,
  );
  await expect(page.getByTestId('route-step-0')).toBeVisible();
  await expect(page.getByTestId('avoid-stairs')).toBeVisible();
  await expect(page.getByTestId('route-polyline')).toBeVisible();

  // Checkpoint-advance through every step; the stub route is ≤ 12 steps.
  // Pause between taps: each advance animates the step-card scroll, and the
  // list's onScroll sync would round a mid-animation offset back down.
  for (let i = 0; i < 12; i++) {
    const imHere = page.getByTestId('im-here');
    if (!(await imHere.isVisible())) break;
    await imHere.click();
    await page.waitForTimeout(500);
  }
  await expect(page.getByTestId('route-arrived')).toBeVisible();
  await expect(page.getByTestId('arrived-whats-here')).toBeVisible();
});

test('avoid-stairs toggle reroutes via the elevator', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('route-summary')).toBeVisible(FIRST_PAINT);
  await page.getByTestId('avoid-stairs').click();

  // Walk every step card (the horizontal list virtualizes, so visit them via
  // the checkpoint button) and collect the instructions: the elevator must
  // appear and stairs must never.
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const card = page.getByTestId(`route-step-${i}`);
    await expect(card).toBeVisible();
    seen.push((await card.textContent()) ?? '');
    const imHere = page.getByTestId('im-here');
    if (!(await imHere.isVisible())) break;
    await imHere.click();
    await page.waitForTimeout(500); // let the card scroll settle (see above)
  }
  const all = seen.join(' ').toLowerCase();
  expect(all).toContain('elevator');
  expect(all).not.toContain('stair');
});

/**
 * Locate sheet — single display: GPS resolves first (wing-level stub anchor),
 * one text box with LOCATE ROOM / LOCATE ARTIFACT overrides, photo flow as a
 * compact secondary action. Geolocation is emulated at the Met's entrance so
 * the stub GPS fix resolves.
 */
test.describe('locate sheet', () => {
  test.use({ geolocation: { latitude: 40.7794, longitude: -73.9632 } });

  test('GPS resolves first to a wing-level anchor; all controls render', async ({ page }) => {
    await page.goto('/locate');
    await expect(page.getByTestId('gps-status')).toBeVisible(FIRST_PAINT);
    await expect(page.getByTestId('gps-status')).toContainText('Near Great Hall · Floor 1');
    await expect(page.getByTestId('locate-input')).toBeVisible();
    await expect(page.getByTestId('locate-room-btn')).toBeVisible();
    await expect(page.getByTestId('locate-artifact-btn')).toBeVisible();
    await expect(page.getByTestId('locate-photo-btn')).toBeVisible();
  });

  test('locate by gallery number anchors the home map', async ({ page }) => {
    await page.goto('/locate');
    await page.getByTestId('locate-input').fill('131', FIRST_PAINT);
    await page.getByTestId('locate-room-btn').click();
    await expect(page.getByTestId('locate-chip')).toContainText('Gallery 131');
  });

  test('locate by artifact name anchors to its gallery', async ({ page }) => {
    await page.goto('/locate');
    await page.getByTestId('locate-input').fill('Wheat Field', FIRST_PAINT);
    await page.getByTestId('locate-artifact-btn').click();
    await expect(page.getByTestId('locate-chip')).toContainText('Gallery 822');
  });

  test('invalid gallery number shows an inline error', async ({ page }) => {
    await page.goto('/locate');
    await page.getByTestId('locate-input').fill('9999', FIRST_PAINT);
    await page.getByTestId('locate-room-btn').click();
    await expect(page.getByTestId('locate-error')).toContainText('9999');
  });
});

/**
 * Gate A review screenshots → docs/mockup/*.png (phone-sized).
 * Serial inside this describe so files land deterministically.
 */
test.describe('gate A screenshots', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    // Entrance fix so the locate capture shows the resolved GPS state.
    geolocation: { latitude: 40.7794, longitude: -73.9632 },
  });

  const outDir = path.resolve(__dirname, '../../docs/mockup');

  const shoot = async (page: Page, name: string) => {
    fs.mkdirSync(outDir, { recursive: true });
    // Hide Expo dev-server chrome: the #error-toast LogBox (it only reports
    // dev-mode react-native-svg responder-prop warnings; the production
    // export's console is clean) and the fast-refresh lightning indicator.
    await page.addStyleTag({
      content:
        'body > div:not(#root), .__expo_fast_refresh { display: none !important; }',
    });
    await page.waitForTimeout(400); // let images/SVG settle
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  };

  test('capture home', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('floor-map')).toBeVisible(FIRST_PAINT);
    await shoot(page, 'home');
  });

  test('capture search', async ({ page }) => {
    await page.goto('/search');
    await page.getByTestId('search-input').fill('Monet', FIRST_PAINT);
    await expect(page.getByTestId('suggestion-438008')).toBeVisible();
    await shoot(page, 'search');
  });

  test('capture results', async ({ page }) => {
    await page.goto('/results?q=gold'); // multi-row, multi-floor result set
    await expect(page.getByTestId('app-root')).toContainText('results', FIRST_PAINT);
    await shoot(page, 'results');
  });

  test('capture object', async ({ page }) => {
    await page.goto('/object/436535');
    await expect(page.getByTestId('object-title')).toBeVisible(FIRST_PAINT);
    // Wait for the Met CDN hero image so the screenshot isn't a grey box.
    await page
      .waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>(
          '[data-testid="object-image"]',
        );
        return !!img && img.naturalWidth > 0;
      }, undefined, { timeout: 15_000 })
      .catch(() => {}); // CDN hiccup → still capture the card
    await shoot(page, 'object');
  });

  test('capture route', async ({ page }) => {
    await page.goto('/route/great-hall/822');
    await expect(page.getByTestId('route-step-0')).toBeVisible(FIRST_PAINT);
    await shoot(page, 'route');
  });

  test('capture locate', async ({ page }) => {
    await page.goto('/locate');
    await expect(page.getByTestId('locate-input')).toBeVisible(FIRST_PAINT);
    await expect(page.getByTestId('gps-status')).toContainText('Near Great Hall');
    await shoot(page, 'locate');
  });
});
