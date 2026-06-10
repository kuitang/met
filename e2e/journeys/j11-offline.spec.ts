/**
 * J11 — Offline resilience. After one online boot the network is cut
 * (context.setOffline): room entry, the in-room object list, object pages,
 * full routing, and search autocomplete all keep working from the on-device
 * met.sqlite; the LLM "Ask differently" flow degrades to a graceful offline
 * notice (plain local matches still shown). All navigation stays in-app —
 * no document reloads while offline.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal, locateRoom, tapRoom } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J11 offline: room entry, objects, routing, search — all from cache', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await bootReal(page); // one online boot: met.sqlite is now on-device

  await step(page, 'Airplane mode ON — everything below runs offline', async () => {
    await context.setOffline(true);
  });

  // 1. Room entry still works.
  await step(page, `Room entry offline: Gallery ${F.galleryId}`, async () => {
    await locateRoom(page, F.galleryId);
  });

  // 2. In-room object list still works.
  await step(page, 'In-room objects offline', async () => {
    await tapRoom(page, F.galleryId);
  });
  expect(await page.locator('[data-testid^="sheet-object-"]').count()).toBeGreaterThan(0);

  // …and the object page renders from the local DB.
  const first = F.galleryObjects[0];
  await page.getByTestId(`sheet-object-${first.objectID}`).click();
  await expect(page.getByTestId('object-title')).toHaveText(first.title);
  await page.goBack();

  // 3. Full routing still works (top gallery → 131, real graph, local).
  await step(page, 'Routing offline', async () => {
    if ((await page.getByTestId('room-sheet').count()) > 0) {
      await page.getByTestId('room-sheet-close').click();
    }
    await tapRoom(page, '131');
    await expect(page.getByTestId('room-sheet')).toContainText('Dendur');
    await page.getByTestId('room-directions').click();
  });
  await expect(page.getByTestId('route-summary')).toBeVisible();
  await expect(page.getByTestId('route-step-0')).toContainText('Start in');
  await page.goBack();

  // 4. Search autocomplete still works.
  await step(page, 'Search offline', async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill(F.artifact.title);
  });
  await expect(page.getByTestId(`suggestion-${F.artifact.objectID}`)).toBeVisible();

  // 5. The LLM tier degrades gracefully with an offline notice.
  await step(page, 'LLM search offline → graceful notice + local fallback', async () => {
    await page
      .getByTestId('search-input')
      .fill('that huge painting of washington crossing a river in a boat');
    await page.getByTestId('ask-differently').click();
  });
  await expect(page.getByTestId('interpret-offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('interpret-offline')).toContainText("offline");
});
