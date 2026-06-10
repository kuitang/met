# @met/e2e

Playwright suite with two projects: **checks** (`npx playwright test --project=checks`) is the fast headless assertion gate — parallel, video/trace only on failure — run after every change; **journeys** (`npm run journeys`, which also collects videos) records always-on 390×844 phone-sized videos of the user-journey specs in `journeys/j{n}-{slug}.spec.ts`, run serially and paced with the `step()` caption helper so the recordings are human-followable. Checks target `http://localhost:8081` and auto-start the stub-data Expo web dev server (`npm run web` at the repo root). **Journeys need the real stack and skip without `JOURNEY_TARGET`** — boot recipe (repo root):

```sh
npm -w server run build
EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
DATA_DIR=$PWD/data LLM_MOCK=1 PORT=8789 RUN_REFRESH=0 node server/dist/index.js &
cd e2e && JOURNEY_TARGET=http://localhost:8789 npm run journeys
```

`JOURNEY_TARGET=https://met-nav.fly.dev` runs the same suite against the deployed app. `@live` journey variants (real Gemini instead of LLM_MOCK) run only with `LLM_LIVE=1` against a non-mock server. After a journeys run, `node collect-videos.mjs` copies each video to `recordings/J{n}-{slug}.webm`. Helpers: `helpers/geo.ts` (simulated walking/GPS), `helpers/steps.ts` (captioned steps), `helpers/journey.ts` (real-stack boot + room taps), `helpers/db.ts` (fixtures read live from `data/met.sqlite`, so journey assertions survive the partial→full hydration); photo fixtures live in `fixtures/`. The app contract: root view exposes `testID="app-root"`.
