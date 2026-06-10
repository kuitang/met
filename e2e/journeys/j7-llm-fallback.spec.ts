/**
 * J7 — LLM fallback. "that huge painting of washington crossing a river in a
 * boat" under-matches locally → "Ask differently" → one round trip to
 * POST /api/v1/search/interpret (LLM_MOCK=1: deterministic canned rewrite
 * "washington crossing delaware") → server-ranked results render.
 * When objectID 11417 (Washington Crossing the Delaware) is in the catalog
 * (post-hydration), it must rank first. The @live variant (LLM_LIVE=1 against
 * a non-mock server) runs the real gemini flash-lite.
 */
import { expect, test } from '@playwright/test';

import { loadJourneyFixtures } from '../helpers/db';
import { HAS_REAL_TARGET, bootReal } from '../helpers/journey';
import { step } from '../helpers/steps';

test.skip(!HAS_REAL_TARGET, 'set JOURNEY_TARGET — see helpers/journey.ts');
const F = HAS_REAL_TARGET ? loadJourneyFixtures() : null!;

const QUERY = 'that huge painting of washington crossing a river in a boat';

async function runInterpretJourney(page: import('@playwright/test').Page) {
  await bootReal(page);

  await step(page, `Asking like a human: “${QUERY}”`, async () => {
    await page.getByTestId('home-search-bar').click();
    await page.getByTestId('search-input').fill(QUERY);
  });

  // The local index under-matches → the escalation CTA appears.
  await expect(page.getByTestId('ask-differently')).toBeVisible();

  const interpretResponse = page.waitForResponse(
    (r) => r.url().includes('/api/v1/search/interpret') && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await step(page, 'Ask differently — the server LLM interprets and re-searches', async () => {
    await page.getByTestId('ask-differently').click();
  });

  const response = await interpretResponse;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    results: { objectID: number }[];
    method: string;
    interpretedQuery: { ftsQuery: string };
  };
  expect(['rewrite', 'agentic']).toContain(body.method);

  // The banner shows the machine's actual interpretation…
  await expect(page.getByTestId('interpreted-banner')).toBeVisible();
  await expect(page.getByTestId('interpreted-query')).toContainText(
    body.interpretedQuery.ftsQuery,
  );
  // …and the rendered rows are exactly the server's ranked results.
  const rows = page.locator('[data-testid^="result-"]');
  expect(await rows.count()).toBe(body.results.length);

  if (F.washingtonPresent) {
    // Full catalog: Washington Crossing the Delaware ranks first.
    expect(body.results[0]?.objectID).toBe(11417);
    await expect(rows.first()).toHaveAttribute('data-testid', 'result-11417');
    await expect(rows.first()).toContainText('Washington Crossing the Delaware');
  } else {
    console.log(
      `[J7] objectID 11417 not in the partial snapshot (${F.objectCount} objects) — ` +
        're-run after full hydration for the Washington-first assertion.',
    );
  }
}

test('J7 LLM fallback: weak local match → server interpret → ranked results', async ({
  page,
}) => {
  await runInterpretJourney(page);
});

test('J7 @live: real gemini interpret (needs LLM_LIVE=1 + non-mock server)', async ({
  page,
}) => {
  test.skip(process.env.LLM_LIVE !== '1', 'live LLM smoke runs only with LLM_LIVE=1');
  await runInterpretJourney(page);
});
