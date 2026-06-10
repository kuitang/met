/**
 * met.sqlite acquisition + the openDb() seam — NATIVE backend (expo-sqlite).
 * Metro resolves `./sqlite` to ./sqlite.web.ts on web (official
 * @sqlite.org/sqlite-wasm, main thread, in-memory — see that file for why
 * expo-sqlite's web backend cannot be used). Both files export the same
 * surface; the MetDb interface defined HERE is the contract.
 *
 * Lifecycle (DataGate drives it):
 *  - tryOpenLocal(): reopen the persisted copy (SQLite/met.sqlite in the app
 *    document directory). Validates meta.dataVersion + a non-empty objects
 *    table; anything broken is deleted so the next boot falls through to a
 *    fresh download.
 *  - downloadDb(): GET /api/v1/data/met.sqlite → deserialize the bytes into
 *    an immediately-usable in-memory database (ETag/If-None-Match honored on
 *    update checks). The session runs on this handle.
 *  - met.persist(): background copy of a *downloaded* database into the
 *    named persistent file (SQLite backup API), so the NEXT boot is offline.
 *
 * Offline rule: if a local copy opens, the boot path never touches the
 * network — the version poll is fire-and-forget (DataGate).
 */
import {
  backupDatabaseAsync,
  deleteDatabaseAsync,
  deserializeDatabaseAsync,
  openDatabaseAsync,
  type SQLiteDatabase,
} from 'expo-sqlite';

import { apiBase } from './apiBase';

const DB_NAME = 'met.sqlite';

export interface MetDb {
  dataVersion: string;
  allSync<T>(sql: string, params?: ReadonlyArray<string | number>): T[];
  allAsync<T>(sql: string, params?: ReadonlyArray<string | number>): Promise<T[]>;
  /**
   * Copy this (downloaded, in-memory) database into persistent storage.
   * Callers run it in the background and may ignore failures — the session
   * keeps running; only the next boot's offline start is at stake.
   * No-op on a handle that already came from persistent storage.
   */
  persist(): Promise<void>;
}

async function wrap(db: SQLiteDatabase, opts: { persistent: boolean }): Promise<MetDb> {
  // Validation doubles as version read: throws on an empty/foreign file.
  const meta = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'dataVersion'`,
  );
  if (!meta?.value) throw new Error('met.sqlite has no meta.dataVersion');
  const count = await db.getFirstAsync<{ c: number }>('SELECT count(*) AS c FROM objects');
  if (!count || count.c === 0) throw new Error('met.sqlite has no objects');
  return {
    dataVersion: meta.value,
    allSync: (sql, params = []) => db.getAllSync(sql, [...params]),
    allAsync: (sql, params = []) => db.getAllAsync(sql, [...params]),
    persist: async () => {
      if (opts.persistent) return;
      await deleteDatabaseAsync(DB_NAME).catch(() => {});
      const dest = await openDatabaseAsync(DB_NAME);
      try {
        await backupDatabaseAsync({
          sourceDatabase: db,
          sourceDatabaseName: 'main',
          destDatabase: dest,
          destDatabaseName: 'main',
        });
      } finally {
        await dest.closeAsync().catch(() => {});
      }
      console.log(`[met-data] persisted ${meta.value}`);
    },
  };
}

/** Reopen the persisted database, or null when absent/corrupt (then cleaned). */
export async function tryOpenLocal(): Promise<MetDb | null> {
  let db: SQLiteDatabase | null = null;
  try {
    db = await openDatabaseAsync(DB_NAME);
    return await wrap(db, { persistent: true });
  } catch {
    // openDatabaseAsync creates an empty file when none existed — remove it
    // (and any corrupt copy) so persist() starts clean.
    await db?.closeAsync().catch(() => {});
    await deleteDatabaseAsync(DB_NAME).catch(() => {});
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
  const db = await deserializeDatabaseAsync(bytes);
  return await wrap(db, { persistent: false });
}

/** GET /api/v1/data/version → server's current artifact version. */
export async function fetchServerVersion(): Promise<string> {
  const res = await fetch(`${apiBase()}/api/v1/data/version`);
  if (!res.ok) throw new Error(`GET /api/v1/data/version → ${res.status}`);
  const body = (await res.json()) as { dataVersion: string };
  return body.dataVersion;
}
