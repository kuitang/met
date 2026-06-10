/**
 * Shared journey-suite plumbing. Journeys run against the REAL stack:
 *
 *   npm -w server run build
 *   EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
 *   DATA_DIR=$PWD/data LLM_MOCK=1 PORT=8789 RUN_REFRESH=0 node server/dist/index.js
 *   cd e2e && JOURNEY_TARGET=http://localhost:8789 npm run journeys
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
 * outside a concave polygon (and onto a neighbor) — fall back to dispatching
 * the click straight on the path when the room sheet doesn't open.
 */
export async function tapRoom(page: Page, roomId: string): Promise<void> {
  const room = page.getByTestId(`room-${roomId}`);
  await expect(room).toBeVisible();
  await room.click();
  try {
    await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 2_000 });
  } catch {
    await room.dispatchEvent('click');
    await expect(page.getByTestId('room-sheet')).toBeVisible({ timeout: 5_000 });
  }
}

/** Set the visitor's room through the locate sheet (the J2 entry mode). */
export async function locateRoom(page: Page, galleryNumber: string): Promise<void> {
  await page.getByTestId('locate-chip').click();
  await page.getByTestId('locate-input').fill(galleryNumber);
  await page.getByTestId('locate-room-btn').click();
  await expect(page.getByTestId('locate-chip')).toContainText(`Gallery ${galleryNumber}`);
}
