# MuseWalk deploy notes (runbook)

Operational reference for the launched product. Architecture and pipeline
diagrams live in [ARCHITECTURE.md](ARCHITECTURE.md) ("Deployment & nightly
data pipeline"); this file is the *operator's* page: URLs, tokens, knobs,
and what to click when something breaks.

## Live URLs

| URL | Role |
|---|---|
| https://musewalk.app | canonical (Fly app `musewalk`, org `personal`, region ewr) |
| https://www.musewalk.app | 301 → apex |
| https://musewalk.fly.dev | 301 → apex (canonical-host redirect in the server) |
| https://musewalk.app/api/v1/health | health + dataVersion + llm status |

TLS: both `musewalk.app` and `www.musewalk.app` Fly-managed certs **Issued**
(`flyctl certs list -a musewalk`).

## DNS (configured at the registrar, 2026-06-11)

| Record | Name | Value |
|---|---|---|
| A | `musewalk.app` | `66.241.124.171` |
| AAAA | `musewalk.app` | `2a09:8280:1::125:c612:0` |
| CNAME | `www` | `musewalk.fly.dev` |

## Mobile builds (EAS project `met-navigator`, owner `kuitang`)

- **Android APK** (preview profile, `distribution: internal`, pinned to
  `https://musewalk.app`): install link →
  https://expo.dev/artifacts/eas/MkxtWdq5BgYISuGZjQdbvd33H66nVH_jKIFinK3wPdc.apk
  (build details: https://expo.dev/accounts/kuitang/projects/met-navigator/builds/135ce9a2-d532-48ee-b341-0e19019e0777;
  EAS artifacts expire ~30 days after the build — re-cut for a fresh link). Re-cut:
  `cd apps/mobile && eas build --profile preview --platform android`.
- **iOS / TestFlight** (production profile, bundle `com.kuitang.metnav`):
  **BLOCKED on one Apple click** — the App Store Connect API returns
  `FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED` for every call, so EAS
  cannot create the distribution certificate/profile until the account
  holder accepts the current Apple Developer Program License Agreement:
  1. Sign in at https://appstoreconnect.apple.com as the account holder
     (kuitang42@gmail.com).
  2. Accept the agreement banner on the dashboard, or go to
     **Business** (Agreements, Tax, and Banking) → accept the pending
     **Apple Developer Program License Agreement**. (Equivalent: the
     "Review Agreement" banner at https://developer.apple.com/account —
     if the membership itself lapsed, the same page shows **Renew**.)
  Then build + submit:
  `cd apps/mobile && source ~/.musewalk-asc.env && eas build --platform ios && eas submit --platform ios --latest`.
  `eas.json` carries the submit config (ASC key id/issuer); the ASC API key
  authenticates everything — no Apple-ID login, no device registration.
  First-run gotchas: EAS's "Select your Apple Team Type" prompt is
  interactive-only (pick **Individual**, then it asks for the Apple Team ID
  — developer.apple.com/account → Membership details); after credentials
  exist, `--non-interactive` works. TestFlight internal testing needs a
  one-time group: App Store Connect → MuseWalk → **TestFlight** →
  Internal Testing **+** → create a group and add yourself — testers are
  NOT auto-added; builds appear in the group automatically afterwards.
- `app.json` sets `ITSAppUsesNonExemptEncryption: false` so TestFlight
  builds skip the export-compliance questionnaire.

## Nightly data job

- **What**: `.github/workflows/nightly-data.yml`, cron `23 3 * * *` UTC —
  Met API delta → incremental embeddings → build-db → Tigris upload +
  verified pointer commit (+14-day GC) → `flyctl deploy` (Docker build bakes
  fresh `latest/` artifacts).
- **Watch**: GitHub → Actions → "nightly-data"
  (https://github.com/kuitang/met/actions/workflows/nightly-data.yml).
- **Retry**: the workflow has `workflow_dispatch` — "Run workflow" button on
  that page, or `gh workflow run nightly-data.yml`.
- **Dead-man's switch**: GitHub e-mails the repo owner when a scheduled
  workflow run fails. A failed run never moves the `latest/` pointer, so
  prod keeps serving yesterday's data — failure mode is staleness, not
  corruption.

## Budget / rate knobs (Fly secrets on app `musewalk`)

```sh
flyctl secrets list -a musewalk        # GEMINI_API_KEY, LLM_DAILY_BUDGET, RATE_LIMIT_RPM, RATE_LIMIT_BURST
flyctl secrets set LLM_DAILY_BUDGET=2000 -a musewalk   # LLM calls/UTC-day, 503 budget_exhausted after
flyctl secrets set RATE_LIMIT_RPM=10 RATE_LIMIT_BURST=5 -a musewalk  # per-IP LLM endpoints
```

Other server env (set in fly.toml / defaults, see CLAUDE.md): `IMG_RATE_LIMIT_RPM`,
`IMG_RATE_LIMIT_BURST`, `IMG_CACHE_MAX_MB` (fallback image proxy only).
PR previews get `LLM_DAILY_BUDGET` from the `PREVIEW_GEMINI_BUDGET` GH secret (100/day).

## Token inventory + rotation

| Token | Where | Scope / blast radius | Rotate |
|---|---|---|---|
| `FLY_API_TOKEN` (GH secret) | ci.yml deploy job, nightly-data.yml | app-scoped deploy token for `musewalk` (re-minted 2026-06-11) | `flyctl tokens create deploy -a musewalk`, then `gh secret set FLY_API_TOKEN` |
| `FLY_PREVIEW_TOKEN` (GH secret) | fly-preview.yml | **org-wide** (`personal`) — app creation needs org scope, so a leak can touch every personal Fly app; forked PRs get no secrets, which is the mitigating control | `flyctl tokens create org personal`, `gh secret set FLY_PREVIEW_TOKEN` |
| `TIGRIS_AWS_ACCESS_KEY_ID` / `TIGRIS_AWS_SECRET_ACCESS_KEY` / `TIGRIS_AWS_ENDPOINT` (GH secrets) | nightly + CI/preview Docker build secrets | read/write on the `met-artifacts` bucket | mint new key in Tigris dashboard, update GH secrets |
| `~/.tigris-musewalk-images.env` (local only) | thumbnail pipeline | **admin** keys for the public `musewalk-images` bucket | Tigris dashboard; never put these in GH |
| `GEMINI_API_KEY` (GH secret + Fly secret) | nightly embeddings; prod interpret/photo-locate | Gemini billing | new key at aistudio.google.com, update both places (`gh secret set`, `flyctl secrets set`) |
| `PREVIEW_GEMINI_BUDGET` (GH secret) | fly-preview.yml | not a credential — numeric budget for preview apps | n/a |
| ASC API key `~/AuthKey_2UL86AV6L8.p8` + `~/.musewalk-asc.env` (key id `2UL86AV6L8`) | EAS build/submit | App Manager on the Apple developer account — can upload builds & manage certs | App Store Connect → Users and Access → Integrations → revoke + re-issue, update the two files |
| `~/expo_key.txt` (`EXPO_TOKEN`, local only) | EAS CLI | full access to the `kuitang` Expo account | expo.dev → Access tokens |
| `~/.gemini_key` (local only) | local dev server | same Gemini billing | as above |

## PR-preview workflow (contributors)

Open a PR against `main` → `fly-preview.yml` deploys `musewalk-pr-{n}`
(shared-cpu-1x/512MB, same Dockerfile + Tigris artifact bake, real Gemini key
capped at 100 LLM calls/day) and comments the URL on the PR; the app is
destroyed when the PR closes. Forked PRs get no secrets → no preview (CI
still runs). `main` is protected: squash PRs only, required check `ci`,
linear history, no force-push; deploys happen only via the `deploy` job
after `ci` passes on `main`.
