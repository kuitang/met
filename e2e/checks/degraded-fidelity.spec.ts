import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

/**
 * Degraded-fidelity UI (C3) — a museum with no routing graph and no gallery
 * geometry (AIC today; every non-Met museum in the registry shares the same
 * capabilities). Real-provider gated (REAL_TARGET), same boot recipe as
 * checks/dataprovider.spec.ts — this needs a real multi-museum met.sqlite
 * (`npm -w data run build-db`), not the single-museum stub:
 *
 *   npm -w server run build
 *   DATA_DIR=data PORT=8788 node server/dist/index.js &
 *   EXPO_PUBLIC_DATA=real EXPO_PUBLIC_API_URL=http://localhost:8788 \
 *     npm -w apps/mobile exec -- expo start --web --port 8082 &
 *   cd e2e && REAL_TARGET=http://localhost:8082 \
 *     npx playwright test --project=checks degraded-fidelity
 *
 * Asserts, against a real AIC (hasGeometry: false, hasGraph: false) object
 * and venue: no DIRECTIONS/"Navigate here" anywhere, WayfindingCard fills
 * that slot instead, the locate-sheet picker always shows the museum's
 * staleness line (object-page staleness is threshold-gated — see below —
 * so it is asserted against the ACTUAL fetchedAt read from the artifact,
 * never hardcoded), and the object page's attribution links out to the
 * AIC's own site + terms, not the Met's.
 */

const TARGET = process.env.REAL_TARGET; // e.g. http://localhost:8082
test.skip(!TARGET, 'REAL_TARGET not set — see boot recipe in this spec');

const DB_PATH = path.resolve(__dirname, '../../data/met.sqlite');

interface FixtureObject {
  objectID: number;
  title: string;
  galleryNumber: string;
}

interface Fixture {
  object: FixtureObject;
  /** Whole days since AIC's meta.museums fetchedAt (or meta.builtAt fallback) — same math as StalenessBadge.daysSince. */
  stalenessDays: number;
}

function loadFixture(): Fixture {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const object = db
      .prepare(
        `SELECT objectID, title, galleryNumber FROM objects
         WHERE museum = 'aic' AND galleryNumber != ''
         ORDER BY isHighlight DESC, objectID LIMIT 1`,
      )
      .get() as FixtureObject | undefined;
    if (!object) throw new Error('no on-view AIC object in data/met.sqlite');

    const museums = JSON.parse(
      (db.prepare(`SELECT value FROM meta WHERE key = 'museums'`).get() as { value: string }).value,
    ) as { id: string; fetchedAt: string | null }[];
    const builtAt = (db.prepare(`SELECT value FROM meta WHERE key = 'builtAt'`).get() as { value: string })
      .value;
    const aic = museums.find((m) => m.id === 'aic');
    const fetchedAt = aic?.fetchedAt ?? builtAt;
    const stalenessDays = Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 86_400_000));

    return { object, stalenessDays };
  } finally {
    db.close();
  }
}

const fixture = TARGET ? loadFixture() : null!;

// e2e-discipline: allow(REAL_TARGET-gated spec — skipped in CI; the budget
// covers a genuine first-run met.sqlite download, not a missing element)
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

/**
 * Switch the app venue to AIC and land on its (map-less) home. A fresh
 * `page.goto` after clicking the venue button would reload the SPA and lose
 * the in-memory LocateState store, so the return trip is the in-app HOME
 * button (client-side dismissTo) — same as a real visitor would do.
 */
async function gotoAicHome(page: Page) {
  await gotoReal(page, '/locate');
  await page.getByTestId('venue-aic').click();
  await page.getByTestId('home-button').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('room-list-browse')).toBeVisible();
}

test('AIC object page: no Directions, WayfindingCard instead, AIC attribution', async ({ page }) => {
  // Reach the object from the AIC venue via the real tap-through (room list
  // → room sheet → object row) rather than a direct deep link: a fresh
  // `/object/{id}` load defaults to the Met venue, which is a DIFFERENT
  // museum from the object's own — that's the pre-existing crossMuseum
  // "VIEW AT ART INSTITUTE" case (C2), not what this spec is after.
  await gotoAicHome(page);
  await page.getByTestId(`room-list-row-${fixture.object.galleryNumber}`).click();
  await page.getByTestId(`sheet-object-${fixture.object.objectID}`).click();

  await expect(page.getByTestId('object-title')).toHaveText(fixture.object.title);
  await expect(page.getByTestId('object-gallery-chip')).toContainText(fixture.object.galleryNumber);

  // Correctness, not cosmetics: the affordance must not exist at all.
  await expect(page.getByTestId('navigate-here')).toHaveCount(0);
  await expect(page.getByTestId('wayfinding-card')).toBeVisible();
  await expect(page.getByTestId('wayfinding-card')).toContainText(fixture.object.galleryNumber);
  await expect(page.getByTestId('wayfinding-card')).toContainText('Art Institute');

  // Attribution: AIC's own site + terms, never the Met's.
  const metLink = page.getByTestId('object-met-link');
  await expect(metLink).toBeVisible();
  await expect(metLink).toContainText('artic.edu');
  await expect(page.getByTestId('object-attribution-text')).toContainText('Art Institute of Chicago');
  await expect(page.getByTestId('object-terms-link')).toBeVisible();

  // Threshold-gated (StalenessBadge): assert against the artifact's ACTUAL
  // fetchedAt, not a hardcoded day count — never flaky, always honest.
  const staleness = page.getByTestId('object-staleness');
  if (fixture.stalenessDays < 14) {
    await expect(staleness).toHaveCount(0);
  } else {
    await expect(staleness).toBeVisible();
    await expect(staleness).toContainText('Verified');
    if (fixture.stalenessDays >= 60) await expect(staleness).toContainText('may have moved');
  }
});

test('locate sheet: AIC venue group always shows its staleness line', async ({ page }) => {
  await gotoReal(page, '/locate');
  // The picker variant renders unconditionally (reassurance, not just a
  // warning) — unlike the object page, this assertion never depends on how
  // stale the fixture happens to be.
  const badge = page.getByTestId('venue-staleness-aic');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Verified');
});

test('home at the AIC venue: RoomListBrowse, never the map or its stub fallback', async ({ page }) => {
  await gotoAicHome(page);
  await expect(page.getByTestId(`room-list-row-${fixture.object.galleryNumber}`)).toBeVisible();
  // Neither the real-geometry map nor the stub schematic ever renders here —
  // there is no map at all for a hasGeometry:false museum (both FloorMap
  // variants share the container testID 'floor-map').
  await expect(page.getByTestId('floor-map')).toHaveCount(0);
  await expect(page.getByTestId('floor-map-real')).toHaveCount(0);
});
