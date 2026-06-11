import type { Page } from '@playwright/test';

/**
 * Condition-based replacements for "wait N ms for the animation" — the e2e
 * discipline (scripts/check-e2e-discipline.mjs) bans unconditional waits in
 * checks/**. Both helpers poll on animation frames (waitForFunction's
 * default), so they resolve within ~1 frame of the real condition instead of
 * over-waiting a worst-case constant.
 */

declare global {
  // Per-call frame-stability counters, keyed by caller-supplied nonce.
  interface Window {
    __e2eSettle?: Record<string, { v: string; n: number }>;
  }
}

/**
 * Resolve once the element's top edge is BOTH inside [minY, maxY] AND stable
 * for `frames` consecutive animation frames. A spring/snap animation moves
 * every frame, so N equal samples *inside the target band* mean the motion
 * finished at the expected position — a transient pass-through mid-spring
 * never yields N stable in-band samples. Replaces "waitForTimeout(800)
 * // let the spring settle" with the actual settle condition.
 */
export async function settledInBand(
  page: Page,
  testId: string,
  minY: number,
  maxY: number,
  nonce: string,
  frames = 5,
): Promise<void> {
  await page.waitForFunction(
    ({ testId, minY, maxY, nonce, frames }) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) return false;
      const store = (window.__e2eSettle ??= {});
      const key = `band:${testId}:${nonce}`;
      const y = el.getBoundingClientRect().y;
      if (y < minY || y > maxY) {
        delete store[key];
        return false;
      }
      const v = y.toFixed(1);
      const rec = store[key];
      store[key] = { v, n: rec && rec.v === v ? rec.n + 1 : 0 };
      return store[key].n >= frames;
    },
    { testId, minY, maxY, nonce, frames },
    { timeout: 7_000 },
  );
}

/**
 * Resolve once the nearest horizontally-scrollable ancestor of the route
 * step cards has come to rest (scrollLeft stable for `frames` consecutive
 * animation frames). The route screen animates scrollToOffset after every
 * advance and suppresses onScroll sync only for a 700 ms quiet window
 * (apps/mobile route/[from]/[to].tsx scrollQuietUntil); tapping "I'm here"
 * again mid-flight can regress the just-advanced step. Waiting for the
 * actual rest state replaces the old "waitForTimeout(500) between taps".
 */
export async function stepScrollSettled(page: Page, nonce: string, frames = 5): Promise<void> {
  await page.waitForFunction(
    ({ nonce, frames }) => {
      const card = document.querySelector('[data-testid^="route-step-"]');
      if (!card) return false;
      let el: HTMLElement | null = card.parentElement;
      while (el && el.scrollWidth <= el.clientWidth + 1) el = el.parentElement;
      if (!el) return true; // few steps: the list cannot scroll at all
      const store = (window.__e2eSettle ??= {});
      const key = `steps:${nonce}`;
      const v = String(el.scrollLeft);
      const rec = store[key];
      store[key] = { v, n: rec && rec.v === v ? rec.n + 1 : 0 };
      return store[key].n >= frames;
    },
    { nonce, frames },
    { timeout: 7_000 },
  );
}
