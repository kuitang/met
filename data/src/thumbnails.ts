/**
 * Thumbnail-derivative pipeline → PUBLIC Tigris bucket `musewalk-images`
 * (https://musewalk-images.fly.storage.tigris.dev/) so image bytes reach web
 * clients from edge object storage, NOT through the app server (the
 * /api/v1/img proxy stays only as the fallback for objects without a baked
 * thumbKey). The bucket has CORS `GET/HEAD from *`, so under the app's
 * COOP/COEP (require-corp) pages clients embed with crossorigin="anonymous"
 * (see ARCHITECTURE.md "Images").
 *
 * MULTI-MUSEUM (D11): one run processes one museum's snapshot
 * (`--museum <id>`, default `met`, same registry as synonyms.ts/build-db.ts).
 *
 *   - HARD GATE, independent of any per-record data: only museums in
 *     `IMAGE_DERIVATIVE_MUSEUMS` are ever touched (met, aic, cleveland, smk —
 *     the CC0/PD sources). nga/louvre/vanda images are under restricted
 *     licenses that forbid redistributing derivatives (see registry.ts
 *     `license.images`) — this pipeline must NEVER fetch or upload their
 *     image bytes, so those ids are rejected before the museum arg is even
 *     resolved to a snapshot, not merely filtered by a data field.
 *   - Within an eligible museum, a SECOND gate applies per record:
 *     `imageLicense === 'CC0-1.0'`. Met predates the per-record `imageLicense`
 *     column (it is always '' in the Met snapshot; the whole Met corpus is
 *     CC0) so Met rows are eligible whenever they have an imageUrl. AIC and
 *     Cleveland mix CC0 and rights-reserved rows in the SAME museum (see
 *     sources/aic.ts, sources/cleveland.ts) — only the CC0 rows pass. SMK
 *     mixes public_domain and rights-reserved similarly.
 *
 * For every eligible object with an imageUrl:
 *   - source bytes: data/raw/{museum}-images/{objectID}.jpg (politely
 *     downloaded — ≤10 req/s, browser UA, 403 cooldown — the same
 *     conventions data/src/embed-images.ts uses for the Met CDN, applied
 *     generically since every museum source here serves a direct JPEG URL)
 *     and cached back there.
 *   - derivatives (sharp, EXIF-auto-rotated, metadata stripped):
 *       t320.jpg  — 320 px max-dim, JPEG q75 (list rows / search results)
 *       c1080.jpg — 1080 px max-dim, JPEG q78 (object-detail hero)
 *   - keys are CONTENT-ADDRESSED AND IMMUTABLE FOREVER:
 *       met:      img/{objectID}/{sha256(imageUrl)[:12]}/{t320,c1080}.jpg
 *                 (the Met's pre-existing key format — ~30.6k objects are
 *                 already uploaded under it in production; NOT migrated to
 *                 a museum-prefixed key, no backfill of the existing keys)
 *       others:   img/{museum}/{sourceId}/{sha256(imageUrl)[:12]}/{t320,c1080}.jpg
 *     A changed catalog image changes imageUrl → new hash → new key; clients
 *     never see a stale byte under an old URL. Orphaned old prefixes are
 *     GC'd by the nightly job after 14 days (see runIncremental below).
 *   - uploads carry `Cache-Control: public, max-age=31536000, immutable` +
 *     `Content-Type: image/jpeg`. RESUMABLE: the bucket is listed once per
 *     museum and ids whose both keys already exist are skipped.
 *
 * Output: {snapDirFor(museum)}/thumbs-index.json.gz — { objectID → keyPrefix }
 * (objectID is the FINAL objectID build-db.ts assigns — native for the Met,
 * hashObjectID(museum, sourceId) for everyone else — so build-db.ts's
 * per-museum loop can look an entry up directly by the row it is about to
 * write). build-db.ts bakes it into objects.thumbKey so clients construct
 *   {PUBLIC_BASE}/{thumbKey}/{variant}.jpg
 * deterministically — no onError guessing; empty thumbKey ⇒ use the proxy.
 *
 * Usage (Node 24):
 *   source ~/.tigris-musewalk-images.env  # AWS_ACCESS_KEY_ID/SECRET/ENDPOINT/BUCKET_NAME
 *   npx tsx data/src/thumbnails.ts                        # met (full/resumable)
 *   npx tsx data/src/thumbnails.ts --museum aic            # another registry museum
 *   npx tsx data/src/thumbnails.ts --museum aic --limit 50 # smoke test (index NOT written)
 *   THUMBS_BUCKET overrides the bucket name (default musewalk-images, i.e.
 *   BUCKET_NAME in the credentials file); AWS_ENDPOINT_URL_S3 defaults to
 *   https://fly.storage.tigris.dev. MET_DATA_DIR overrides the data root like
 *   build-db.ts / embed-images.ts / synonyms.ts.
 *
 * NIGHTLY INTEGRATION (future work, not wired yet): `runIncremental` is ready
 * to be called from nightly.ts between the objects delta and build-db, one
 * museum at a time, exactly like the Met-only design this pipeline
 * generalizes. GC (nightly's job, NOT here): list `img/`, delete keys whose
 * prefix is not referenced by any museum's current committed index AND whose
 * LastModified is older than 14 days.
 */
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { museumInfo, snapDirFor } from "./sources/registry.ts";
import type { ObjectRow } from "./sources/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_ROOT = process.env.MET_DATA_DIR ? path.resolve(process.env.MET_DATA_DIR) : path.join(ROOT, "data");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
export const MUSEUM_ID = flag("--museum") ?? "met";

/** HARD GATE, independent of any per-record field: only CC0/PD sources are
 * ever fetched/uploaded. nga/louvre/vanda images carry restricted licenses
 * that forbid redistributing derivatives (registry.ts license.images ''). */
export const IMAGE_DERIVATIVE_MUSEUMS = new Set(["met", "aic", "cleveland", "smk"]);
if (!IMAGE_DERIVATIVE_MUSEUMS.has(MUSEUM_ID)) {
  throw new Error(
    `thumbnails.ts: museum "${MUSEUM_ID}" is not in IMAGE_DERIVATIVE_MUSEUMS — its image license ` +
      `(registry.ts) forbids redistributing derivatives; this pipeline must never fetch/upload its images.`,
  );
}

const SNAP_DIR = snapDirFor(MUSEUM_ID);
const SNAPSHOT = path.join(SNAP_DIR, "objects.json.gz");
const INDEX_OUT = path.join(SNAP_DIR, "thumbs-index.json.gz");
// Museum-keyed source cache, same directory-per-museum convention as
// data/src/sources/*/objects-cache.ndjson (gitignored: data/raw/*-images/).
const IMG_CACHE = path.join(ROOT, "data/raw", `${MUSEUM_ID}-images`);

export const THUMBS_BUCKET = process.env.THUMBS_BUCKET ?? process.env.BUCKET_NAME ?? "musewalk-images";
export const THUMBS_PUBLIC_BASE = `https://${THUMBS_BUCKET}.fly.storage.tigris.dev`;
const ENDPOINT = process.env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev";

/** The two derivatives every object gets. Quality/size locked by design. */
const VARIANTS = [
  { file: "t320.jpg", maxDim: 320, quality: 75 },
  { file: "c1080.jpg", maxDim: 1080, quality: 78 },
] as const;

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const UPLOAD_WORKERS = 12;

/** 48-bit objectID from museum-scoped sourceId — MUST stay identical to
 * build-db.ts's hashObjectID (duplicated, not imported: build-db.ts runs its
 * whole pipeline as an import side effect, so importing it here would kick
 * off an unwanted rebuild). Met keeps its native numeric objectID. */
function hashObjectID(museum: string, sourceId: string): number {
  const h = createHash("sha256").update(`${museum}/${sourceId}`).digest();
  return h.readUIntBE(0, 6);
}

/** keyPrefix for an object: the Met's pre-existing format is bare
 * `img/{objectID}/{hash12}` (already live in production, not migrated);
 * every other museum gets `img/{museum}/{sourceId}/{hash12}`. */
export function keyPrefixFor(museum: string, sourceId: string, imageUrl: string): string {
  const hash = createHash("sha256").update(imageUrl).digest("hex").slice(0, 12);
  return museum === "met" ? `img/${sourceId}/${hash}` : `img/${museum}/${sourceId}/${hash}`;
}

export type ThumbsIndex = Record<string, string>; // objectID (string) → keyPrefix

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// snapshot + gate
// ---------------------------------------------------------------------------
interface ObjMeta {
  objectID: number; // FINAL objectID (build-db.ts's hashObjectID for non-met)
  sourceId: string;
  imageUrl: string;
}

/** Only imageUrl + (met OR imageLicense === 'CC0-1.0') rows pass — the
 * per-record half of the hard gate described in the file header. */
function eligible(o: ObjectRow): boolean {
  if (!o.imageUrl) return false;
  if (MUSEUM_ID === "met") return true; // Met's imageLicense column predates the registry; whole corpus is CC0
  return o.imageLicense === "CC0-1.0";
}

function loadSnapshot(): ObjMeta[] {
  const rows = JSON.parse(gunzipSync(fs.readFileSync(SNAPSHOT)).toString()) as ObjectRow[];
  const out: ObjMeta[] = [];
  let rejectedByLicense = 0;
  for (const r of rows) {
    if (!r.imageUrl) continue;
    if (!eligible(r)) {
      rejectedByLicense++;
      continue;
    }
    const sourceId = r.sourceId ?? String(r.objectID);
    const objectID = MUSEUM_ID === "met" ? r.objectID : hashObjectID(MUSEUM_ID, sourceId);
    out.push({ objectID, sourceId, imageUrl: r.imageUrl });
  }
  if (MUSEUM_ID !== "met" && rejectedByLicense > 0) {
    console.log(`imageLicense gate: ${rejectedByLicense} rows with an image but no CC0-1.0 imageLicense skipped`);
  }
  return out;
}

// ---------- polite download (same conventions as embed-images.ts's Met CDN fetch) ----------
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let lastImgCall = 0;
let imgCooldownUntil = 0;
async function sourceBytes(meta: ObjMeta): Promise<Buffer | null> {
  const cache = path.join(IMG_CACHE, `${meta.objectID}.jpg`);
  if (fs.existsSync(cache)) {
    const buf = fs.readFileSync(cache);
    if (buf.length > 0) return buf;
  }
  for (let a = 0; ; a++) {
    const cool = imgCooldownUntil - Date.now();
    if (cool > 0) await sleep(cool);
    const wait = lastImgCall + 100 - Date.now(); // ≤10 req/s, polite default for any source CDN
    if (wait > 0) await sleep(wait);
    lastImgCall = Date.now();
    try {
      const r = await fetch(meta.imageUrl, { headers: { "user-agent": BROWSER_UA } });
      if (r.status === 404) return null;
      if (r.status === 403) {
        imgCooldownUntil = Math.max(imgCooldownUntil, Date.now() + 20_000);
        throw new Error("403");
      }
      if (!r.ok) throw new Error(`image ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(cache, buf);
      return buf;
    } catch (e) {
      if (a >= 3) {
        console.warn(`source ${meta.objectID} failed: ${e}`);
        return null;
      }
      await sleep(1000 * 2 ** a);
    }
  }
}

// ---------- bucket ----------
function s3(): S3Client {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (musewalk-images key pair) required");
  }
  return new S3Client({ region: "auto", endpoint: ENDPOINT });
}

/** Existing keys under this museum's key prefix (one paginated LIST — resume
 * + verify). Met's format has no museum segment, so its prefix is the bucket-
 * wide `img/` (a superset including other museums' keys — harmless, only
 * used for membership checks against fully-known candidate keys). */
async function listExistingKeys(client: S3Client): Promise<Set<string>> {
  const prefix = MUSEUM_ID === "met" ? "img/" : `img/${MUSEUM_ID}/`;
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: THUMBS_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) keys.add(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ---------- core run ----------
export interface RunStats {
  generated: number; // objects whose derivatives were produced+uploaded this run
  skippedExisting: number; // both keys already in the bucket
  missingSource: number; // no cached file and CDN refused (404/403/persistent error)
  uploadedBytes: number;
  index: ThumbsIndex;
}

/**
 * Generate + upload derivatives for `objects`, skipping prefixes whose two
 * keys already exist, and return the index of verified-complete entries.
 */
export async function processObjects(objects: ObjMeta[], limit = Infinity): Promise<RunStats> {
  const client = s3();
  console.log(`listing existing ${MUSEUM_ID} keys in s3://${THUMBS_BUCKET}/img/… `);
  const existing = await listExistingKeys(client);
  console.log(`${existing.size} keys already in the bucket`);

  const stats: RunStats = { generated: 0, skippedExisting: 0, missingSource: 0, uploadedBytes: 0, index: {} };

  const todo: Array<{ meta: ObjMeta; prefix: string }> = [];
  for (const meta of objects) {
    const prefix = keyPrefixFor(MUSEUM_ID, meta.sourceId, meta.imageUrl);
    if (VARIANTS.every((v) => existing.has(`${prefix}/${v.file}`))) {
      stats.skippedExisting++;
      stats.index[meta.objectID] = prefix;
    } else if (todo.length < limit) {
      todo.push({ meta, prefix });
    }
  }
  console.log(`${objects.length} eligible objects → ${todo.length} to generate`);

  let done = 0;
  const t0 = Date.now();
  const queue = [...todo];
  const workers = Array.from({ length: UPLOAD_WORKERS }, async () => {
    while (queue.length) {
      const { meta, prefix } = queue.shift()!;
      try {
        const src = await sourceBytes(meta);
        if (!src) {
          stats.missingSource++;
          continue;
        }
        for (const v of VARIANTS) {
          const key = `${prefix}/${v.file}`;
          if (existing.has(key)) continue; // half-finished prefix from a killed run
          const buf = await sharp(src)
            .rotate() // bake EXIF orientation in — metadata is stripped below
            .resize(v.maxDim, v.maxDim, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: v.quality }) // sharp strips metadata by default
            .toBuffer();
          await client.send(
            new PutObjectCommand({
              Bucket: THUMBS_BUCKET,
              Key: key,
              Body: buf,
              ContentType: "image/jpeg",
              CacheControl: CACHE_CONTROL,
            }),
          );
          stats.uploadedBytes += buf.length;
        }
        stats.index[meta.objectID] = prefix;
        stats.generated++;
        if (++done % 500 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          console.log(
            `${done}/${todo.length} (${rate.toFixed(1)}/s, ${(stats.uploadedBytes / 1e6).toFixed(0)} MB up)`,
          );
        }
      } catch (e) {
        console.warn(`thumbs ${meta.objectID} failed: ${e}`);
        stats.missingSource++;
      }
    }
  });
  await Promise.all(workers);
  return stats;
}

/**
 * NIGHTLY HOOK (not wired yet — see file header): `prevIndex` = the previous
 * build's thumbs-index for this museum. Only objects whose desired keyPrefix
 * is NOT already in prevIndex are touched (new objects or changed imageUrl ⇒
 * new content hash); the LIST inside processObjects then makes even that
 * idempotent. Writes the refreshed thumbs-index.json.gz and returns it.
 */
export async function runIncremental(prevIndex: ThumbsIndex): Promise<ThumbsIndex> {
  const all = loadSnapshot();
  const changed = all.filter(
    (o) => prevIndex[o.objectID] !== keyPrefixFor(MUSEUM_ID, o.sourceId, o.imageUrl),
  );
  console.log(`thumbnails[${MUSEUM_ID}]: ${changed.length} new/changed of ${all.length}`);
  const stats = await processObjects(changed);
  const current = new Map(all.map((o) => [String(o.objectID), o]));
  const index: ThumbsIndex = { ...stats.index };
  for (const [id, prefix] of Object.entries(prevIndex)) {
    const cur = current.get(id);
    if (cur && keyPrefixFor(MUSEUM_ID, cur.sourceId, cur.imageUrl) === prefix) index[id] = prefix;
  }
  writeIndex(index);
  return index;
}

export function writeIndex(index: ThumbsIndex): void {
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => Number(a) - Number(b)));
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(INDEX_OUT + ".tmp", gzipSync(JSON.stringify(sorted), { level: 9 }));
  fs.renameSync(INDEX_OUT + ".tmp", INDEX_OUT);
  console.log(`wrote ${INDEX_OUT} (${Object.keys(sorted).length} entries)`);
}

export function readIndex(): ThumbsIndex {
  if (!fs.existsSync(INDEX_OUT)) return {};
  return JSON.parse(gunzipSync(fs.readFileSync(INDEX_OUT)).toString());
}

// ---------- CLI ----------
async function main() {
  fs.mkdirSync(IMG_CACHE, { recursive: true });
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;

  console.log(`museum: ${MUSEUM_ID} (${museumInfo(MUSEUM_ID).name})`);
  const objects = loadSnapshot();
  const stats = await processObjects(objects, limit);
  if (limit === Infinity) writeIndex(stats.index);
  else console.log("(--limit run: thumbs-index.json.gz NOT written)");
  console.log(
    `done: generated ${stats.generated}, already-in-bucket ${stats.skippedExisting}, ` +
      `missing-source ${stats.missingSource}, uploaded ${(stats.uploadedBytes / 1e6).toFixed(1)} MB, ` +
      `index entries ${Object.keys(stats.index).length}`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
