import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { components } from '@met/shared';

import { ObjectThumb } from '@/components/ObjectImage';
import SearchFilterChips, {
  ResultFilters,
  applyFilters,
} from '@/components/SearchFilterChips';
import { apiBase } from '@/data/apiBase';
import { DataProvider, MetObject, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

type InterpretResponse = components['schemas']['InterpretResponse'];

/**
 * Server-side LLM interpret flow (POST /api/v1/search/interpret): the server
 * rewrites the natural-language query (escalating to a bounded agentic loop),
 * executes it against its met.sqlite, and returns final ranked results in one
 * round trip. Offline / server-down degrades to plain local search with a
 * notice — the local index keeps working.
 */
type InterpretState =
  | { phase: 'loading' }
  | { phase: 'done'; body: InterpretResponse }
  | { phase: 'offline' };

/** Ranked server results → full local objects (hit the local DB for images). */
function hydrateResults(data: DataProvider, body: InterpretResponse): MetObject[] {
  return body.results.map(
    (r) =>
      data.getObject(r.objectID) ?? {
        objectID: r.objectID,
        title: r.title,
        artist: r.artist,
        date: '',
        medium: '',
        accession: '',
        gallery: r.galleryNumber,
        dept: '',
        credit: '',
        isHighlight: false,
        img: '',
      },
  );
}

/** All Results — a full-text search (?q=), a gallery's objects (?gallery=),
 * or the LLM-interpreted fallback (?q=&interpreted=1, stubbed). */
export default function ResultsScreen() {
  const data = useData();
  const { q, gallery, interpreted } = useLocalSearchParams<{
    q?: string;
    gallery?: string;
    interpreted?: string;
  }>();
  const [filters, setFilters] = useState<ResultFilters>({});

  const isInterpreted = interpreted === '1' && !!q;
  const [interp, setInterp] = useState<InterpretState>({ phase: 'loading' });
  useEffect(() => {
    if (!isInterpreted) return;
    let cancelled = false;
    setInterp({ phase: 'loading' });
    (async () => {
      const res = await fetch(`${apiBase()}/api/v1/search/interpret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, maxResults: 20 }),
      });
      if (!res.ok) throw new Error(`interpret ${res.status}`);
      const body = (await res.json()) as InterpretResponse;
      if (!cancelled) setInterp({ phase: 'done', body });
    })().catch(() => {
      if (!cancelled) setInterp({ phase: 'offline' });
    });
    return () => {
      cancelled = true;
    };
  }, [isInterpreted, q]);

  const base = gallery
    ? data.objectsInGallery(gallery)
    : isInterpreted
      ? interp.phase === 'done'
        ? hydrateResults(data, interp.body)
        : interp.phase === 'offline'
          ? data.searchAll(q ?? '') // graceful degrade: local index still works
          : []
      : data.searchAll(q ?? '');
  const floorOf = (galleryId: string) => data.getGallery(galleryId)?.floor;
  const results = applyFilters(base, filters, floorOf);
  const heading = gallery
    ? data.getGallery(gallery)?.name ?? `Gallery ${gallery}`
    : `“${q ?? ''}”`;

  const galleryChip = (o: MetObject) => {
    if (!o.gallery) return 'Not on view';
    const floor = floorOf(o.gallery);
    return floor !== undefined ? `Gallery ${o.gallery} · F${floor}` : `Gallery ${o.gallery}`;
  };

  return (
    <View style={styles.container}>
      {isInterpreted && (
        <View style={styles.banner} testID="interpreted-banner">
          <Text style={styles.bannerLabel}>Ask differently</Text>
          {interp.phase === 'loading' && (
            <View style={styles.bannerRow}>
              <ActivityIndicator size="small" color={colors.red} />
              <Text style={type.meta}>Interpreting your words…</Text>
            </View>
          )}
          {interp.phase === 'done' && (
            <>
              <Text style={styles.bannerText} testID="interpreted-query">
                Interpreted: “{interp.body.interpretedQuery.ftsQuery}”
              </Text>
              <Text style={type.meta}>
                {interp.body.method === 'agentic' && interp.body.why
                  ? interp.body.why
                  : 'Your words were rewritten into a catalog query and re-searched.'}
              </Text>
            </>
          )}
          {interp.phase === 'offline' && (
            <Text style={type.meta} testID="interpret-offline">
              You're offline — smart interpretation needs a connection. Showing
              plain matches from the on-device index instead.
            </Text>
          )}
        </View>
      )}
      <Text style={styles.heading}>
        {results.length} result{results.length === 1 ? '' : 's'} · {heading}
      </Text>
      <SearchFilterChips filters={filters} onChange={setFilters} />
      <FlatList
        data={results}
        keyExtractor={(o) => String(o.objectID)}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/object/${item.objectID}`)}
            testID={`result-${item.objectID}`}
          >
            {item.img ? (
              // Tigris CDN first, proxy fallback — see data/imageCdn.ts.
              <ObjectThumb object={item} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={type.meta} numberOfLines={1}>
                {item.artist || item.dept}
                {item.date ? ` · ${item.date}` : ''}
              </Text>
              <Text style={styles.galleryChip}>{galleryChip(item)}</Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No results.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  banner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    gap: 2,
    backgroundColor: colors.surface,
    borderLeftWidth: 2,
    borderLeftColor: colors.red,
  },
  bannerLabel: {
    ...type.label,
    color: colors.red,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bannerText: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  heading: {
    ...type.meta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  thumb: {
    width: 64,
    height: 64,
    backgroundColor: colors.surface,
  },
  thumbEmpty: {
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  galleryChip: {
    ...type.label,
    color: colors.red,
    marginTop: 2,
  },
  empty: {
    ...type.meta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
