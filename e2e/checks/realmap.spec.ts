import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Real map rendering — Living Map gallery polygons out of met.sqlite.
 *
 * Boot recipe: the standard checks webServer (Expo web on :8081). The real
 * geometry reaches FloorMap through the provider contract
 *   galleriesGeometry(site, floor)  (see apps/mobile/src/components/MapGeometry.ts)
 * Until the real DataProvider is wired in, this spec injects the exact
 * blobs['galleries.geojson'] payload from data/met.sqlite at
 * globalThis.__MET_GEOMETRY__ (FloorMap's documented web test seam, consulted
 * only when the provider lacks galleriesGeometry). When the real provider
 * lands, the injection becomes a no-op and the same assertions run against it.
 */

const DB_PATH = path.resolve(__dirname, '../../data/met.sqlite');

function loadGeometryJson(): string {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM blobs WHERE key = 'galleries.geojson'")
      .get() as { value: Buffer };
    return zlib.gunzipSync(row.value).toString('utf8');
  } finally {
    db.close();
  }
}

const geometryJson = loadGeometryJson();

// First navigation may trigger the dev-server bundle build; be generous once.
const FIRST_PAINT = { timeout: 45_000 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(`globalThis.__MET_GEOMETRY__ = ${geometryJson};`);
  await page.goto('/');
  await expect(page.getByTestId('floor-map-real')).toBeVisible(FIRST_PAINT);
});

test('floor 1 renders >100 real gallery polygons', async ({ page }) => {
  const rooms = page.locator('[data-testid^="room-"]');
  await expect(rooms.first()).toBeVisible();
  const count = await rooms.count();
  expect(count).toBeGreaterThan(100); // Fifth Ave floor 1 has ~204 galleries
  // Real polygons are <path>, not the stub's <rect>.
  expect(await page.locator('path[data-testid^="room-"]').count()).toBe(count);
});

test('tapping gallery 131 opens its room sheet', async ({ page }) => {
  const g131 = page.getByTestId('room-131');
  // Gallery 131 is flagged closed in the snapshot → hatched fill via pattern.
  await expect(g131).toHaveAttribute('fill', /url\(/);
  await g131.click();
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await expect(page.getByTestId('room-sheet')).toContainText('Temple of Dendur');
});

test('floor switch to 2 renders floor-2 galleries (with timing)', async ({ page }) => {
  await expect(page.getByTestId('room-131')).toBeVisible();
  // Data-driven chips: every Fifth Ave floor with galleries is present.
  for (const label of ['G', '1', '1M', '2', '3']) {
    await expect(page.getByTestId(`floor-chip-${label}`)).toBeVisible();
  }
  const t0 = Date.now();
  await page.getByTestId('floor-chip-2').click();
  await expect(page.getByTestId('room-131')).toHaveCount(0);
  const rooms = page.locator('[data-testid^="room-"]');
  await expect(rooms.first()).toBeVisible();
  const elapsed = Date.now() - t0;
  const count = await rooms.count();
  console.log(`[realmap] floor 1→2 switch: ${elapsed} ms, ${count} gallery polygons`);
  expect(count).toBeGreaterThan(150); // floor 2 has ~210 galleries
  expect(elapsed).toBeLessThan(5_000);
});

test('venue switch via the locate sheet renders Cloisters floors and rooms', async ({ page }) => {
  // Venue is location state, not map chrome: no site chips on the map.
  await expect(page.getByTestId('site-chip-cloisters')).toHaveCount(0);
  // The home chip's second line shows the current venue.
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('Fifth Avenue');

  // Switch venue through the locate sheet's segmented VENUE row.
  await page.getByTestId('locate-chip').click();
  await expect(page.getByTestId('venue-cloisters')).toBeVisible();
  await page.getByTestId('venue-cloisters').click();
  await page.goBack(); // modal sheet → home (client-side, store state survives)

  await expect(page.getByTestId('locate-chip-venue')).toHaveText('The Cloisters');
  const rooms = page.locator('[data-testid^="room-"]');
  await expect(rooms.first()).toBeVisible();
  const count = await rooms.count();
  expect(count).toBeGreaterThan(5); // Cloisters floor 1 has 12 galleries
  expect(count).toBeLessThan(100); // …and definitely not the Fifth Ave set
  // Cloisters floors are G and 1 only — chips follow the data.
  await expect(page.getByTestId('floor-chip-G')).toBeVisible();
  await expect(page.getByTestId('floor-chip-1')).toBeVisible();
  await expect(page.getByTestId('floor-chip-1M')).toHaveCount(0);
  // A manual venue pick is the user's own action — no auto-switch toast.
  await expect(page.getByTestId('venue-toast')).toHaveCount(0);

  // And back.
  await page.getByTestId('locate-chip').click();
  await page.getByTestId('venue-fifthAve').click();
  await page.goBack();
  await expect(page.getByTestId('locate-chip-venue')).toHaveText('Fifth Avenue');
  await expect(page.getByTestId('room-131')).toBeVisible();
});

test('initial real-map render performance', async ({ page }) => {
  // Re-navigate with timing instrumentation: measure from navigation start to
  // the first painted gallery path, and count rendered SVG path elements.
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.locator('[data-testid^="room-"]').first()).toBeVisible(FIRST_PAINT);
  const elapsed = Date.now() - t0;
  const paths = await page.locator('svg path').count();
  console.log(`[realmap] cold home render: ${elapsed} ms, ${paths} svg paths on floor 1`);
  expect(paths).toBeGreaterThan(200); // galleries + corridors + amenities + outline
});
