# Met Navigator

Indoor navigation + collection search for the Metropolitan Museum of Art
(Fifth Avenue + The Cloisters). Expo web/mobile app, Node API server, one
SQLite data artifact every client downloads and queries locally.

- **Docs**: [ARCHITECTURE.md](ARCHITECTURE.md) (system design),
  [CLAUDE.md](CLAUDE.md) (dev commands), `docs/` (data, search, gate reviews).
- **Run it**: `npm install && npm run web` (Node ≥ 22).

## Data artifacts vs. sources

The **Tigris bucket `met-artifacts` is the artifact registry**: built outputs
(`met.sqlite`, the image-embedding shards, a sha256 manifest) live under
versioned `v{date}/` prefixes with an atomic `latest/manifest.json` pointer.
They are **not** in git. Get a local copy:

```sh
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
  npx tsx data/src/fetch-artifacts.ts --dest data
```

or rebuild from sources: `npm -w data run build-db`.

The **reproducible sources stay in git**: `data/snapshots/` (gallery/amenity
geojson, routing graph, LLM synonyms, the objects snapshot) and `data/raw/`
(the one-time Living Map ETL tiles). A nightly GitHub Action
(`nightly-data.yml`) applies the Met API delta, re-embeds only changed images,
rebuilds `met.sqlite`, uploads + verifies a new version, commits the pointer,
and redeploys — the Docker image bakes the artifacts at build time, so
machines have zero runtime bucket dependencies.
