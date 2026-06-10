import { expect, test } from '@playwright/test';

/**
 * testID contract with apps/mobile: the app's root view must carry
 * testID="app-root" (react-native-web renders this as data-testid="app-root").
 * Until the mockup ships that testID, this spec falls back to asserting that
 * the Expo web mount point (#root) rendered non-empty content — i.e. the JS
 * bundle loaded and React mounted the shell.
 */
test('app shell renders', async ({ page }) => {
  await page.goto('/');

  // Expo web mounts the app into div#root; empty #root means a broken bundle.
  const mount = page.locator('#root');
  await expect(mount).not.toBeEmpty({ timeout: 30_000 });

  // Prefer the contracted testID, falling back to any rendered shell child.
  const shell = page.getByTestId('app-root').or(mount.locator(':scope > *'));
  await expect(shell.first()).toBeVisible();
});
