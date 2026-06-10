/**
 * met.sqlite acquisition + the openDb() seam — WEB backend.
 *
 * Why not expo-sqlite's web backend (measured 2026-06-10, expo-sqlite
 * 56.0.4, both confirmed in chromium against the real artifact):
 *  1. Its vendored wa-sqlite.wasm is compiled WITHOUT FTS5 (binary contains
 *     no `fts5`/`porter` symbols), so every objects_fts query — the entire
 *     search tier — fails at prepare. Native expo-sqlite compiles sqlite3
 *     with -DSQLITE_ENABLE_FTS5=1, so only web is affected.
 *  2. Its SharedArrayBuffer sync bridge truncates results: WorkerChannel's
 *     `resultArray.set(new Uint32Array([length]), 0)` writes the length
 *     mod 256 (Uint8Array.set converts element-wise), corrupting any sync
 *     result whose JSON exceeds 255 bytes. Still present in the latest
 *     56.0.5 canary.
 *
 * Fallback (sanctioned in the Phase-2 plan): the official
 * @sqlite.org/sqlite-wasm, main-thread build, FTS5 enabled — the SAME
 * met.sqlite bytes opened in memory via sqlite3_deserialize. Queries are
 * natively synchronous (no worker, no SharedArrayBuffer, no COOP/COEP
 * requirement), which fits the synchronous DataProvider interface exactly.
 * The wasm binary ships as a metro asset from the npm package (no committed
 * copy); `import.meta` in the package's ESM is polyfilled via
 * babel-preset-expo's `transformImportMeta` (see babel.config.js) and never
 * evaluated because we pass `locateFile`.
 *
 * Persistence: the raw downloaded bytes go in the Cache Storage API
 * (cache "met-data") — OPFS is not reachable from a main-thread in-memory
 * database, and re-deserializing cached bytes on boot is the same code path
 * as first run. Offline rule is unchanged: if cached bytes open, the boot
 * never blocks on the network (DataGate polls the version in the
 * background).
 */
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

import { apiBase } from './apiBase';
// Type re-used from the native file (./sqlite.ts) — `import type` is erased
// at runtime, so this does NOT self-import even though metro resolves
// './sqlite' to this very file on web.
import type { MetDb } from './sqlite';
// Metro asset (metro.config.js adds 'wasm' to assetExts; declared in
// assets.d.ts). Resolved to a served URL via expo-asset.
import wasmModule from '@sqlite.org/sqlite-wasm/sqlite3.wasm';

const CACHE_NAME = 'met-data';
const CACHE_KEY = '/met.sqlite';

let sqlite3Promise: Promise<Sqlite3Static> | null = null;

function loadSqlite3(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    sqlite3Promise = (async () => {
      const [{ default: sqlite3InitModule }, { Asset }] = await Promise.all([
        import('@sqlite.org/sqlite-wasm'),
        import('expo-asset'),
      ]);
      // The shipped .d.mts types init() as zero-arg, but the runtime forwards
      // Emscripten module options (locateFile etc.) — see dist/index.mjs.
      const init = sqlite3InitModule as unknown as (opts: {
        locateFile: () => string;
        print: (msg: string) => void;
        printErr: (msg: string) => void;
      }) => Promise<Sqlite3Static>;
      return init({
        locateFile: () => Asset.fromModule(wasmModule).uri,
        print: () => {},
        printErr: (msg: string) => console.warn('[sqlite3]', msg),
      });
    })();
  }
  return sqlite3Promise;
}

async function openFromBytes(bytes: Uint8Array): Promise<Database> {
  const sqlite3 = await loadSqlite3();
  const db = new sqlite3.oo1.DB();
  // allocFromTypedArray copies `bytes` into wasm memory; FREEONCLOSE hands
  // ownership of that copy to sqlite. `bytes` stays valid for persist().
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer!,
    'main',
    p,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  db.checkRc(rc);
  return db;
}

function wrap(db: Database, bytes: Uint8Array, opts: { persistent: boolean }): MetDb {
  // Validation doubles as version read: throws on an empty/foreign file.
  const version = db.selectValue(`SELECT value FROM meta WHERE key = 'dataVersion'`);
  if (typeof version !== 'string' || !version)
    throw new Error('met.sqlite has no meta.dataVersion');
  const count = db.selectValue('SELECT count(*) FROM objects');
  if (!count) throw new Error('met.sqlite has no objects');
  const allSync = <T>(sql: string, params: ReadonlyArray<string | number> = []): T[] =>
    db.selectObjects(sql, params.length ? [...params] : undefined) as T[];
  return {
    dataVersion: version,
    allSync,
    allAsync: async (sql, params) => allSync(sql, params),
    persist: async () => {
      if (opts.persistent || typeof caches === 'undefined') return;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(CACHE_KEY, new Response(bytes.buffer as ArrayBuffer));
      console.log(`[met-data] persisted ${version}`);
    },
  };
}

/** Reopen the persisted copy, or null when absent/corrupt (then cleaned). */
export async function tryOpenLocal(): Promise<MetDb | null> {
  if (typeof caches === 'undefined') return null; // insecure context — no Cache API
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(CACHE_KEY);
    if (!res) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return wrap(await openFromBytes(bytes), bytes, { persistent: true });
  } catch (e) {
    console.log('[met-data] cached copy unusable, will re-download:', String(e));
    try {
      await caches.delete(CACHE_NAME);
    } catch {}
    return null;
  }
}

/**
 * Download the artifact and open it in memory. `ifNoneMatch` (the running
 * version) turns a no-op update into a 304 → returns null.
 */
export async function downloadDb(ifNoneMatch?: string): Promise<MetDb | null> {
  const res = await fetch(`${apiBase()}/api/v1/data/met.sqlite`, {
    headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : undefined,
  });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GET /api/v1/data/met.sqlite → ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return wrap(await openFromBytes(bytes), bytes, { persistent: false });
}

/** GET /api/v1/data/version → server's current artifact version. */
export async function fetchServerVersion(): Promise<string> {
  const res = await fetch(`${apiBase()}/api/v1/data/version`);
  if (!res.ok) throw new Error(`GET /api/v1/data/version → ${res.status}`);
  const body = (await res.json()) as { dataVersion: string };
  return body.dataVersion;
}
