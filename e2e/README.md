# @met/e2e

Playwright suite, four projects: **canary** (`checks/smoke.spec.ts`) is the fail-fast gate — checks and webkit-render *depend* on it, so a broken target aborts the suite in seconds with the one real error instead of dozens of cascading timeouts; **checks** (`npx playwright test --project=checks`) is the fast headless assertion gate — parallel, video/trace only on failure — run after every change; **webkit-render** is the iPhone-engine render guard (hig + render-sanity only); **journeys** (`npm run journeys`, which also collects videos) records always-on 390×844 phone-sized videos of the user-journey specs in `journeys/j{n}-{slug}.spec.ts`, run serially and paced with the `step()` caption helper so the recordings are human-followable.

**Wait discipline (CI-enforced by `scripts/check-e2e-discipline.mjs`):** the checks target serves in milliseconds, so checks specs use the config-level timeout budget (expect 7 s / action 10 s / test 30 s / suite 8 min — documented in `playwright.config.ts`), never `waitForTimeout`, and never a per-spec timeout above 10 s. Waits target elements or conditions (`helpers/settle.ts` for animations); genuinely time-shaped exceptions (gesture velocity pacing, REAL_TARGET network downloads) carry an `e2e-discipline: allow(<why>)` annotation. Journeys are exempt: their pacing is a recording aesthetic.

Checks target `http://localhost:8081` and auto-start the stub-data Expo web dev server (`npm run web` at the repo root; the globalSetup probe pre-compiles the Metro bundle so the budget holds), or a pre-built `apps/mobile/dist` static export with `CHECKS_STATIC=1` (CI mode). **Journeys need the real stack and skip without `JOURNEY_TARGET`** — boot recipe (repo root):

```sh
npm -w server run build
EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
DATA_DIR=$PWD/data LLM_MOCK=1 PORT=8789 node server/dist/index.js &
cd e2e && JOURNEY_TARGET=http://localhost:8789 npm run journeys
```

`JOURNEY_TARGET=https://met-nav.fly.dev` runs the same suite against the deployed app. `@live` journey variants (real Gemini instead of LLM_MOCK) run only with `LLM_LIVE=1` against a non-mock server. After a journeys run, `node collect-videos.mjs` copies each video to `recordings/J{n}-{slug}.webm`. Helpers: `helpers/geo.ts` (simulated walking/GPS), `helpers/steps.ts` (captioned steps), `helpers/journey.ts` (real-stack boot + room taps), `helpers/db.ts` (fixtures read live from `data/met.sqlite`, so journey assertions survive the partial→full hydration); photo fixtures live in `fixtures/`. The app contract: root view exposes `testID="app-root"`.
