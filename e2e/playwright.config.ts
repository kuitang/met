import { defineConfig, devices } from '@playwright/test';

/**
 * Three projects (see README.md):
 *  - checks:   fast headless assertion gate. Run after every change.
 *  - webkit-render: iPhone-engine (WebKit) render guard — runs hig.spec +
 *              render-sanity.spec ONLY, not the whole checks suite, to keep
 *              CI runtime sane. Exists because a chip-strip flex collapse
 *              and COEP-blocked thumbnails shipped invisibly: the
 *              chromium-only sweep never saw what iOS Safari users saw.
 *              Requires `npx playwright install webkit`.
 *  - journeys: user-facing demo videos, phone-sized, deliberately paced.
 *              MUST run serially — invoke via `npm run journeys` (forces
 *              --workers=1) or pass --workers=1 yourself; Playwright has no
 *              per-project workers setting.
 *
 * Target selection: by default tests hit the local Expo web dev server on
 * http://localhost:8081 (started automatically via webServer below). Set
 * JOURNEY_TARGET=https://…fly.dev to run the same suite against a deployed
 * app — webServer is skipped entirely in that case. Set CHECKS_STATIC=1 to
 * serve an ALREADY-BUILT static export (apps/mobile/dist) via
 * e2e/static-server.mjs instead of compiling under Metro — used by CI, where
 * the dev-server compile takes ~25 min on a 2-core runner. The dist must be
 * exported with EXPO_PUBLIC_DATA=stub (the checks specs assert stub-provider
 * data) — and beware the Metro transform cache: it does NOT key on
 * EXPO_PUBLIC_* env, so flipping real→stub requires `expo export -c`
 * (measured 2026-06-11: a stub export after a real one silently re-served
 * the real bundle).
 */
const journeyTarget = process.env.JOURNEY_TARGET;
const staticChecks = !!process.env.CHECKS_STATIC;
const baseURL = journeyTarget ?? 'http://localhost:8081';

export default defineConfig({
  outputDir: 'test-results',
  // Pre-warms the image-proxy cache for the journey recordings; a no-op
  // unless JOURNEY_TARGET is set (see prewarm-images.ts).
  globalSetup: './prewarm-images.ts',
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL,
    // The app reads geolocation continuously; grant it for every context so
    // helpers/geo.ts setGeolocation calls are observed without a prompt.
    permissions: ['geolocation'],
  },
  projects: [
    {
      name: 'checks',
      testDir: './checks',
      fullyParallel: true,
      use: {
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'webkit-render',
      testDir: './checks',
      testMatch: ['hig.spec.ts', 'render-sanity.spec.ts'],
      fullyParallel: true,
      use: {
        // Real iPhone emulation (WebKit engine + UA/DPR/touch); the specs'
        // own test.use viewport (390×844) still applies on top.
        ...devices['iPhone 13'],
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'journeys',
      testDir: './journeys',
      fullyParallel: false,
      use: {
        viewport: { width: 390, height: 844 }, // iPhone-13-ish portrait
        video: { mode: 'on', size: { width: 390, height: 844 } },
        trace: 'off',
      },
    },
  ],
  ...(journeyTarget
    ? {}
    : {
        webServer: {
          // NOTE: `npm run web -- --port 8081` at the repo root does NOT work:
          // npm 9 swallows `--port` as config when forwarding to the nested
          // workspace script and expo receives a bare `8081` as project root.
          // The exec form below forwards args correctly (verified live).
          // CHECKS_STATIC uses e2e/static-server.mjs, NOT `expo serve`:
          // web.output is "single" (SPA) and expo serve 404s every deep link
          // (/search, /object/…) — measured 2026-06-11.
          command: staticChecks
            ? 'node e2e/static-server.mjs 8081'
            : 'npm -w apps/mobile exec -- expo start --web --port 8081',
          cwd: '..',
          url: 'http://localhost:8081',
          timeout: 120_000,
          reuseExistingServer: true,
        },
      }),
});
