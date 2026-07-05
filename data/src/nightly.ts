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
import { sourceFor } from "./sources/registry.ts";
import type { ObjectRow } from "./sources/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_SNAP = path.join(REPO_ROOT, "data", "snapshots");
const WORK = process.env.NIGHTLY_WORK_DIR ?? path.join(REPO_ROOT, "data", ".nightly");

/**
 * Reconstruct snapshots/objects.json.gz from last night's met.sqlite — the
 * bucket artifact IS the durable objects state (the git copy is just the
 * bootstrap snapshot). Exported for the unit tests.
 */
export function exportObjectsFromDb(dbPath: string): ObjectRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT objectID, accession, title, artist, culture, period, classification,
                medium, tags, galleryNumber, site, rotation, isHighlight, imageUrl,
                metadataDate
         FROM objects ORDER BY objectID`,
      )
      .all() as Array<Omit<ObjectRow, "isHighlight"> & { isHighlight: number }>;
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
  const rows = exportObjectsFromDb(path.join(pulled, "met.sqlite"));
  fs.writeFileSync(path.join(snapDir, "objects.json.gz"), zlib.gzipSync(JSON.stringify(rows)));
  console.log(`exported ${rows.length} object rows from ${prev.version}/met.sqlite`);

  // ---- 2. Met API delta (via the source adapter) ---------------------------
  const since = prev.builtAt.slice(0, 10);
  const hydrated = await sourceFor("met").delta(snapDir, since);

  // ---- 3. synonyms top-up (incremental, catalog-new vocab only) ------------
  try {
    await runPipeline("synonyms.ts", { MET_DATA_DIR: stage });
  } catch (err) {
    console.warn("synonyms top-up failed (non-fatal — synonyms go one day stale):", err);
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
      `${hydrated} objects hydrated, dataVersion ${dataVersion}`,
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
