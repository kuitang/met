# syntax=docker/dockerfile:1
# Met Navigator production image: static Expo web export + Node API server,
# with the data artifacts (met.sqlite + image-embedding shards) BAKED IN at
# build time from the Tigris bucket — machines have zero runtime bucket deps
# and no volumes; a data refresh reaches prod as a rebuild + deploy
# (.github/workflows/nightly-data.yml).
#
# Build secrets (RUN --mount=type=secret): AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3 — the Tigris key pair.
#   docker build --secret id=AWS_ACCESS_KEY_ID,env=AWS_ACCESS_KEY_ID ...
#   flyctl deploy --build-secret AWS_ACCESS_KEY_ID=... (CI does this)
#
# Build args:
#   ARTIFACT_VERSION    which bucket version to bake (default "latest")
#   ARTIFACT_CACHE_BUST any new value re-pulls artifacts despite layer cache
#                       (CI passes the run id so deploys never bake stale data)

# ---------------------------------------------------------------------------
# Stage 1: install + fetch artifacts + build server and web export
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app
ENV CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Workspace manifests first: npm ci layer survives source-only changes.
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/
COPY server/package.json server/
COPY shared/package.json shared/
COPY data/package.json data/
COPY e2e/package.json e2e/
RUN npm ci

# Pull + sha256-verify the data artifacts from Tigris (fails the build on any
# mismatch). Layout under /artifacts matches the server's DATA_DIR contract:
# met.sqlite, VERSION, snapshots/image-embeddings/*.
COPY data/src/artifacts.ts data/src/fetch-artifacts.ts data/src/
ARG ARTIFACT_VERSION=latest
ARG ARTIFACT_CACHE_BUST=0
RUN --mount=type=secret,id=AWS_ACCESS_KEY_ID \
    --mount=type=secret,id=AWS_SECRET_ACCESS_KEY \
    --mount=type=secret,id=AWS_ENDPOINT_URL_S3 \
    echo "artifact pull (bust=$ARTIFACT_CACHE_BUST)" && \
    AWS_ACCESS_KEY_ID="$(cat /run/secrets/AWS_ACCESS_KEY_ID)" \
    AWS_SECRET_ACCESS_KEY="$(cat /run/secrets/AWS_SECRET_ACCESS_KEY)" \
    AWS_ENDPOINT_URL_S3="$(cat /run/secrets/AWS_ENDPOINT_URL_S3)" \
    npx tsx data/src/fetch-artifacts.ts --dest /artifacts --version "$ARTIFACT_VERSION"

# Source → server dist + static web export (real data provider).
COPY shared/ shared/
COPY server/ server/
COPY apps/mobile/ apps/mobile/
RUN npm -w server run build
RUN EXPO_PUBLIC_DATA=real npm -w apps/mobile run export:web

# ---------------------------------------------------------------------------
# Stage 2: runtime — server prod deps only, dists, baked artifacts, non-root
# ---------------------------------------------------------------------------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data

# curl for the container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Production node_modules for the server workspace (hono, better-sqlite3,
# @google/genai, zod + the @met/shared workspace link).
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/
COPY server/package.json server/
COPY shared/package.json shared/
COPY data/package.json data/
COPY e2e/package.json e2e/
RUN npm ci -w server -w shared --omit=dev && npm cache clean --force

# @met/shared ships as TypeScript source (Node 24 type-stripping executes it);
# server/dist resolves apps/mobile/dist relative to its own path.
COPY --from=build /app/shared/ shared/
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/apps/mobile/dist/ apps/mobile/dist/
COPY --from=build /artifacts/ /app/data/

# Non-root; the image proxy's disk LRU lives at DATA_DIR/img-cache (ephemeral
# in this design — it refills from the Met CDN after each deploy).
RUN chown -R node:node /app/data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/v1/health || exit 1
CMD ["node", "server/dist/index.js"]
