/**
 * DataGate — provider selection + the met.sqlite download/version flow.
 *
 * Selection (bundle-time): EXPO_PUBLIC_DATA=real → SqliteDataProvider over the
 * downloaded artifact (production builds set this; see export:web:real).
 * Anything else → StubDataProvider, synchronously — plain `npm run web` dev
 * and the existing e2e checks are untouched.
 *
 * Real boot order (offline-first, per the data contract):
 *  1. tryOpenLocal() — if a persisted copy opens, the session starts on it
 *     immediately and NEVER blocks on the network; the server version poll
 *     runs fire-and-forget in the background (step 3).
 *  2. No local copy → first run: GET /api/v1/data/met.sqlite, open in memory,
 *     start the session, persist in the background for the next boot.
 *     Failure here (offline first run) renders a retry screen.
 *  3. Background update: GET /api/v1/data/version; when it differs from the
 *     running version, re-download with If-None-Match (ETag), swap the live
 *     provider, persist. Any failure is swallowed — the current DB keeps
 *     serving.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { registerVenueNames } from '@/components/LocateState';
import { colors, type } from '@/theme';

import { DataContext, StubDataProvider, type DataProvider } from './provider';
import { downloadDb, fetchServerVersion, tryOpenLocal, type MetDb } from './sqlite';
import { SqliteDataProvider } from './SqliteDataProvider';

const REAL = process.env.EXPO_PUBLIC_DATA === 'real';
const stubProvider = REAL ? null : new StubDataProvider();

/**
 * Overlay site display names from the artifact's meta.museums (schema v2)
 * onto LocateState's venueName() registry: a museum with one site is named
 * by its shortName (AIC has no separate "site name" worth surfacing), a
 * multi-site museum (the Met) names each site individually. Runs once per
 * provider load/swap — cheap, and covers every site the artifact knows about
 * without touching LocateState's built-in Met fallback.
 */
function registerNamesFrom(provider: DataProvider): void {
  const names: Record<string, string> = {};
  for (const m of provider.museums()) {
    for (const s of m.sites) names[s.siteId] = m.sites.length === 1 ? m.shortName : s.name;
  }
  registerVenueNames(names);
}

async function openProvider(met: MetDb): Promise<DataProvider> {
  const provider = await SqliteDataProvider.create(met);
  registerNamesFrom(provider);
  return provider;
}

/** Fire-and-forget: poll the server version, hot-swap on change. */
function checkForUpdate(current: MetDb, swap: (p: DataProvider) => void): void {
  (async () => {
    const serverVersion = await fetchServerVersion();
    if (serverVersion === current.dataVersion) return;
    const fresh = await downloadDb(current.dataVersion);
    if (!fresh) return; // 304 — ETag says we already have it
    swap(await openProvider(fresh));
    await fresh.persist();
  })().catch((e) => console.log('[met-data] background update skipped:', String(e)));
}

/**
 * License-TTL mechanism (see SqliteDataProvider, ARCHITECTURE.md "Provenance
 * & the license-TTL mechanism"): the WHERE clauses already hide an expired
 * museum's rows from every search/browse path, so correctness never depends
 * on this — but a session that opened on a copy with an expired museum
 * should not just sit there; log it and kick the version check right away
 * (still fire-and-forget: it never blocks first render) instead of waiting
 * for whatever poll cadence would otherwise apply.
 */
function logExpiredMuseums(provider: DataProvider): void {
  const expired = provider.expiredMuseums();
  if (expired.length) {
    console.log(
      `[met-data] license-TTL expired for: ${expired.join(', ')} — forcing an immediate version check`,
    );
  }
}

export function DataGate({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<DataProvider | null>(stubProvider);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!REAL) return;
    let cancelled = false;
    const swap = (p: DataProvider) => {
      if (!cancelled) setProvider(p);
    };
    (async () => {
      setError(null);
      const local = await tryOpenLocal();
      if (local) {
        const p = await openProvider(local);
        swap(p);
        logExpiredMuseums(p);
        checkForUpdate(local, swap); // never blocks the session (already immediate, not just fire-and-forget)
        return;
      }
      const met = await downloadDb();
      if (!met) throw new Error('unexpected 304 on first download');
      const p = await openProvider(met);
      swap(p);
      met.persist().catch((e) => console.log('[met-data] persist failed:', String(e)));
      logExpiredMuseums(p);
      if (p.expiredMuseums().length) checkForUpdate(met, swap);
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (provider) return <DataContext.Provider value={provider}>{children}</DataContext.Provider>;

  return (
    <View style={styles.screen} testID={error ? 'data-error' : 'data-loading'}>
      {error ? (
        <>
          <Text style={styles.title}>Couldn’t load museum data</Text>
          <Text style={styles.detail}>
            The first launch needs a connection to download the map and collection.
          </Text>
          <Pressable
            style={styles.button}
            onPress={() => setAttempt((n) => n + 1)}
            testID="data-retry"
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>TRY AGAIN</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color={colors.red} />
          <Text style={styles.detail}>Loading the collection…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
    backgroundColor: colors.background,
  },
  title: { ...type.title, textAlign: 'center' },
  detail: { ...type.body, textAlign: 'center', color: colors.inkSecondary },
  button: {
    minHeight: 44, // HIG tap target
    minWidth: 44,
    paddingHorizontal: 24,
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  buttonLabel: { ...type.label, color: colors.background, fontSize: 16 },
});
