import { expect, test, type Page } from '@playwright/test';
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

// Snapshot-driven fixtures (closed flags move with the Met's nightly feed):
// pick an OPEN gallery, an OPEN named place, and floor 5's closed pair from
// the same geojson the app renders, instead of hard-coding ids.
interface GeoFeature {
  properties: {
    geomId: number;
    galleryNumber: string | null;
    name: string | null;
    title: string | null;
    type: string;
    floor: number;
    site: string;
    closed: boolean;
  };
}
const features = (JSON.parse(geometryJson) as { features: GeoFeature[] }).features.filter(
  (f) => f.properties.site === 'fifthAve',
);
const PLACE_TYPES = new Set([
  'toilet',
  'restaurant',
  'cafe',
  'bar',
  'shop',
  'cloakroom',
  'tickets',
  'auditorium',
  'library',
  'classroom',
  'changing_room',
]);
const openGalleryId = features.find(
  (f) =>
    f.properties.type === 'gallery' &&
    f.properties.floor === 1 &&
    !f.properties.closed &&
    f.properties.galleryNumber,
)!.properties.galleryNumber!;
const openPlace = features.find(
  (f) =>
    f.properties.type === 'shop' &&
    f.properties.floor === 1 &&
    !f.properties.closed &&
    (f.properties.title ?? f.properties.name),
)!.properties;
const roofBar = features.find(
  (f) => f.properties.type === 'bar' && f.properties.floor === 5,
)!.properties;

/**
 * Pan/zoom transform of the map viewport, rounded for settle comparison
 * (translate then scale about the view center → matrix(a,b,c,d,e,f)).
 */
function viewportTransform(page: Page): Promise<string> {
  return page.getByTestId('map-viewport').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    const m = new DOMMatrixReadOnly(t === 'none' ? undefined : t);
    return [m.a, m.e, m.f].map((v) => Math.round(v * 10) / 10).join(',');
  });
}

/** Resolve once the viewport transform is stable across two 100ms samples. */
async function settledTransform(page: Page): Promise<string> {
  let prev = '';
  await expect
    .poll(
      async () => {
        const cur = await viewportTransform(page);
        const same = cur === prev && cur !== '';
        prev = cur;
        return same;
      },
      { timeout: 7_000, intervals: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
    )
    .toBe(true);
  return prev;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(`globalThis.__MET_GEOMETRY__ = ${geometryJson};`);
  await page.goto('/');
  await expect(page.getByTestId('floor-map-real')).toBeVisible();
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
  // Gallery 131 is flagged closed in the snapshot → grey hatched fill, still
  // tappable; its sheet is the honest dead-end (identity, no actions).
  await expect(g131).toHaveAttribute('fill', /url\(/);
  await g131.click();
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await expect(page.getByTestId('room-sheet')).toContainText('Temple of Dendur');
  await expect(page.getByTestId('room-closed-note')).toContainText('Currently inaccessible');
  await expect(page.getByTestId('room-directions')).toHaveCount(0);
  await expect(page.getByTestId('room-im-here')).toHaveCount(0);
});

test('tap grammar: open rooms are white, open places open the amenity sheet with actions', async ({
  page,
}) => {
  // WHITE = tappable, for galleries AND named places alike (user mandate).
  await expect(page.getByTestId(`room-${openGalleryId}`)).toHaveAttribute('fill', '#ffffff');
  const place = page.getByTestId(`room-g${openPlace.geomId}`);
  await expect(place).toHaveAttribute('fill', '#ffffff');
  await place.click();
  const sheet = page.getByTestId('room-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText((openPlace.title ?? openPlace.name)!);
  // Thin amenity variant: kind glyph + both actions (open place → routable).
  await expect(page.getByTestId('sheet-amenity-glyph')).toBeVisible();
  await expect(page.getByTestId('room-directions')).toBeVisible();
  await expect(page.getByTestId('room-im-here')).toBeVisible();
});

test('floor 5: closed Roof Garden + Bar are tappable dead-ends; backdrop stays inert', async ({
  page,
}) => {
  await page.getByTestId('floor-chip-5').click();
  // Gallery 926 (Cantor Roof Garden) is closed in the Met's live data.
  const roof = page.getByTestId('room-926');
  await expect(roof).toHaveAttribute('fill', /url\(/); // grey + hatch
  await roof.click();
  const sheet = page.getByTestId('room-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Cantor Roof Garden');
  await expect(page.getByTestId('room-closed-note')).toContainText('Currently inaccessible');
  // ZERO action buttons: no DIRECTIONS, no I'M HERE on inaccessible rooms.
  await expect(page.getByTestId('room-directions')).toHaveCount(0);
  await expect(page.getByTestId('room-im-here')).toHaveCount(0);
  await page.getByTestId('room-sheet-close').click();

  // The Roof Garden Bar (closed place polygon) is equally tappable.
  const bar = page.getByTestId(`room-g${roofBar.geomId}`);
  await expect(bar).toHaveAttribute('fill', /url\(/);
  await bar.click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Cantor Roof Garden Bar');
  await expect(page.getByTestId('room-closed-note')).toContainText('Currently inaccessible');
  await expect(page.getByTestId('room-im-here')).toHaveCount(0);

  // Corridors / BOH / floor plate take no taps: the named pair is ALL there is.
  expect(await page.locator('path[data-testid^="room-"]').count()).toBe(2);
});

test('per-floor viewport memory: deep floor-1 zoom never strands floor 5 blank', async ({
  page,
}) => {
  await expect(page.getByTestId('room-131')).toBeVisible();
  await settledTransform(page); // initial fit-to-floor settles

  // Zoom deep into floor 1 (viewport-center anchored steps).
  for (let i = 0; i < 4; i++) await page.getByTestId('zoom-in').click();
  const deepZoom = await settledTransform(page);

  // Floor 5 is a tiny roof-garden cluster: without per-floor viewports this
  // landed on blank backdrop. It must arrive framed (fit-to-floor default).
  await page.getByTestId('floor-chip-5').click();
  await expect(page.getByTestId('room-926')).toBeInViewport();
  const floor5 = await settledTransform(page);
  expect(floor5).not.toBe(deepZoom);

  // Back to floor 1: the deep-zoom viewport is restored from memory.
  await page.getByTestId('floor-chip-1').click();
  await expect(page.getByTestId('room-131')).toBeVisible();
  expect(await settledTransform(page)).toBe(deepZoom);
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
  await expect(page.locator('[data-testid^="room-"]').first()).toBeVisible();
  const elapsed = Date.now() - t0;
  const paths = await page.locator('svg path').count();
  console.log(`[realmap] cold home render: ${elapsed} ms, ${paths} svg paths on floor 1`);
  expect(paths).toBeGreaterThan(200); // galleries + corridors + amenities + outline
});
