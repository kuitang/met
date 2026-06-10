/**
 * Unit tests for the nightly pipeline's pure logic: manifest build/verify and
 * the embedding-index tombstone/compaction (vitest, no network, tmp dirs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  relativeKey,
  sha256File,
  verifyManifestDir,
  type Manifest,
} from "./artifacts.ts";
import {
  applyCompaction,
  imageHash,
  planCompaction,
  type CurrentObject,
  type Index,
} from "./embed-images.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "met-nightly-test-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
describe("manifest build + verify", () => {
  it("round-trips: built manifest verifies against its own dir", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "met.sqlite"), "not really sqlite");
    fs.mkdirSync(path.join(dir, "image-embeddings"));
    fs.writeFileSync(path.join(dir, "image-embeddings", "shard-0.bin"), Buffer.from([1, 2, 3]));
    const m = buildManifest(dir, ["met.sqlite", "image-embeddings/shard-0.bin"], {
      version: "v2026-06-11-abcd1234",
      dataVersion: "2026-06-11-abcd1234",
      builtAt: "2026-06-11T03:30:00Z",
      embeddingModel: "gemini-embedding-2",
    });
    expect(m.files).toHaveLength(2);
    expect(m.files[1].bytes).toBe(3);
    expect(verifyManifestDir(m, dir)).toEqual([]);
  });

  it("flags missing files, size drift, and content drift", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.bin"), "aaaa");
    fs.writeFileSync(path.join(dir, "b.bin"), "bbbb");
    fs.writeFileSync(path.join(dir, "c.bin"), "cccc");
    const m = buildManifest(dir, ["a.bin", "b.bin", "c.bin"], {
      version: "v2026-06-11-x",
      dataVersion: "x",
      builtAt: "now",
      embeddingModel: "m",
    });
    fs.rmSync(path.join(dir, "a.bin")); // missing
    fs.writeFileSync(path.join(dir, "b.bin"), "bbbbb"); // size drift
    fs.writeFileSync(path.join(dir, "c.bin"), "cccd"); // same size, new bytes
    const problems = verifyManifestDir(m, dir);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("a.bin: missing");
    expect(problems[1]).toContain("b.bin: 5 bytes");
    expect(problems[2]).toContain("c.bin: sha256");
  });

  it("tolerates version-prefixed keys via relativeKey", () => {
    const m = {
      version: "v2026-06-10-initial",
      files: [{ key: "v2026-06-10-initial/met.sqlite", sha256: "", bytes: 0 }],
    } as unknown as Manifest;
    expect(relativeKey(m, m.files[0].key)).toBe("met.sqlite");
    expect(relativeKey(m, "image-embeddings/index.json")).toBe("image-embeddings/index.json");
  });

  it("sha256File matches a known digest", () => {
    const dir = tmp();
    const p = path.join(dir, "x");
    fs.writeFileSync(p, "abc");
    expect(sha256File(p)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// ---------------------------------------------------------------------------
// embedding-index compaction
// ---------------------------------------------------------------------------
const DIMS = 4; // tiny vectors; the logic is dimension-agnostic
const SHARD_SIZE = 3;

/** Build an index dir: vectors[row][.] with entries mapping ids to rows. */
function writeIndexDir(
  vectors: number[][],
  objects: Index["objects"],
): { dir: string; idx: Index } {
  const dir = tmp();
  const idx: Index = {
    model: "gemini-embedding-2",
    dims: DIMS,
    normalized: true,
    shardSize: SHARD_SIZE,
    count: vectors.length,
    objects,
  };
  for (let s = 0; s * SHARD_SIZE < vectors.length; s++) {
    const rows = vectors.slice(s * SHARD_SIZE, (s + 1) * SHARD_SIZE);
    fs.writeFileSync(
      path.join(dir, `shard-${s}.bin`),
      Buffer.concat(rows.map((v) => Buffer.from(Float32Array.from(v).buffer))),
    );
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx));
  return { dir, idx };
}

const vec = (seed: number) => [seed, seed + 0.5, -seed, 1];
const entry = (row: number, extra: Partial<Index["objects"][string]> = {}) => ({
  shard: Math.floor(row / SHARD_SIZE),
  offset: row % SHARD_SIZE,
  title: `t${row}`,
  artist: "a",
  gallery: "100",
  ...extra,
});
const cur = (url: string, title = "fresh"): CurrentObject => ({
  title,
  artist: "a",
  gallery: "101",
  imageHash: imageHash(url),
});

function readRow(dir: string, row: number): number[] {
  const buf = fs.readFileSync(path.join(dir, `shard-${Math.floor(row / SHARD_SIZE)}.bin`));
  const off = (row % SHARD_SIZE) * DIMS * 4;
  return [...new Float32Array(buf.buffer, buf.byteOffset + off, DIMS)];
}

describe("planCompaction", () => {
  it("drops off-view ids, changed image hashes, and orphan duplicate rows", () => {
    // 5 rows; ids 1,2,3 reference rows 0,2,4 — rows 1,3 are stale twins (the
    // historical re-embed pattern that left 3,017 duplicates in production).
    const { idx } = writeIndexDir(
      [vec(0), vec(1), vec(2), vec(3), vec(4)],
      {
        1: entry(0, { imageHash: imageHash("u1") }),
        2: entry(2, { imageHash: imageHash("u2") }),
        3: entry(4, { imageHash: imageHash("u3-old") }),
      },
    );
    const current = new Map<number, CurrentObject>([
      [1, cur("u1")], // unchanged → keep
      // 2 is gone from the snapshot → tombstone
      [3, cur("u3-new")], // imageUrl changed → drop (re-embeds later)
    ]);
    const plan = planCompaction(idx, current);
    expect(plan.keep).toEqual([{ row: 0, objectID: 1 }]);
    expect(plan.dropped).toEqual({ offView: 1, imageChanged: 1, orphanRows: 2 });
  });

  it("keeps legacy entries without imageHash (never re-embed the corpus)", () => {
    const { idx } = writeIndexDir([vec(0)], { 7: entry(0) }); // no imageHash
    const plan = planCompaction(idx, new Map([[7, cur("u7")]]));
    expect(plan.keep).toEqual([{ row: 0, objectID: 7 }]);
    expect(plan.dropped).toEqual({ offView: 0, imageChanged: 0, orphanRows: 0 });
  });
});

describe("applyCompaction", () => {
  it("rewrites shards densely, preserves vector bytes, refreshes metadata, backfills imageHash", () => {
    // 7 rows across 3 shards (shardSize 3); keep ids 10,11,12 at rows 1,3,6.
    const vectors = [vec(0), vec(1), vec(2), vec(3), vec(4), vec(5), vec(6)];
    const { dir, idx } = writeIndexDir(vectors, {
      10: entry(1), // legacy, no imageHash
      11: entry(3, { imageHash: imageHash("u11") }),
      12: entry(6, { imageHash: imageHash("u12") }),
      13: entry(5, { imageHash: imageHash("u13") }), // off-view → dropped
    });
    const current = new Map<number, CurrentObject>([
      [10, cur("u10", "Title Ten")],
      [11, cur("u11")],
      [12, cur("u12")],
    ]);
    const plan = planCompaction(idx, current);
    const next = applyCompaction(dir, idx, plan, current);

    expect(next.count).toBe(3);
    // dense rows in old-row order: old rows 1,3,6 → new rows 0,1,2
    expect(readRow(dir, 0)).toEqual(vec(1));
    expect(readRow(dir, 1)).toEqual(vec(3));
    expect(readRow(dir, 2)).toEqual(vec(6));
    expect(next.objects[10]).toMatchObject({
      shard: 0,
      offset: 0,
      title: "Title Ten",
      gallery: "101",
      imageHash: imageHash("u10"), // backfilled
    });
    expect(next.objects[12]).toMatchObject({ shard: 0, offset: 2 });
    expect(next.objects[13]).toBeUndefined();
    // stale shard files past the new tail are gone (3 rows now fit in shard-0)
    expect(fs.existsSync(path.join(dir, "shard-0.bin"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "shard-1.bin"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "shard-2.bin"))).toBe(false);
    // the on-disk index.json is the returned one
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Index;
    expect(onDisk).toEqual(next);
    // shard-0 holds exactly 3 vectors
    expect(fs.statSync(path.join(dir, "shard-0.bin")).size).toBe(3 * DIMS * 4);
  });

  it("spills compacted rows across shard boundaries correctly", () => {
    // 4 keepers with shardSize 3 → shard-0 (3 rows) + shard-1 (1 row)
    const vectors = [vec(0), vec(1), vec(2), vec(3), vec(4), vec(5)];
    const objects: Index["objects"] = {
      1: entry(0, { imageHash: imageHash("u1") }),
      2: entry(2, { imageHash: imageHash("u2") }),
      3: entry(4, { imageHash: imageHash("u3") }),
      4: entry(5, { imageHash: imageHash("u4") }),
    };
    const { dir, idx } = writeIndexDir(vectors, objects);
    const current = new Map<number, CurrentObject>([
      [1, cur("u1")],
      [2, cur("u2")],
      [3, cur("u3")],
      [4, cur("u4")],
    ]);
    const next = applyCompaction(dir, idx, planCompaction(idx, current), current);
    expect(next.count).toBe(4);
    expect(readRow(dir, 3)).toEqual(vec(5)); // row 3 lives in shard-1 offset 0
    expect(next.objects[4]).toMatchObject({ shard: 1, offset: 0 });
    expect(fs.statSync(path.join(dir, "shard-1.bin")).size).toBe(DIMS * 4);
  });

  it("is idempotent: compacting a compacted index is a no-op", () => {
    const vectors = [vec(0), vec(1), vec(2), vec(3)];
    const { dir, idx } = writeIndexDir(vectors, {
      1: entry(0, { imageHash: imageHash("u1") }),
      2: entry(3, { imageHash: imageHash("u2") }),
    });
    const current = new Map<number, CurrentObject>([
      [1, cur("u1")],
      [2, cur("u2")],
    ]);
    const once = applyCompaction(dir, idx, planCompaction(idx, current), current);
    const twicePlan = planCompaction(once, current);
    expect(twicePlan.dropped).toEqual({ offView: 0, imageChanged: 0, orphanRows: 0 });
    const twice = applyCompaction(dir, once, twicePlan, current);
    expect(twice).toEqual(once);
  });
});
