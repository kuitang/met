import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

/**
 * Real data layer end-to-end — SqliteDataProvider over a downloaded
 * met.sqlite (expo-sqlite wasm + SharedArrayBuffer worker on web).
 *
 * This spec needs an Expo web instance built with the REAL provider plus the
 * production API server, which the default checks webServer (stub data on
 * :8081) is not. It is therefore gated on REAL_TARGET and skips in the plain
 * `npm run e2e` run. Boot recipe (repo root):
 *
 *   npm -w server run build
 *   DATA_DIR=data PORT=8788 node server/dist/index.js &
 *   EXPO_PUBLIC_DATA=real EXPO_PUBLIC_API_URL=http://localhost:8788 \
 *     npm -w apps/mobile exec -- expo start --web --port 8082 &
 *   cd e2e && REAL_TARGET=http://localhost:8082 \
 *     npx playwright test --project=checks dataprovider
 *
 * Every test runs in a fresh browser context (empty OPFS), so each page load
 * exercises the full first-run flow: GET /api/v1/data/met.sqlite → open in
 * memory → SqliteDataProvider.create(). Fixture values (a real on-view
 * object) are read from data/met.sqlite at spec load so the assertions track
 * the artifact as it grows from the partial to the full catalog.
 */

const TARGET = process.env.REAL_TARGET; // e.g. http://localhost:8082
test.skip(!TARGET, 'REAL_TARGET not set — see boot recipe in this spec');

const DB_PATH = path.resolve(__dirname, '../../data/met.sqlite');

interface FixtureObject {
  objectID: number;
  title: string;
  galleryNumber: string;
}

function pickFixtureObject(): FixtureObject {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // A real on-view object with a clean ASCII multi-word title: typing the
    // title is a distinctive autocomplete prefix query in any catalog size.
    const rows = db
      .prepare(
        `SELECT objectID, title, galleryNumber FROM objects
         WHERE galleryNumber != '' AND length(title) BETWEEN 10 AND 60
         ORDER BY isHighlight DESC, objectID LIMIT 200`,
      )
      .all() as FixtureObject[];
    const clean = rows.find((r) => /^[A-Za-z][A-Za-z0-9 ]+ [A-Za-z0-9 ]+$/.test(r.title));
    if (!clean) throw new Error('no clean fixture object in data/met.sqlite');
    return clean;
  } finally {
    db.close();
  }
}

const fixture = process.env.REAL_TARGET ? pickFixtureObject() : null!;

// First navigation bundles the dev server; the DB download + provider boot
// follow. Be generous once per test.
const FIRST_PAINT = { timeout: 60_000 };

/** Navigate and wait until the real provider is live (DataGate resolved). */
async function gotoReal(page: Page, route: string) {
  const download = page.waitForResponse(
    (r) => r.url().includes('/api/v1/data/met.sqlite') && r.status() === 200,
    FIRST_PAINT,
  );
  await page.goto(`${TARGET}${route}`);
  await download;
  await expect(page.getByTestId('data-loading')).toHaveCount(0, FIRST_PAINT);
}

test('first run downloads met.sqlite and boots the real map', async ({ page }) => {
  await gotoReal(page, '/');
  // Real geometry comes from the provider's galleriesGeometry (blobs table),
  // not the stub rects and not the __MET_GEOMETRY__ test seam.
  await expect(page.getByTestId('floor-map-real')).toBeVisible(FIRST_PAINT);
  expect(await page.locator('path[data-testid^="room-"]').count()).toBeGreaterThan(100);
});

test('autocomplete returns real rows with gallery chips', async ({ page }) => {
  await gotoReal(page, '/search');
  await page.getByTestId('search-input').fill(fixture.title);
  // getAllSync over the SharedArrayBuffer worker bridge answers this query.
  const row = page.getByTestId(`suggestion-${fixture.objectID}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(fixture.title);
  await expect(row).toContainText(`Gallery ${fixture.galleryNumber}`);
});

test('object page renders a real object', async ({ page }) => {
  await gotoReal(page, `/object/${fixture.objectID}`);
  await expect(page.getByTestId('object-title')).toHaveText(fixture.title);
  await expect(page.getByTestId('object-gallery-chip')).toContainText(fixture.galleryNumber);
});
