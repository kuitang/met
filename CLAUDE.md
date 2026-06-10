# Met Navigator

Indoor-navigation web/mobile app for the Metropolitan Museum of Art. npm-workspaces monorepo: `apps/mobile` (Expo SDK 56 + expo-router), `server` (Node + Hono), `shared` (OpenAPI contract), `data` (pipelines + snapshots + evals), `e2e` (Playwright).

## Node version

Use Node >= 22 (nvm has v24.14.0: `export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`). System Node 20 cannot install: better-sqlite3 12.x ships no prebuild for ABI 115 and this machine has no g++. The committed lockfile/native binary were built under Node 24.

## Run

```sh
npm install                 # root only; single lockfile, everything hoists
npm run web                 # Expo dev server (web) on :8081
npm run export:web          # static web build -> apps/mobile/dist
npm run server              # Hono dev server (tsx watch), default :8787
npm -w server run build && node server/dist/index.js   # prod server (serves /api + apps/mobile/dist)
npm run e2e                 # Playwright "checks" project (starts Expo web itself)
npm -w e2e run journeys     # journey videos -> e2e/recordings/
npm run evals               # data evals (stub until Gate B/C)
npm -w data run objects|geometry|graph|build-db        # pipelines (stubs until Gate B)
npm -w shared run gen       # regenerate shared/api-types.d.ts from openapi.yaml
```

Type checks: `npx tsc --noEmit` inside `apps/mobile` and `server`.

E2E note: if :8081 is busy, point tests at any running instance with `JOURNEY_TARGET=http://localhost:PORT` (skips the managed webServer).

## Keys and secrets (never commit)

- `GEMINI_API_KEY` — read from `~/.gemini_key` (`export GEMINI_API_KEY=$(cat ~/.gemini_key)`). Server runs without it but reports `llm: "degraded"`.
- `source ~/openai_key.sh` — OpenAI, legacy/planning benchmarks only; the product uses NO OpenAI.
- `~/expo_key.txt` — EAS token for mobile builds (Phase 3).

Server env: `PORT` (8787), `DATA_DIR` (default `data/`, expects `met.sqlite` + `VERSION`), `DATA_VERSION`, `RATE_LIMIT_RPM` (10), `RATE_LIMIT_BURST` (5), `LLM_DAILY_BUDGET` (2000/UTC-day).

## Deploy

Fly.io app name: `met-nav` (not yet created; Phase 3). Image = web export + Node server serving `dist/` and `/api`, 1 GB volume at `/data`.

## Architecture rules (hard)

- **The OpenAPI contract is the only client↔server surface**: `shared/openapi.yaml` (+ generated `shared/api-types.d.ts`). Change the yaml first, regenerate, then implement.
- **LLM = Gemini only**, via `@google/genai`, **all LLM calls server-side** (`server/src/gemini.ts`). No OpenAI SDK, no provider abstractions.
- **Parsimony**: no speculative flexibility, minimal deps, one artifact (`met.sqlite`) not fragments.
- **Update ARCHITECTURE.md in the same commit as any structural change** (once it exists, Phase 2).
- expo-sqlite on web needs SharedArrayBuffer: the server sends `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on everything; external images (Met CDN) need `crossorigin="anonymous"`.

## Data refresh model

- Server runs a nightly self-refresh: Met API delta → rebuild `met.sqlite` → atomic swap (last-known-good kept). Clients poll `GET /api/v1/data/version` and re-download via ETag.
- The same pipeline code is runnable locally via the `data` workspace scripts; dated snapshots go in `data/snapshots/`.

## Etiquette (external services)

- **Met Open Access API**: ≤80 req/s hard cap; pipelines run at ~40 req/s. No auth, CC0.
- **Living Map ETL**: reuse the committed raw tiles in the repo; do not re-crawl tile servers.
- **NEVER scrape metmuseum.org** — it is bot-blocked (Vercel checkpoint). Use the Open Access API only.

## Evals

Planning-phase benchmark data + results live in `data/evals/planning-bench/` (see its `RESULTS.md` and `FETCH.md` for regeneration). Image fixture sets for e2e are in `e2e/fixtures/`.
