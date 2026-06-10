/**
 * Tigris artifact-registry helpers shared by the nightly pipeline
 * (src/nightly.ts) and the Docker/CI artifact fetcher (src/fetch-artifacts.ts).
 *
 * Bucket layout (s3://met-artifacts):
 *   v{dataVersion}/met.sqlite
 *   v{dataVersion}/image-embeddings/index.json
 *   v{dataVersion}/image-embeddings/shard-{n}.bin
 *   v{dataVersion}/manifest.json
 *   latest/manifest.json          ← the atomic-commit pointer: a version is
 *                                   live iff this file references it.
 *
 * The manifest carries sha256 + byte size for every file; downloads verify
 * both and FAIL HARD on mismatch (a half-written or corrupted artifact must
 * never reach a Docker image or a deploy).
 *
 * Credentials/config via standard AWS env vars:
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (Tigris key pair)
 *   AWS_ENDPOINT_URL_S3 (default https://fly.storage.tigris.dev)
 *   BUCKET_NAME         (default met-artifacts)
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ManifestFile {
  key: string; // relative to the version prefix, e.g. "image-embeddings/shard-0.bin"
  sha256: string;
  bytes: number;
}

export interface Manifest {
  version: string; // bucket prefix, e.g. "v2026-06-10-2e5aaf37"
  dataVersion: string; // met.sqlite dataVersion (data/VERSION content)
  builtAt: string; // ISO timestamp of the build (delta horizon for the next run)
  embeddingModel: string; // e.g. "gemini-embedding-2"
  files: ManifestFile[];
}

export const DEFAULT_BUCKET = "met-artifacts";
export const DEFAULT_ENDPOINT = "https://fly.storage.tigris.dev";

export function bucketFromEnv(): string {
  return process.env.BUCKET_NAME ?? DEFAULT_BUCKET;
}

export function s3FromEnv(): S3Client {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are required (Tigris key pair)");
  }
  return new S3Client({
    region: "auto",
    endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? DEFAULT_ENDPOINT,
    forcePathStyle: true,
  });
}

export function sha256File(p: string): string {
  const h = createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

/** Some manifests may carry version-prefixed keys; normalize to relative. */
export function relativeKey(manifest: Manifest, key: string): string {
  const prefix = manifest.version.replace(/\/+$/, "") + "/";
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Verify every manifest file against what is on disk under `dir` (laid out by
 * relative key). Returns a list of problems; empty = verified.
 */
export function verifyManifestDir(manifest: Manifest, dir: string): string[] {
  const problems: string[] = [];
  for (const f of manifest.files) {
    const rel = relativeKey(manifest, f.key);
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const bytes = fs.statSync(p).size;
    if (bytes !== f.bytes) {
      problems.push(`${rel}: ${bytes} bytes, manifest says ${f.bytes}`);
      continue;
    }
    const digest = sha256File(p);
    if (digest !== f.sha256) problems.push(`${rel}: sha256 ${digest} != manifest ${f.sha256}`);
  }
  return problems;
}

/** Build a manifest for files under `dir` (relative keys). */
export function buildManifest(
  dir: string,
  relKeys: string[],
  meta: Pick<Manifest, "version" | "dataVersion" | "builtAt" | "embeddingModel">,
): Manifest {
  return {
    ...meta,
    files: relKeys.map((key) => {
      const p = path.join(dir, key);
      return { key, sha256: sha256File(p), bytes: fs.statSync(p).size };
    }),
  };
}

export async function getObjectBuffer(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const c of res.Body as Readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export async function getObjectToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  dest: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(res.Body as Readable, fs.createWriteStream(dest + ".tmp"));
  fs.renameSync(dest + ".tmp", dest);
}

export async function putFile(
  s3: S3Client,
  bucket: string,
  key: string,
  src: string,
  contentType = "application/octet-stream",
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(src),
      ContentType: contentType,
    }),
  );
}

export async function fetchManifest(
  s3: S3Client,
  bucket: string,
  ref = "latest",
): Promise<Manifest> {
  const key = `${ref.replace(/\/+$/, "")}/manifest.json`;
  const buf = await getObjectBuffer(s3, bucket, key);
  const m = JSON.parse(buf.toString("utf8")) as Manifest;
  if (!m.version || !Array.isArray(m.files)) throw new Error(`malformed manifest at ${key}`);
  return m;
}

/**
 * Download manifest files into `dir` (relative-key layout) and verify hashes.
 * Throws on any mismatch. `filter` limits which files are pulled (e.g. CI only
 * needs met.sqlite for the evals).
 */
export async function downloadArtifacts(
  s3: S3Client,
  bucket: string,
  manifest: Manifest,
  dir: string,
  filter: (relKey: string) => boolean = () => true,
): Promise<void> {
  const wanted = manifest.files.filter((f) => filter(relativeKey(manifest, f.key)));
  for (const f of wanted) {
    const rel = relativeKey(manifest, f.key);
    await getObjectToFile(s3, bucket, `${manifest.version}/${rel}`, path.join(dir, rel));
  }
  const problems = verifyManifestDir(
    { ...manifest, files: wanted },
    dir,
  );
  if (problems.length) {
    throw new Error(`artifact verification FAILED:\n  ${problems.join("\n  ")}`);
  }
}

/**
 * Garbage-collect version prefixes older than `keepDays` (by the date embedded
 * in the prefix name, "v{YYYY-MM-DD}-…"). Never touches `latest/` or the
 * version the latest pointer references.
 */
export async function gcOldVersions(
  s3: S3Client,
  bucket: string,
  liveVersion: string,
  keepDays = 14,
  now = new Date(),
): Promise<string[]> {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Delimiter: "/" }),
  );
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const doomed: string[] = [];
  for (const p of res.CommonPrefixes ?? []) {
    const prefix = p.Prefix?.replace(/\/$/, "");
    if (!prefix || prefix === "latest" || prefix === liveVersion) continue;
    const m = /^v(\d{4}-\d{2}-\d{2})/.exec(prefix);
    if (!m) continue;
    if (new Date(m[1] + "T00:00:00Z") < cutoff) doomed.push(prefix);
  }
  for (const prefix of doomed) {
    // list + batch-delete every object under the prefix
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + "/", ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      }
      token = page.NextContinuationToken;
    } while (token);
  }
  return doomed;
}
