/**
 * J7 — LLM fallback. "that huge painting of washington crossing a river in a
 * boat" under-matches locally → "Ask differently" → one round trip to
 * POST /api/v1/search/interpret → server-ranked results render. Assertions
 * are behavioral (200, banner shows the response's own ftsQuery, rows ===
 * server ranking) so the same test passes against a live-Gemini server (the
 * canonical recording mode) or an LLM_MOCK=1 server (deterministic canned
 * rewrite "washington crossing delaware"). When objectID 11417 (Washington
 * Crossing the Delaware) is in the catalog it must be among the ranked
 * results — golden-set semantics (data/evals/search-cases.json llm tier,
 * run-goldens.mjs `matches`), NOT top-1: the measured live rewrite
 * ("washington OR crossing OR river OR boat", llm-live-results.json) also
 * legitimately surfaces Jacob Lawrence's Struggle Series No. 10, whose full
 * title literally contains "Washington Crossing the Delaware".
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
  // …and the rendered rows are the server's ranked results: the list is
  // virtualized (FlatList windowing) so the DOM holds the initial window of
  // the ranking, led by the server's top hit.
  const ids = body.results.map((r) => r.objectID);
  const rows = page.locator('[data-testid^="result-"]');
  // The C2 section headers (AT THE MET / OTHER MUSEUMS) occupy list-item
  // slots of the initial render window, so the 10th OBJECT row only appears
  // once a later render batch lands — assert via the auto-retrying
  // visibility matcher, then bound by the server's result count.
  await expect(rows.nth(Math.min(ids.length, 10) - 1)).toBeVisible();
  expect(await rows.count()).toBeLessThanOrEqual(ids.length);
  await expect(rows.first()).toHaveAttribute('data-testid', `result-${ids[0]}`);

  if (F.washingtonPresent) {
    // Full catalog: Washington Crossing the Delaware is among the ranked
    // results (golden-set contains-semantics; see header) and its row renders
    // when it falls inside the initial window.
    const rank = ids.indexOf(11417);
    expect(rank).toBeGreaterThanOrEqual(0);
    if (rank < 10) {
      const washington = page.getByTestId('result-11417');
      await washington.scrollIntoViewIfNeeded();
      await expect(washington).toContainText('Washington Crossing the Delaware');
    }
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
