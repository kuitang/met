/**
 * J16 — Multi-museum search. Searching "Monet" from the Met surfaces the
 * Met's own holdings (AT THE MET) alongside every other museum's Monets
 * (OTHER MUSEUMS, badged by shortName — the omnibar's top-8 autocomplete
 * doesn't reliably surface AIC's Monets, so this drives through the All
 * Results page, which sections the full ranked set); the scope chips let a
 * visitor narrow to just the active museum or widen back to everything.
 *
 * Tapping an Art Institute of Chicago hit crosses museums entirely: the
 * object page shows the AIC's own location + attribution + a "VIEW AT ART
 * INSTITUTE" action — crossing MUSEUMS is always an explicit tap (unlike the
 * Fifth Ave <-> Cloisters venue auto-switch, which stays within one museum).
 * Tapping it lands home on the AIC's RoomListBrowse (no fake map — the AIC
 * ships no gallery geometry, C3) with the object's gallery sheet already
 * open (the same `/?focus=` grammar every room-row tap uses); closing that
 * sheet and tapping the gallery row again demonstrates the room-list tap
 * grammar directly. A graphless museum's room sheet shows a static
 * WayfindingCard in place of DIRECTIONS (AIC has no routing graph either).
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

test('J16 multi-museum search: Monet at the Met + other museums, cross to AIC', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await bootReal(page);

  await step(page, 'Searching “Monet” from the Met', async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill('Monet');
  });
  await expect(page.getByTestId('all-results-link')).toBeVisible();

  if (!F.aicMonet) {
    console.log(
      '[J16] no AIC-sited Monet in the catalog yet — the cross-museum steps re-arm once one lands.',
    );
    return;
  }
  const monet = F.aicMonet; // narrowed for the async closures below

  // (.last() throughout — the /search omnibar stays mounted under /results
  // in the expo-router stack and sections its own top-8 the same way, so
  // screen-agnostic text/testID locators resolve twice; the results page's
  // instances are the later ones. Scope-chip taps target the topmost pair.)
  await step(page, 'All results — sectioned by museum', async () => {
    await page.getByTestId('all-results-link').click();
  });
  await expect(page.getByText('AT THE MET').last()).toBeVisible();
  await expect(page.getByText('OTHER MUSEUMS').last()).toBeVisible();
  const badge = page.getByTestId(`museum-badge-${monet.objectID}`);
  // The showcase AIC Monet is NOT an omnibar top-8 hit, so its badge/row
  // exist exactly once — on the results page.
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Art Institute');

  await step(page, 'Scope chip: “The Met” — other museums collapse', async () => {
    await page.getByTestId('scope-chip-here').last().click();
  });
  await expect(page.getByTestId(`museum-badge-${monet.objectID}`)).toHaveCount(0);

  await step(page, 'Scope chip: back to “All museums”', async () => {
    await page.getByTestId('scope-chip-all').last().click();
  });
  await expect(badge).toBeVisible();

  await step(page, `Tapping the Art Institute’s “${monet.title}”`, async () => {
    await page.getByTestId(`result-${monet.objectID}`).click();
  });
  await expect(page.getByTestId('object-title')).toContainText(monet.title);
  await expect(page.getByTestId('object-cross-museum-location')).toContainText(
    'Art Institute of Chicago',
  );
  await expect(page.getByTestId('object-attribution')).toBeVisible();
  const viewAt = page.getByTestId('view-at-museum');
  await expect(viewAt).toContainText('VIEW AT ART INSTITUTE');

  await step(page, 'VIEW AT ART INSTITUTE — home becomes the AIC room list', async () => {
    await viewAt.click();
  });
  await expect(page.getByTestId('room-list-browse')).toBeVisible();

  // The VIEW-AT hop focuses the object's own gallery, so its sheet is
  // already open — close it to read the plain room list (the locate chip's
  // venue line only shows once no sheet owns the bottom band), then reopen
  // it with an explicit row tap (the affordance a visitor browsing the AIC
  // list would actually use).
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  await step(page, 'Closing the auto-opened sheet — the plain AIC room list', async () => {
    await page.getByTestId('room-sheet-close').click();
  });
  await expect(page.getByTestId('room-sheet')).toHaveCount(0);
  await expect(page.getByTestId('locate-chip-venue').last()).toContainText('Art Institute');
  const galleryRow = page.getByTestId(`room-list-row-${monet.galleryId}`);
  await expect(galleryRow).toBeVisible();

  await step(page, `Tapping Gallery ${monet.galleryNumber} in the room list`, async () => {
    await galleryRow.click();
  });
  await expect(page.getByTestId('room-sheet')).toBeVisible();
  // Graphless museum: a WayfindingCard fills the action-row slot, never DIRECTIONS.
  await expect(page.getByTestId('room-sheet-wayfinding')).toBeVisible();
  await expect(page.getByTestId('room-directions')).toHaveCount(0);
});
