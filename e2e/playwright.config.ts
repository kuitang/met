import { defineConfig, devices } from '@playwright/test';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * TIMEOUT BUDGET (enforced by scripts/check-e2e-discipline.mjs)
 *
 * The checks target is a pre-built static export served from disk: it
 * responds in single-digit milliseconds and first paint is bundle-parse
 * time (~1–3 s on a 2-core CI runner). A long timeout therefore only
 * measures something that does not exist. History: CI runs 27312485379 /
 * 27313603005 burned ~25 min each on 62 *identical* 45 s element-not-found
 * timeouts whose root cause (a poisoned export) a 5 s canary would have
 * reported in seconds.
 *
 *   expect      7 s   (15 s when JOURNEY_TARGET points at a remote deploy:
 *                      that pays real network + first-run met.sqlite boot)
 *   action     10 s
 *   navigation 15 s
 *   test       30 s   (journeys project: 240 s — deliberately paced videos)
 *   global      8 min (disabled for journeys: 16 recordings × pacing)
 *
 * Discipline rules (CI-enforced for checks/**):
 *   - no waitForTimeout / sleep — every wait targets an element or condition;
 *   - no per-spec timeout above 10 s;
 *   - exceptions require an inline `e2e-discipline: allow(<why>)` comment
 *     (legitimate cases: synthetic gesture pacing — velocity is a function
 *     of time — and REAL_TARGET specs that download real network bytes).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Projects (see README.md):
 *  - canary:   fail-fast gate — app shell + one stub room must render.
 *              checks/webkit-render DEPEND on it: if the export is broken
 *              the suite aborts in seconds with the real error, instead of
 *              62 cascading timeouts.
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
 * http://localhost:8081 (started automatically via webServer below; the
 * globalSetup probe pre-compiles the Metro bundle so the first test does not
 * pay it — see prewarm-images.ts). Set JOURNEY_TARGET=https://…fly.dev to
 * run the same suite against a deployed app — webServer is skipped entirely
 * in that case. Set CHECKS_STATIC=1 to serve an ALREADY-BUILT static export
 * (apps/mobile/dist) via e2e/static-server.mjs instead of compiling under
 * Metro — used by CI, where the dev-server compile takes ~25 min on a 2-core
 * runner. The dist must be exported with EXPO_PUBLIC_DATA=stub (the checks
 * specs assert stub-provider data); apps/mobile/metro.config.js keys the
 * Metro cache on the EXPO_PUBLIC_* fingerprint, so real→stub flips can no
 * longer poison the export.
 */
const journeyTarget = process.env.JOURNEY_TARGET;
const staticChecks = !!process.env.CHECKS_STATIC;
// E2E_PORT: the suite is only as deterministic as its target — on a machine
// running several agents/dev servers, "whatever answers on :8081" may be
// someone else's app (observed live 2026-06-11: a foreign `expo start --web`
// on :8081 silently served a whole suite run). Static mode therefore never
// reuses an existing server (below) and the port is overridable.
const port = Number(process.env.E2E_PORT ?? 8081);
const baseURL = journeyTarget ?? `http://localhost:${port}`;

export default defineConfig({
  outputDir: 'test-results',
  // Probes the target (compiles the dev bundle / validates the static
  // export) and pre-warms journey images — see prewarm-images.ts.
  globalSetup: './prewarm-images.ts',
  timeout: 30_000,
  // A broken target must fail the JOB in minutes; journeys legitimately run
  // longer (16 paced recordings) and are never part of the CI gate.
  globalTimeout: journeyTarget ? undefined : 8 * 60_000,
  expect: { timeout: journeyTarget ? 15_000 : 7_000 },
  reporter: [['list']],
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    // The app reads geolocation continuously; grant it for every context so
    // helpers/geo.ts setGeolocation calls are observed without a prompt.
    permissions: ['geolocation'],
  },
  projects: [
    {
      name: 'canary',
      testDir: './checks',
      testMatch: 'smoke.spec.ts',
      use: {
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'checks',
      testDir: './checks',
      testIgnore: 'smoke.spec.ts',
      dependencies: ['canary'],
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
      dependencies: ['canary'],
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
      timeout: 240_000,
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
            ? `node e2e/static-server.mjs ${port}`
            : `npm -w apps/mobile exec -- expo start --web --port ${port}`,
          cwd: '..',
          url: baseURL,
          timeout: 120_000,
          // Static mode OWNS its server: reusing whatever already listens on
          // the port means asserting against an unknown app (see E2E_PORT
          // note above — it happened). Dev mode keeps the convenience of
          // pointing at the developer's running `expo start`.
          reuseExistingServer: !staticChecks,
        },
      }),
});
