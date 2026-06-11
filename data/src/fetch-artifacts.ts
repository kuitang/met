/**
 * Pull the data artifacts (met.sqlite + image-embedding shards) from the
 * Tigris bucket into a server-ready DATA_DIR layout, verifying every sha256
 * against the manifest (hard failure on mismatch — used inside `docker build`,
 * a bad pull must fail the image).
 *
 * Output layout (matches what server/src expects of DATA_DIR):
 *   {dest}/met.sqlite
 *   {dest}/VERSION                          (manifest.dataVersion)
 *   {dest}/snapshots/image-embeddings/…     (index.json + shard-*.bin)
 *
 * Usage:
 *   tsx data/src/fetch-artifacts.ts --dest /app/data            # latest/
 *   tsx data/src/fetch-artifacts.ts --dest data --sqlite-only   # CI evals
 *   tsx data/src/fetch-artifacts.ts --dest out --version v2026-06-10-initial
 *
 * Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3,
 *      BUCKET_NAME (see src/artifacts.ts for defaults).
 */
import fs from "node:fs";
import path from "node:path";
import {
  bucketFromEnv,
  downloadArtifacts,
  fetchManifest,
  relativeKey,
  s3FromEnv,
} from "./artifacts.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dest = opt("--dest");
const ref = opt("--version") ?? "latest";
const sqliteOnly = args.includes("--sqlite-only");
if (!dest) {
  console.error("usage: fetch-artifacts --dest <dir> [--version <vKey|latest>] [--sqlite-only]");
  process.exit(2);
}

const s3 = s3FromEnv();
const bucket = bucketFromEnv();

const manifest = await fetchManifest(s3, bucket, ref);
console.log(
  `manifest ${ref} → ${manifest.version} (dataVersion ${manifest.dataVersion}, ` +
    `${manifest.files.length} files, built ${manifest.builtAt})`,
);

// Download into a staging dir in relative-key layout, verify, then arrange.
const stage = path.join(dest, ".fetch-stage");
fs.rmSync(stage, { recursive: true, force: true });
await downloadArtifacts(
  s3,
  bucket,
  manifest,
  stage,
  sqliteOnly ? (rel) => rel === "met.sqlite" : () => true,
);

fs.mkdirSync(dest, { recursive: true });
for (const f of manifest.files) {
  const rel = relativeKey(manifest, f.key);
  const from = path.join(stage, rel);
  if (!fs.existsSync(from)) continue; // filtered out
  const to = rel.startsWith("image-embeddings/")
    ? path.join(dest, "snapshots", rel)
    : path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  console.log(`  ${rel} → ${to} (${f.bytes} bytes, sha256 ok)`);
}
fs.writeFileSync(path.join(dest, "VERSION"), manifest.dataVersion + "\n");
fs.rmSync(stage, { recursive: true, force: true });
console.log(`done: ${dest}/VERSION = ${manifest.dataVersion}`);
