import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Image-CDN acceptance — "every thumbnail works AND image bytes bypass the
 * app server" (see ARCHITECTURE.md "Images: Tigris CDN first").
 *
 * For sampled result rows, room-sheet rows and object heroes this spec
 * asserts (a) every rendered <img> actually paints (naturalWidth > 0 — real
 * fetches against the public Tigris bucket, generous timeout) and (b) ZERO
 * requests hit the server's /api/v1/img fallback proxy during the
 * happy-path sweep, while at least one request hits the bucket — proving
 * the bytes did not route through the app server.
 *
 * Needs the real-provider prod-mode stack (same boot as dataprovider.spec /
 * the journey suite), so it is gated on REAL_TARGET and skips in the plain
 * `npm run e2e` run. Boot recipe (repo root):
 *
 *   npm -w server run build
 *   EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
 *   DATA_DIR=$PWD/data PORT=8790 node server/dist/index.js &
 *   cd e2e && REAL_TARGET=http://localhost:8790 \
 *     npx playwright test --project=checks imagecdn
 *
 * Fixtures are read from data/met.sqlite at spec load: a gallery whose
 * leading objects (the ones the UI renders first) all have pre-generated
 * derivatives — i.e. the happy path. Objects without a thumbKey fall back
 * to the proxy BY DESIGN and are covered by unit-level fallback logic, not
 * by this sweep.
 */

const TARGET = process.env.REAL_TARGET; // e.g. http://localhost:8790
test.skip(!TARGET, 'REAL_TARGET not set — see boot recipe in this spec');

// Host of the public derivative bucket — keep in sync with the ONE client
// constant in apps/mobile/src/data/imageCdn.ts (not importable here: that
// module pulls in expo-constants via ./apiBase).
const CDN_HOST = 'musewalk-images.fly.storage.tigris.dev';

const DB_PATH = path.resolve(__dirname, '../../data/met.sqlite');
const SAMPLE = 8; // rows asserted per list screen (FlatList renders ~10 at 844px)

interface Fixture {
  galleryId: string;
  /** objectID of the first row the gallery list renders (hero target). */
  firstObjectID: number;
}

function pickFixture(): Fixture {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Open, polygon-mapped Fifth-Ave galleries (tappable on the home map),
    // ordered by object count — same base rule as the journey fixtures.
    const blob = db
      .prepare(`SELECT value FROM blobs WHERE key = 'galleries.geojson'`)
      .get() as { value: Buffer };
    const geo = JSON.parse(gunzipSync(blob.value).toString()) as {
      features: {
        properties: { galleryNumber: string; site: string; closed: boolean };
      }[];
    };
    const openMapped = new Set(
      geo.features
        .filter((f) => !f.properties.closed && f.properties.site === 'fifthAve')
        .map((f) => f.properties.galleryNumber),
    );
    const galleries = db
      .prepare(
        `SELECT galleryNumber, COUNT(*) c FROM objects WHERE galleryNumber != ''
         GROUP BY galleryNumber ORDER BY c DESC LIMIT 50`,
      )
      .all() as { galleryNumber: string }[];
    for (const g of galleries) {
      if (!openMapped.has(g.galleryNumber)) continue;
      // The UI's gallery ordering (SqliteDataProvider.objectsInGallery).
      const lead = db
        .prepare(
          `SELECT objectID, imageUrl, thumbKey FROM objects WHERE galleryNumber = ?
           ORDER BY isHighlight DESC, objectID LIMIT 30`,
        )
        .all(g.galleryNumber) as { objectID: number; imageUrl: string; thumbKey: string }[];
      // Happy path = every leading object that has an image has a derivative,
      // and the first row (the hero target) has one.
      const happy =
        lead.length >= SAMPLE &&
        lead[0].imageUrl !== '' &&
        lead.every((o) => o.imageUrl === '' || o.thumbKey !== '');
      if (happy) return { galleryId: g.galleryNumber, firstObjectID: lead[0].objectID };
    }
    throw new Error('no gallery with fully thumbnailed leading objects in data/met.sqlite');
  } finally {
    db.close();
  }
}

const fixture = TARGET ? pickFixture() : null!;

const FIRST_PAINT = { timeout: 60_000 };

interface RequestCounts {
  proxy: string[]; // /api/v1/img/... URLs seen (must stay empty)
  cdn: number; // bucket requests seen (must be > 0)
}

/** Count image-byte requests for the whole page lifetime. */
function trackImageRequests(page: Page): RequestCounts {
  const counts: RequestCounts = { proxy: [], cdn: 0 };
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/v1/img/')) counts.proxy.push(url);
    if (url.includes(CDN_HOST)) counts.cdn += 1;
  });
  return counts;
}

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
 * Assert the first `min` rendered thumbnails ALL paint real pixels.
 * Real network fetches against the bucket — generous timeout.
 */
async function expectThumbsPainted(page: Page, min: number) {
  await page.waitForFunction(
    (n) => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>('img[data-testid="object-thumb"]'),
      );
      return imgs.length >= n && imgs.slice(0, n).every((i) => i.complete && i.naturalWidth > 0);
    },
    min,
    { timeout: 30_000 },
  );
}

test.describe('image CDN happy path', () => {
  test.setTimeout(120_000);

  test('results rows + object hero load from the bucket, zero proxy requests', async ({
    page,
  }) => {
    const counts = trackImageRequests(page);
    await gotoReal(page, `/results?gallery=${fixture.galleryId}`);

    // Every sampled result-row thumbnail paints (t320 derivatives).
    await expect(page.getByTestId(`result-${fixture.firstObjectID}`)).toBeVisible(FIRST_PAINT);
    await expectThumbsPainted(page, SAMPLE);

    // Row → object page: the c1080 hero paints too.
    await page.getByTestId(`result-${fixture.firstObjectID}`).click();
    await page.waitForFunction(
      () => {
        const img = document.querySelector<HTMLImageElement>('[data-testid="object-image"]');
        return !!img && img.complete && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 30_000 },
    );

    // The whole sweep produced image bytes from the bucket and NONE from the
    // app server (the proxy is reserved for fallbacks, none happened here).
    expect(counts.proxy).toEqual([]);
    expect(counts.cdn).toBeGreaterThan(0);
  });

  test('room-sheet thumbnails load from the bucket, zero proxy requests', async ({ page }) => {
    const counts = trackImageRequests(page);
    await gotoReal(page, '/');
    await expect(page.getByTestId('floor-map-real')).toBeVisible(FIRST_PAINT);

    // Anchor in the fixture gallery first (J2's entry mode) so the map shows
    // its floor regardless of the default.
    await page.getByTestId('locate-chip').click();
    await page.getByTestId('locate-input').fill(fixture.galleryId);
    await page.getByTestId('locate-room-btn').click();
    await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${fixture.galleryId}`);

    // Tap the fixture gallery on the home map (helpers/journey.ts pattern:
    // bbox-center clicks can land on a neighbor/overlay — fall back to a
    // direct event).
    const room = page.getByTestId(`room-${fixture.galleryId}`);
    await expect(room).toBeVisible(FIRST_PAINT);
    try {
      await room.click({ timeout: 5_000 });
    } catch {
      /* concave polygon / overlay — dispatchEvent below */
    }
    try {
      await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 2_000 });
    } catch {
      await room.dispatchEvent('click');
      await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 5_000 });
    }

    await expectThumbsPainted(page, Math.min(SAMPLE, 5)); // sheet shows ~5 rows
    expect(counts.proxy).toEqual([]);
    expect(counts.cdn).toBeGreaterThan(0);
  });
});
