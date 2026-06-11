# MuseWalk

MuseWalk — an unofficial indoor-navigation web/mobile companion app for the Metropolitan Museum of Art. (Brand: "MuseWalk", one word; never display a TLD/domain in UI copy. Infra identifiers — npm package `met-navigator`, Fly app `musewalk` (domain musewalk.app), EAS slug `met-navigator`, bundle ids `com.kuitang.metnav`, `met.sqlite` — keep their names.) npm-workspaces monorepo: `apps/mobile` (Expo SDK 56 + expo-router), `server` (Node + Hono), `shared` (OpenAPI contract), `data` (pipelines + snapshots + evals), `e2e` (Playwright).

## Node version

Use Node >= 22 (nvm has v24.14.0: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`). System Node 20 cannot install: better-sqlite3 12.x ships no prebuild for ABI 115 and this machine has no g++. The committed lockfile/native binary were built under Node 24.

## Run

```sh
npm install                 # root only; single lockfile, everything hoists
npm run web                 # Expo dev server (web) on :8081
npm run export:web          # static web build -> apps/mobile/dist
npm run server              # Hono dev server (tsx watch), default :8787
npm -w server run build && node server/dist/index.js   # prod server (serves /api + apps/mobile/dist)
npm run e2e                 # Playwright "checks" project (starts Expo web itself, stub provider)
npm -w e2e run journeys     # J1-J15 journey videos -> e2e/recordings/ (needs the real-stack boot below)
npm run evals               # data evals -> data/evals/reports/ (exit != 0 on hard failures)
npm -w data run objects|geometry|graph|build-db        # pipelines (objects hydration is hours-long; resumable)
npm -w shared run gen       # regenerate shared/api-types.d.ts from openapi.yaml
npm -w shared test          # vitest: search/routing/positioning (+ scenario simulator)
```

Type checks: `npx tsc --noEmit` inside `apps/mobile`, `server`, `e2e` (and `shared` via its test run).

Real-stack boot (journeys + the gated `dataprovider`/realmap specs run against this):

```sh
npm -w server run build && EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web
GEMINI_API_KEY=$(cat ~/.gemini_key) RATE_LIMIT_RPM=120 RATE_LIMIT_BURST=60 DATA_DIR=$PWD/data PORT=8789 node server/dist/index.js
JOURNEY_TARGET=http://localhost:8789 npm -w e2e run journeys     # then: node e2e/collect-videos.mjs
```

Canonical journey recordings use the LIVE LLM (no `LLM_MOCK` — the videos show the whole app, Gemini included; pennies per run). The same journey suite also passes against an `LLM_MOCK=1` server for free deterministic re-runs.

Vitest gotcha: `describe.skipIf(cond)` marks tests skipped but **still executes the describe body at collection** — any expensive/throwing fixture call at the top of the suite (e.g. `withDb()` opening `data/met.sqlite`) must itself be guarded on the same condition, or checkouts without the artifact crash with SQLITE_CANTOPEN instead of skipping.

E2E notes: if :8081 is busy, point tests at any running instance with `JOURNEY_TARGET=http://localhost:PORT` (skips the managed webServer). `REAL_TARGET=http://localhost:PORT` arms `e2e/checks/dataprovider.spec.ts` (boot recipe in its header). `npm -w server run dev` runs with cwd `server/` — pass an absolute `DATA_DIR`.

## Keys and secrets (never commit)

- `GEMINI_API_KEY` — read from `~/.gemini_key` (`export GEMINI_API_KEY=$(cat ~/.gemini_key)`). Server runs without it but reports `llm: "degraded"`.
- `source ~/openai_key.sh` — OpenAI, legacy/planning benchmarks only; the product uses NO OpenAI.
- `~/expo_key.txt` — EAS token for mobile builds (Phase 3).

Server env: `PORT` (8787), `DATA_DIR` (default `data/`, expects `met.sqlite` + `VERSION`), `DATA_VERSION`, `RATE_LIMIT_RPM` (10), `RATE_LIMIT_BURST` (5), `LLM_DAILY_BUDGET` (2000/UTC-day), `IMG_CACHE_MAX_MB` (512), `IMG_RATE_LIMIT_RPM` (120), `IMG_RATE_LIMIT_BURST` (60), `LLM_MOCK` (1 = deterministic fixtures, no Gemini).

Client env: `EXPO_PUBLIC_API_URL` — API origin override for native builds and web DEV only (metro-web-dev against a separate API server); production web bundles deliberately ignore it (dead-code-eliminated) so the export stays origin-portable — web prod is always same-origin. See `apps/mobile/src/data/apiBase.ts`; `scripts/check-origin-portability.mjs` (`npm run check:origin`) fails the build if an origin-pinned URL lands in `apps/mobile/dist`. `EXPO_PUBLIC_DATA=real` — bundle-time switch to `SqliteDataProvider` (downloads + queries met.sqlite locally); default is the stub provider. `export:web` defaults to real.

## Deploy (LAUNCHED — see DEPLOY_NOTES.md for the operator runbook)

Fly.io app `musewalk` (prod, canonical https://musewalk.app; www + musewalk.fly.dev 301 to apex). Image = web export + Node server serving `dist/` and `/api`; artifacts baked at build from the Tigris `latest/` pointer, no volumes. All changes land as squash PRs (`main` is protected, required check `ci`); the `deploy` job in `ci.yml` ships `main` automatically, `fly-preview.yml` gives every PR a `musewalk-pr-{n}` app, and `nightly-data.yml` (03:23 UTC) refreshes data then redeploys. Mobile: EAS builds from `apps/mobile` (APK via `preview` profile; iOS store builds + TestFlight submit config in `eas.json`).

## Architecture rules (hard)

- **The OpenAPI contract is the only client↔server surface**: `shared/openapi.yaml` (+ generated `shared/api-types.d.ts`). Change the yaml first, regenerate, then implement.
- **LLM = Gemini only**, via `@google/genai`, **all LLM calls server-side** (`server/src/gemini.ts`). No OpenAI SDK, no provider abstractions.
- **Parsimony**: no speculative flexibility, minimal deps, one artifact (`met.sqlite`) not fragments.
- **Update ARCHITECTURE.md in the same commit as any structural change.**
- Web SQLite = official `@sqlite.org/sqlite-wasm`, main-thread in-memory (no SharedArrayBuffer needed) — expo-sqlite's web backend is unusable (no FTS5 in its wasm; sync bridge corrupts results >255 bytes; both measured, see ARCHITECTURE.md). Native = expo-sqlite. Both behind the `apps/mobile/src/data/sqlite.ts` seam.
- The server still sends `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on everything (kept for parity and because the image-proxy design assumes isolation). **Measured 2026-06-10: `images.metmuseum.org` sends NO CORS/CORP headers**, so the Met CDN cannot be embedded under require-corp. **Image bytes bypass the app server on the happy path**: clients load pre-generated derivatives (`objects.thumbKey`, `t320`/`c1080`) from the public Tigris bucket `musewalk-images` with `crossorigin="anonymous"` on web (CORS load satisfies COEP; Tigris sends no CORP header) — see `apps/mobile/src/data/imageCdn.ts` + `apps/mobile/src/components/ObjectImage.tsx` and ARCHITECTURE.md "Images". The server image proxy `GET /api/v1/img/{objectID}` (disk LRU cache, `DATA_DIR/img-cache/`, cap `IMG_CACHE_MAX_MB`, ACAO * + CORP cross-origin, `?v={dataVersion}` cache-buster) is FALLBACK-ONLY: web objects without a thumbKey yet + bucket-fetch errors. Native falls back to direct Met CDN URLs (no COEP); the stub-provider mockup uses direct no-cors `<img>`. Known SDK 56 limit: `expo start` dev mode does not honor `metro.config.js` `server.enhanceMiddleware` headers — use the prod-server boot for real-provider work needing strict header parity.

## Data refresh model

- The server has NO refresh machinery (parsimony). Data refresh = the nightly GitHub Actions job (`.github/workflows/nightly-data.yml`, `data/src/nightly.ts`): Met API delta → incremental embeddings → `build-db.ts` → Tigris upload + verified `latest/` pointer commit → prod redeploy (Docker build bakes the fresh artifacts). Manual retry: `gh workflow run nightly-data.yml`. Clients poll `GET /api/v1/data/version` and re-download via ETag.
- `data/met.sqlite` + `VERSION` are NOT in git — pull via `data/src/fetch-artifacts.ts` or rebuild with `npm -w data run build-db`. The same pipeline code runs locally via the `data` workspace scripts; dated snapshots go in `data/snapshots/`.

## Etiquette (external services)

- **Met Open Access API**: published cap 80 req/s, but an Imperva WAF throttles sustained traffic to ~1.3 req/s effective — **pipelines must stay ≤10 req/s nominal with backoff and resume** (see `docs/DATA.md`). No auth, CC0.
- **Living Map ETL**: reuse the committed raw tiles in the repo; do not re-crawl tile servers.
- **NEVER scrape metmuseum.org** — it is bot-blocked (Vercel checkpoint). Use the Open Access API only.

## Evals

Planning-phase benchmark data + results live in `data/evals/planning-bench/` (see its `RESULTS.md` and `FETCH.md` for regeneration). Image fixture sets for e2e are in `e2e/fixtures/`.
