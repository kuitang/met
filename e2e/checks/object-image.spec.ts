import { expect, test } from '@playwright/test';

/**
 * Image-proxy fallback contract: under the stub data provider (mockup mode,
 * no API server running) ObjectImage must point straight at the Met CDN, NOT
 * at /api/v1/img/* — the proxy only exists once a real server/provider is
 * wired in (dataVersion !== 'stub'). See
 * apps/mobile/src/components/ObjectImage.tsx.
 */

const FIRST_PAINT = { timeout: 45_000 };

test('object screen on stub renders the hero image via direct CDN fallback', async ({
  page,
}) => {
  // 436535 = Wheat Field with Cypresses, a stub object with a CC0 image.
  await page.goto('/object/436535');
  const img = page.getByTestId('object-image');
  await expect(img).toBeVisible(FIRST_PAINT);
  const src = await img.getAttribute('src');
  expect(src).toMatch(/^https:\/\/images\.metmuseum\.org\//);
  expect(src).not.toContain('/api/v1/img/');
});
