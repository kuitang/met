import { expect, test, type Page } from '@playwright/test';

/**
 * Apple-HIG compliance sweep (user mandate) — every screen at 390×844 must:
 *  (a) never overflow horizontally: document.scrollWidth <= window.innerWidth
 *      and no unclipped descendant rect past the viewport right edge;
 *  (b) give every visible interactive element (role button/link, anchors,
 *      inputs, RN-web Pressables = tabindex 0) a tap target ≥44×44 CSS px;
 *  (c) render every input/textarea at font-size ≥16px — anything smaller
 *      triggers iOS Safari focus auto-zoom, which is never allowed;
 *  (d) serve a viewport meta of width=device-width, initial-scale=1 and
 *      never user-scalable=no (pinch-zoom stays available — accessibility).
 */

const FIRST_PAINT = { timeout: 45_000 };

test.use({
  viewport: { width: 390, height: 844 },
  // Entrance fix so /locate resolves its GPS state like a real visit.
  geolocation: { latitude: 40.7794, longitude: -73.9632 },
});

/** Runs all four audits in-page; returns human-readable violation strings. */
function audit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = window.innerWidth;

    const label = (el: Element) => {
      const id = (el as HTMLElement).dataset?.testid;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${el.tagName.toLowerCase()}${id ? ` testid=${id}` : ''}${text ? ` "${text}"` : ''}>`;
    };
    const hidden = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
    };

    // ---- (a) horizontal overflow --------------------------------------
    const docW = document.documentElement.scrollWidth;
    if (docW > vw) out.push(`overflow: document.scrollWidth ${docW} > innerWidth ${vw}`);
    // An element past the right edge is only a page-overflow if no ancestor
    // clips/scrolls it (horizontal carousels like the route step list clip).
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || hidden(el)) continue;
      if (r.right > vw + 1 && !clipped(el)) {
        out.push(`overflow-right: ${label(el)} right=${r.right.toFixed(1)}px (viewport ${vw}px)`);
      }
    }

    // ---- (b) tap targets ≥44×44 ---------------------------------------
    const MIN = 44 - 0.5; // half-px tolerance for subpixel layout rounding
    const interactive = document.body.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], [tabindex="0"]',
    );
    for (const el of Array.from(interactive)) {
      if (hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // A child of an already-flagged/measured interactive (e.g. a label span
      // with its own tabindex) shouldn't double-report; measure the outermost.
      if (el.parentElement?.closest('a[href], button, [role="button"], [role="link"], [tabindex="0"]')) {
        continue;
      }
      if (r.width < MIN || r.height < MIN) {
        out.push(`tap-target: ${label(el)} is ${r.width.toFixed(1)}×${r.height.toFixed(1)}px (need 44×44)`);
      }
    }

    // ---- (c) input font sizes ≥16px -----------------------------------
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (hidden(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) out.push(`input-font: ${label(el)} font-size ${fs}px (<16px → iOS auto-zoom)`);
    }

    // ---- (d) viewport meta --------------------------------------------
    const content =
      document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    if (!/width\s*=\s*device-width/.test(content)) {
      out.push(`viewport-meta: missing width=device-width (got "${content}")`);
    }
    if (!/initial-scale\s*=\s*1(\.0+)?\s*(,|$)/.test(content)) {
      out.push(`viewport-meta: missing initial-scale=1 (got "${content}")`);
    }
    if (/user-scalable\s*=\s*(no|0)/.test(content)) {
      out.push('viewport-meta: user-scalable=no present — pinch-zoom must stay enabled');
    }

    return out;
  });
}

test('home passes the HIG sweep', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('floor-map')).toBeVisible(FIRST_PAINT);
  expect(await audit(page)).toEqual([]);
});

test('search with open suggestions passes the HIG sweep', async ({ page }) => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill('Monet', FIRST_PAINT);
  await expect(page.getByTestId('suggestion-438008')).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test('results passes the HIG sweep', async ({ page }) => {
  await page.goto('/results?q=Monet');
  await expect(page.getByTestId('result-438008')).toBeVisible(FIRST_PAINT);
  expect(await audit(page)).toEqual([]);
});

test('object passes the HIG sweep', async ({ page }) => {
  await page.goto('/object/436535');
  await expect(page.getByTestId('object-title')).toBeVisible(FIRST_PAINT);
  expect(await audit(page)).toEqual([]);
});

test('route passes the HIG sweep', async ({ page }) => {
  await page.goto('/route/great-hall/822');
  await expect(page.getByTestId('route-step-0')).toBeVisible(FIRST_PAINT);
  expect(await audit(page)).toEqual([]);
});

test('locate passes the HIG sweep', async ({ page }) => {
  await page.goto('/locate');
  await expect(page.getByTestId('locate-input')).toBeVisible(FIRST_PAINT);
  await expect(page.getByTestId('gps-status')).toContainText('Near Great Hall');
  expect(await audit(page)).toEqual([]);
});
