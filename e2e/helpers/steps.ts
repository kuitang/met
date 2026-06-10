import type { Page } from '@playwright/test';

const CAPTION_ID = '__met_e2e_caption';

/**
 * Wrap a journey action with an on-screen caption so the recorded video is
 * human-followable: overlays a fixed banner (Met red, white text) at the
 * bottom of the page, pauses 800 ms so a viewer can read it, then runs fn.
 * The banner survives in-page navigation only until the next document load;
 * call step() again after page.goto().
 */
export async function step(page: Page, label: string, fn: () => Promise<void>): Promise<void> {
  await page.evaluate(
    ({ id, text }) => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        Object.assign(el.style, {
          position: 'fixed',
          left: '0',
          right: '0',
          bottom: '0',
          zIndex: '2147483647',
          background: '#e4002b',
          color: '#ffffff',
          font: '600 15px/1.4 system-ui, -apple-system, sans-serif',
          padding: '10px 14px',
          textAlign: 'center',
          pointerEvents: 'none',
        });
        document.body.appendChild(el);
      }
      el.textContent = text;
    },
    { id: CAPTION_ID, text: label },
  );
  await page.waitForTimeout(800);
  await fn();
}
