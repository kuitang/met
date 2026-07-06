/**
 * Nightly data pipeline (run by .github/workflows/nightly-data.yml; also
 * locally runnable with the same env). Replaces the old in-server refresh —
 * data now reaches prod exclusively via this job + a Docker rebuild/deploy.
 *
 * Locked steps:
 *   1. Pull last night's artifacts from Tigris latest/ (manifest-verified):
 *      met.sqlite is the durable objects state, the image-embedding shards are
 *      the durable embedding cache (the corpus is NEVER re-embedded).
 *   2. Met API delta (objects?metadataDate= since the last build, ∩ on-view,
 *      ≤10 req/s with WAF-aware backoff) → fresh snapshots/objects.json.gz.
 *      Geometry/graph/synonyms baselines come from the git checkout (they are
 *      reproducible sources; gallery walls don't move nightly).
 *   3. Synonyms top-up (incremental; only catalog-new vocab hits Gemini).
 *   4. Embeddings: tombstone + compaction (drop vectors whose objectID is gone
 *      or whose imageUrl hash changed; reclaim the known stale-twin rows),
 *      then embed ONLY new/changed images (content-addressed by objectID +
 *      sha256(imageUrl) + model) — ~tens per day.
 *   5. build-db.ts → met.sqlite (its internal verify gate runs in-process).
 *   6. Upload v{dataVersion}/ to Tigris → re-download and verify every sha256
 *      → only then PUT latest/manifest.json (the atomic commit) → GC version
 *      prefixes older than 14 days.
 *
 * The deploy that bakes the new artifacts into the prod image happens in the
 * workflow after this script exits 0. Any failure exits non-zero — GitHub
 * emails the repo owner on scheduled-workflow failure (dead-man's switch).
 *
 * Env: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL_S3 /
 *      BUCKET_NAME (Tigris; see src/artifacts.ts), GEMINI_API_KEY (required:
 *      synonyms + embeddings), NIGHTLY_WORK_DIR (default data/.nightly).
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import {
  bucketFromEnv,
  downloadArtifacts,
  fetchManifest,
  gcOldVersions,
  getObjectBuffer,
  putFile,
  s3FromEnv,
  sha256File,
  verifyManifestDir,
  type Manifest,
} from "./artifacts.ts";
import { MUSEUMS, sourceFor } from "./sources/registry.ts";
import type { ObjectRow } from "./sources/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_SNAP = path.join(REPO_ROOT, "data", "snapshots");
const WORK = process.env.NIGHTLY_WORK_DIR ?? path.join(REPO_ROOT, "data", ".nightly");

const V1_COLS = `objectID, accession, title, artist, culture, period, classification,
                medium, tags, galleryNumber, site, rotation, isHighlight, imageUrl,
                metadataDate`;
const V2_COLS = `${V1_COLS}, museum, sourceId, locationNote, titleAlt, license, imageLicense`;

/**
 * Reconstruct a museum's snapshots/objects.json.gz rows from last night's
 * artifact — the bucket artifact IS the durable objects state (the git copy
 * is just the bootstrap snapshot). Schema-v2-aware: the multi-museum columns
 * round-trip when present (losing sourceId/license across a nightly would
 * corrupt non-Met rows); a pre-v2 artifact yields v1 rows, all Met.
 * Exported for the unit tests.
 */
export function exportObjectsFromDb(dbPath: string, museum = "met"): ObjectRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const isV2 =
      (
        db
          .prepare(`SELECT count(*) AS n FROM pragma_table_info('objects') WHERE name = 'museum'`)
          .get() as { n: number }
      ).n > 0;
    const rows = (
      isV2
        ? db.prepare(`SELECT ${V2_COLS} FROM objects WHERE museum = ? ORDER BY objectID`).all(museum)
        : museum === "met"
          ? db.prepare(`SELECT ${V1_COLS} FROM objects ORDER BY objectID`).all()
          : []
    ) as Array<Omit<ObjectRow, "isHighlight"> & { isHighlight: number }>;
    return rows.map((r) => ({ ...r, isHighlight: Boolean(r.isHighlight) }));
  } finally {
    db.close();
  }
}

/** Child tsx runner for the sibling pipeline scripts. */
function runPipeline(script: string, env: Record<string, string>, extraArgs: string[] = []): Promise<void> {
  const scriptPath = path.join(REPO_ROOT, "data", "src", script);
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [scriptPath, ...extraArgs], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)),
    );
  });
}

/** Relative bucket keys for a built stage dir (met.sqlite + embeddings). */
export function stageRelKeys(stageDir: string): string[] {
  const keys = ["met.sqlite"];
  const embDir = path.join(stageDir, "snapshots", "image-embeddings");
  for (const f of fs.readdirSync(embDir).sort()) {
    if (f === "index.json" || /^shard-\d+\.bin$/.test(f)) keys.push(`image-embeddings/${f}`);
  }
  return keys;
}

/** Stage layout → bucket layout: embeddings live under snapshots/ on disk. */
export function stagePathForKey(stageDir: string, relKey: string): string {
  return relKey.startsWith("image-embeddings/")
    ? path.join(stageDir, "snapshots", relKey)
    : path.join(stageDir, relKey);
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required (synonyms top-up + image embeddings)");
  }
  const s3 = s3FromEnv();
  const bucket = bucketFromEnv();
  const t0 = Date.now();

  // ---- 1. pull last night's artifacts -------------------------------------
  const prev = await fetchManifest(s3, bucket, "latest");
  console.log(`latest → ${prev.version} (dataVersion ${prev.dataVersion}, built ${prev.builtAt})`);
  fs.rmSync(WORK, { recursive: true, force: true });
  const pulled = path.join(WORK, "pulled");
  await downloadArtifacts(s3, bucket, prev, pulled);
  console.log(`pulled + verified ${prev.files.length} files`);

  // ---- stage dir: bucket state + git-snapshot baselines --------------------
  const stage = path.join(WORK, "stage");
  const snapDir = path.join(stage, "snapshots");
  fs.mkdirSync(snapDir, { recursive: true });
  for (const f of ["galleries.geojson", "amenities.geojson", "graph.json", "synonyms.json"]) {
    fs.copyFileSync(path.join(GIT_SNAP, f), path.join(snapDir, f));
  }
  fs.cpSync(path.join(pulled, "image-embeddings"), path.join(snapDir, "image-embeddings"), {
    recursive: true,
  });
  const rows = exportObjectsFromDb(path.join(pulled, "met.sqlite"), "met");
  fs.writeFileSync(path.join(snapDir, "objects.json.gz"), zlib.gzipSync(JSON.stringify(rows)));
  console.log(`exported ${rows.length} met rows from ${prev.version}/met.sqlite`);

  // ---- 2. per-museum source refresh ----------------------------------------
  // Each museum's snapshots refresh independently with failure isolation: a
  // failing source keeps that museum's rows reconstructed from last night's
  // artifact (stale by one day, logged) and the build proceeds. Met refreshes
  // via metadataDate delta into stage/snapshots; every other museum lives at
  // stage/museums/{id}/snapshots (the build-db MET_DATA_DIR-relative layout).
  const since = prev.builtAt.slice(0, 10);
  let hydrated = 0;
  const museumFailures: string[] = [];
  try {
    hydrated = await sourceFor("met").delta(snapDir, since);
  } catch (err) {
    museumFailures.push("met");
    console.error("met delta FAILED (met rows go one day stale):", err);
  }
  for (const m of MUSEUMS) {
    if (m.id === "met") continue;
    const mSnap = path.join(stage, "museums", m.id, "snapshots");
    fs.mkdirSync(mSnap, { recursive: true });
    // Layer 1: the git-committed snapshot dir — the local harvest that
    // onboarded the museum plus its side files (vocab.json, and for
    // translateFrom museums the translations.json cache, without which the
    // 3b top-up would re-translate the whole corpus every night).
    const gitMuseumSnap = path.join(REPO_ROOT, "data", "museums", m.id, "snapshots");
    if (fs.existsSync(gitMuseumSnap)) fs.cpSync(gitMuseumSnap, mSnap, { recursive: true });
    // Layer 2: reconstruct last night's rows + gallery labels from the pulled
    // artifact, overwriting the (older) git baseline: they are (a) the
    // baseline a delta-capable source refreshes in place — critical for the
    // Louvre, whose fullFetch is a ~26.6k-request hydration — and (b) the
    // stale-but-present fallback if tonight's source pull fails.
    const prevRows = exportObjectsFromDb(path.join(pulled, "met.sqlite"), m.id);
    if (prevRows.length > 0) {
      fs.writeFileSync(
        path.join(mSnap, "objects.json.gz"),
        zlib.gzipSync(JSON.stringify(prevRows)),
      );
      const db = new Database(path.join(pulled, "met.sqlite"), { readonly: true });
      try {
        const sites = new Set(m.sites.map((s) => s.siteId));
        const gals = (
          db.prepare(`SELECT galleryNumber, title, floor, site FROM galleries`).all() as Array<{
            galleryNumber: string;
            title: string | null;
            floor: string | null;
            site: string;
          }>
        ).filter((g) => sites.has(g.site));
        fs.writeFileSync(path.join(mSnap, "galleries.json"), JSON.stringify(gals, null, 2));
      } finally {
        db.close();
      }
    }
    // The nightly NEVER fullFetches — measured 2026-07-06: the old
    // first-night fullFetch fallback spent 3.8 h of the 6 h Actions job
    // crawling the bot-walled Louvre before dying, EVERY night (the failure
    // ships the museum empty, so prevRows stays 0), and a Rijksmuseum first
    // night (~6 h) would have timed out the whole job, shipping nothing.
    // Onboarding is local-first: run the adapter's harvest on a dev machine
    // and COMMIT the snapshot (layer 1 above); the first nightly after that
    // deltas from the committed harvest's own fetchedAt, and once its rows
    // are in an uploaded artifact layer 2 takes over.
    let deltaSince = since;
    if (prevRows.length === 0) {
      if (!fs.existsSync(path.join(mSnap, "objects.json.gz"))) {
        museumFailures.push(m.id);
        console.error(
          `${m.id}: no rows in the previous artifact and no committed snapshot — ships empty tonight (onboard locally: harvest + commit data/museums/${m.id}/snapshots)`,
        );
        continue;
      }
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(mSnap, "objects-meta.json"), "utf8"),
        ) as { fetchedAt?: string };
        if (meta.fetchedAt) deltaSince = meta.fetchedAt.slice(0, 10);
      } catch {
        // no meta — delta since last night, same as an already-onboarded museum
      }
      console.log(`${m.id}: onboarding from the committed snapshot (delta since ${deltaSince})`);
    }
    try {
      await sourceFor(m.id).delta(mSnap, deltaSince);
    } catch (err) {
      museumFailures.push(m.id);
      console.error(`${m.id} refresh FAILED — shipping last night's rows (one day stale):`, err);
    }
  }

  // ---- 3. synonyms top-up (incremental, catalog-new vocab only) ------------
  try {
    await runPipeline("synonyms.ts", { MET_DATA_DIR: stage });
  } catch (err) {
    console.warn("synonyms top-up failed (non-fatal — synonyms go one day stale):", err);
  }

  // ---- 3b. translation top-up (museums with translateFrom; incremental —
  // only snapshot-NEW strings hit the API; DeepSeek via OpenRouter, the
  // Kui-approved pipeline-only exception to the Gemini rule) ---------------
  for (const m of MUSEUMS) {
    if (!m.translateFrom) continue;
    try {
      await runPipeline("translate.ts", { MET_DATA_DIR: stage }, ["--museum", m.id]);
    } catch (err) {
      console.warn(`${m.id} translation top-up failed (non-fatal — new rows stay untranslated):`, err);
    }
  }

  // ---- 4. embeddings: compact (tombstones + stale twins) then embed delta --
  await runPipeline("embed-images.ts", { MET_DATA_DIR: stage }, ["--compact"]);
  await runPipeline("embed-images.ts", { MET_DATA_DIR: stage });

  // ---- 5. build met.sqlite (build-db's verify gate runs inside) ------------
  await runPipeline("build-db.ts", { MET_DATA_DIR: stage });
  const dataVersion = fs.readFileSync(path.join(stage, "VERSION"), "utf8").trim();
  const version = `v${dataVersion}`;
  if (version === prev.version) {
    console.log(`dataVersion unchanged (${dataVersion}) — uploading anyway (same content keys)`);
  }

  // ---- 6. upload → readback-verify → commit pointer → GC -------------------
  const relKeys = stageRelKeys(stage);
  const embIndex = JSON.parse(
    fs.readFileSync(path.join(snapDir, "image-embeddings", "index.json"), "utf8"),
  ) as { model: string };
  const manifest: Manifest = {
    version,
    dataVersion,
    builtAt: new Date().toISOString(),
    embeddingModel: embIndex.model,
    files: relKeys.map((key) => {
      const p = stagePathForKey(stage, key);
      return { key, sha256: sha256File(p), bytes: fs.statSync(p).size };
    }),
  };

  for (const f of manifest.files) {
    await putFile(s3, bucket, `${version}/${f.key}`, stagePathForKey(stage, f.key));
    console.log(`uploaded ${version}/${f.key} (${f.bytes} bytes)`);
  }
  const manifestPath = path.join(stage, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await putFile(s3, bucket, `${version}/manifest.json`, manifestPath, "application/json");

  // readback-verify EVERYTHING before the pointer moves
  const verifyDir = path.join(WORK, "verify");
  await downloadArtifacts(s3, bucket, manifest, verifyDir);
  const problems = verifyManifestDir(manifest, verifyDir);
  if (problems.length) throw new Error(`readback verification failed:\n${problems.join("\n")}`);
  console.log(`readback-verified ${manifest.files.length} files`);

  // atomic commit
  await putFile(s3, bucket, "latest/manifest.json", manifestPath, "application/json");
  const committed = JSON.parse(
    (await getObjectBuffer(s3, bucket, "latest/manifest.json")).toString("utf8"),
  ) as Manifest;
  if (committed.version !== version) {
    throw new Error(`pointer commit readback mismatch: ${committed.version} != ${version}`);
  }
  console.log(`committed latest → ${version}`);

  const gone = await gcOldVersions(s3, bucket, version, 14);
  if (gone.length) console.log(`GC'd old versions: ${gone.join(", ")}`);

  console.log(
    `nightly done in ${Math.round((Date.now() - t0) / 1000)}s — ` +
      `${hydrated} met objects hydrated, dataVersion ${dataVersion}` +
      (museumFailures.length ? ` — STALE (source refresh failed): ${museumFailures.join(", ")}` : ""),
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error("nightly: FAILED (latest/ pointer untouched):", err);
    process.exit(1);
  });
}
