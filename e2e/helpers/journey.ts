/**
 * Shared journey-suite plumbing. Journeys run against the REAL stack:
 *
 *   npm -w server run build
 *   EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
 *   GEMINI_API_KEY=$(cat ~/.gemini_key) DATA_DIR=$PWD/data PORT=8789 \
 *     node server/dist/index.js
 *   cd e2e && JOURNEY_TARGET=http://localhost:8789 npm run journeys
 *
 * Canonical recordings run with the LIVE LLM (no LLM_MOCK — the videos show
 * the whole app, Gemini included; cost is pennies). The same suite also
 * passes against an LLM_MOCK=1 server for free deterministic re-runs.
 *
 * (JOURNEY_TARGET skips the stub-data expo webServer in playwright.config.ts;
 * the prod server serves the real-provider web export AND /api same-origin.)
 */
import { expect, type Page } from '@playwright/test';

/** Fifth Ave main entrance == the Great Hall (shared/positioning SITE_ENTRANCES). */
export const FIFTH_AVE_ENTRANCE = { lat: 40.7794, lon: -73.9632 };
/** Mid-Central-Park outlier, ~1 km from every entrance (gps.md eval case). */
export const CENTRAL_PARK_OUTLIER = { lat: 40.7711, lon: -73.9742 };

const BOOT = { timeout: 60_000 };

/**
 * Navigate and wait until the real data provider is live: DataGate resolves
 * after the first-run met.sqlite download (or the Cache Storage copy).
 */
export async function bootReal(page: Page, route = '/'): Promise<void> {
  await page.goto(route);
  await expect(page.getByTestId('app-root')).toBeVisible(BOOT);
  await expect(page.getByTestId('data-loading')).toHaveCount(0, BOOT);
}

/**
 * Journeys are gated on JOURNEY_TARGET (the real stack): a plain
 * `--project=journeys` run against the stub expo webServer skips with this
 * flag rather than asserting stub data.
 */
export const HAS_REAL_TARGET = !!process.env.JOURNEY_TARGET;

/** Met red (theme.colors.red) — the stroke of a highlighted room polygon. */
export const HIGHLIGHT_STROKE = '#e4002b';

/**
 * Tap a room polygon. A plain click targets the bbox center, which can fall
 * outside a concave polygon (onto a neighbor) or under a fixed overlay (the
 * floor chips intercept pointer events, stalling click retries forever) —
 * bound the attempt and fall back to dispatching the click straight on the
 * path when the room sheet doesn't open.
 */
export async function tapRoom(page: Page, roomId: string): Promise<void> {
  const room = page.getByTestId(`room-${roomId}`);
  await expect(room).toBeVisible();
  try {
    await room.click({ timeout: 5_000 });
  } catch {
    /* center unclickable (overlay/concave) — the dispatchEvent fallback below covers it */
  }
  try {
    await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 2_000 });
  } catch {
    await room.dispatchEvent('click');
    await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 5_000 });
  }
}

/**
 * Bounded wait for the object page's hero image to finish painting, so the
 * recorded videos never linger on the grey loading block. The image proxy is
 * pre-warmed by prewarm-images.ts, so this is normally instant. Non-fatal on
 * timeout (imageless objects render no <img> at all — resolves immediately;
 * a slow CDN miss must not fail a journey). Call it only after an
 * object-page assertion (e.g. object-title) so the <img> has mounted.
 *
 * The trailing 600 ms is for the recording itself: tests otherwise end
 * milliseconds after the bytes decode, before the spinner-clearing repaint
 * is ever captured — the video's final frames would still show the grey
 * block even though the image had loaded (observed on a warm cache).
 */
export async function awaitHeroImage(page: Page, timeoutMs = 3_000): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector(
          '[data-testid="object-image"]',
        ) as HTMLImageElement | null;
        return !img || (img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: timeoutMs },
    )
    .catch(() => undefined);
  await page.waitForTimeout(600);
}

/** Set the visitor's room through the locate sheet (the J2 entry mode). */
export async function locateRoom(page: Page, galleryNumber: string): Promise<void> {
  await page.getByTestId('locate-chip').click();
  await page.getByTestId('locate-input').fill(galleryNumber);
  await page.getByTestId('locate-room-btn').click();
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${galleryNumber}`);
}
