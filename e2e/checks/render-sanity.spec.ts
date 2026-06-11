import { expect, test, type Page } from '@playwright/test';

/**
 * Render-sanity sweep — catches the "layout collapsed but nothing crashed"
 * class of defect that the HIG audit can't see. Born from a live iPhone
 * report (2026-06-10): on All Results the filter-chip strip was flex-shrunk
 * to ~5px (RN-web ScrollView defaults to flexShrink:1; a long FlatList
 * sibling squeezed it out), so the chips rendered as clipped, label-less
 * slivers — while every chip still measured 44px tall for the tap-target
 * audit, because the OVERFLOWING rect was measured, not the visible part.
 *
 * Two audits, on every screen:
 *  (a) clip audit — no text-bearing element may be clipped at its nearest
 *      scroll-ancestor's TOP edge while that ancestor is unscrolled, and
 *      none may extend past the BOTTOM edge of an ancestor that cannot
 *      scroll vertically (overflow hidden, or a scroller with no vertical
 *      slack). Content the user can never reach by scrolling is a defect.
 *  (b) chips audit (results screen) — every filter chip has a non-zero
 *      computed height, non-empty visible text, and sits fully inside the
 *      strip's vertical bounds.
 *
 * Runs in both the chromium `checks` project and the `webkit-render`
 * project (iPhone engine — where the report came from).
 */

const FIRST_PAINT = { timeout: 45_000 };

test.use({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: 40.7794, longitude: -73.9632 },
});

/** (a) Returns human-readable clip violations. */
function clipAudit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const hidden = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
    };
    const label = (el: Element) => {
      const id = (el as HTMLElement).dataset?.testid;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      return `<${el.tagName.toLowerCase()}${id ? ` testid=${id}` : ''}${text ? ` "${text}"` : ''}>`;
    };
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      // SVG internals pan/zoom past the map viewport by design.
      if (el.closest('svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || hidden(el)) continue;
      if (getComputedStyle(el).position === 'fixed') continue;
      // Only audit content-bearing nodes; pure layout wrappers overflow
      // legitimately (e.g. a FlatList content container inside a scroller).
      if (!(el.textContent ?? '').trim() && !(el as HTMLElement).dataset?.testid) continue;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (!['hidden', 'clip', 'auto', 'scroll'].includes(ps.overflowY)) continue;
        const pr = p.getBoundingClientRect();
        if (p.scrollTop === 0 && r.top < pr.top - 1) {
          out.push(
            `top-clipped: ${label(el)} top=${r.top.toFixed(1)} above unscrolled ancestor ${label(p)} top=${pr.top.toFixed(1)}`,
          );
        }
        const canScrollY =
          (ps.overflowY === 'auto' || ps.overflowY === 'scroll') &&
          p.scrollHeight > p.clientHeight + 1;
        // r.top < pr.bottom: the element starts inside the ancestor, so its
        // overflowing tail is genuinely cut (not a fully-below sibling).
        if (!canScrollY && r.bottom > pr.bottom + 1 && r.top < pr.bottom - 1) {
          out.push(
            `bottom-clipped: ${label(el)} bottom=${r.bottom.toFixed(1)} past unscrollable ancestor ${label(p)} bottom=${pr.bottom.toFixed(1)}`,
          );
        }
        break; // judge only against the nearest clipping ancestor
      }
    }
    return out;
  });
}

/** (b) Returns filter-chip visibility violations. */
function chipsAudit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const strip = document.querySelector('[data-testid="filter-chips"]');
    if (!strip) return ['filter-chips strip not found'];
    const sr = strip.getBoundingClientRect();
    const chips = strip.querySelectorAll('[data-testid^="filter-"]');
    if (chips.length === 0) return ['no chips inside filter-chips strip'];
    for (const chip of Array.from(chips)) {
      const id = (chip as HTMLElement).dataset.testid;
      const r = chip.getBoundingClientRect();
      const h = parseFloat(getComputedStyle(chip).height);
      const text = ((chip as HTMLElement).innerText ?? '').trim();
      if (!(h > 0)) out.push(`chip ${id}: computed height ${h}`);
      if (!text) out.push(`chip ${id}: no visible text`);
      if (r.top < sr.top - 1 || r.bottom > sr.bottom + 1) {
        out.push(
          `chip ${id}: vertically clipped (chip ${r.top.toFixed(1)}–${r.bottom.toFixed(1)} vs strip ${sr.top.toFixed(1)}–${sr.bottom.toFixed(1)})`,
        );
      }
    }
    return out;
  });
}

test('home renders without clipped content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('floor-map')).toBeVisible(FIRST_PAINT);
  expect(await clipAudit(page)).toEqual([]);
});

test('search with open suggestions renders without clipped content', async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('Monet', FIRST_PAINT);
  // First suggestion row, not a pinned objectID — see hig.spec.ts: the
  // render audits must run against both the stub and the real provider.
  await expect(page.locator('[data-testid^="suggestion-"]').first()).toBeVisible();
  expect(await clipAudit(page)).toEqual([]);
});

test('results with a LONG list keeps the filter chips visible', async ({ page }) => {
  // "a" matches all 79 stub objects — enough rows that a flex-shrinkable
  // chip strip would collapse (the original bug needed a long sibling list).
  await page.goto('/results?q=a');
  // First row, not a pinned objectID — the row set differs between the stub
  // fixture set and the real artifact; the audits only need A long list.
  await expect(page.locator('[data-testid^="result-"]').first()).toBeVisible(FIRST_PAINT);
  expect(await chipsAudit(page)).toEqual([]);
  expect(await clipAudit(page)).toEqual([]);
});

test('object renders without clipped content', async ({ page }) => {
  await page.goto('/object/436535');
  await expect(page.getByTestId('object-title')).toBeVisible(FIRST_PAINT);
  expect(await clipAudit(page)).toEqual([]);
});

test('route renders without clipped content', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('route-step-0')).toBeVisible(FIRST_PAINT);
  expect(await clipAudit(page)).toEqual([]);
});

test('locate renders without clipped content', async ({ page }) => {
  await page.goto('/locate');
  await expect(page.getByTestId('locate-input')).toBeVisible(FIRST_PAINT);
  await expect(page.getByTestId('gps-status')).toContainText('Near Great Hall');
  expect(await clipAudit(page)).toEqual([]);
});
