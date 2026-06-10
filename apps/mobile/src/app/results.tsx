import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import SearchFilterChips, {
  ResultFilters,
  applyFilters,
} from '@/components/SearchFilterChips';
import { DataProvider, MetObject, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

/**
 * Stub for the server-side LLM interpret flow (Phase 2:
 * POST /api/v1/search/interpret). Strips filler words, then OR-merges
 * per-word hits ranked by how many words each object matched.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'that', 'this', 'those', 'these', 'of', 'in', 'on', 'at',
  'with', 'by', 'for', 'to', 'and', 'or', 'is', 'are', 'it', 'its', 'his',
  'her', 'their', 'huge', 'big', 'large', 'famous', 'old', 'really', 'very',
  'some', 'painting', 'paintings', 'picture', 'pictures', 'artwork', 'piece',
  'show', 'me', 'find', 'where', 'can', 'i', 'see', 'looking',
]);

function interpretQuery(q: string): string {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !FILLER.has(w))
    .join(' ');
}

function interpretedSearch(data: DataProvider, q: string): MetObject[] {
  const words = interpretQuery(q).split(' ').filter(Boolean);
  const hits = new Map<number, { o: MetObject; words: number; bestRank: number }>();
  for (const w of words) {
    data.searchAll(w).forEach((o, rank) => {
      const h = hits.get(o.objectID) ?? { o, words: 0, bestRank: rank };
      h.words += 1;
      h.bestRank = Math.min(h.bestRank, rank);
      hits.set(o.objectID, h);
    });
  }
  return [...hits.values()]
    .sort((a, b) => b.words - a.words || a.bestRank - b.bestRank)
    .map((h) => h.o);
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
  const base = gallery
    ? data.objectsInGallery(gallery)
    : isInterpreted
      ? interpretedSearch(data, q ?? '')
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
          <Text style={styles.bannerText}>
            Interpreted: “{interpretQuery(q ?? '') || q}”
          </Text>
          <Text style={type.meta}>
            Mockup — Phase 2 sends this to the server LLM
            (/api/v1/search/interpret) and returns ranked results.
          </Text>
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
              <Image source={{ uri: item.img }} style={styles.thumb} />
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
