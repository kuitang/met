import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAnchor } from '@/components/LocateState';
import { DataProvider, MetObject, Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

// Chosen to hit stub data: "gold swords" deliberately under-matches locally
// and demos the Ask-differently fallback. (Plan example "pyramid" has no stub
// object yet — restore once the real catalog lands.)
const EXAMPLE_QUERIES = ['Monet', 'gold swords', 'sphinx', 'restroom'];

/** "bathroom" and friends should still find restrooms. */
const AMENITY_SYNONYMS: Record<string, string> = {
  bathroom: 'restroom',
  bathrooms: 'restroom',
  toilet: 'restroom',
  toilets: 'restroom',
  wc: 'restroom',
  lift: 'elevator',
  lifts: 'elevator',
  staircase: 'stairs',
  stairway: 'stairs',
};

function matchAmenities(amenities: Room[], query: string): Room[] {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const canon = AMENITY_SYNONYMS[q] ?? q;
  return amenities.filter(
    (r) => r.kind.includes(canon) || r.name.toLowerCase().includes(canon),
  );
}

/**
 * Nearest-first amenity ranking: walking (graph) distance from the visitor's
 * anchor — or the Great Hall before any fix exists. Unreachable rooms (other
 * site, no graph) sink to the end. ~0.6 ms per route on the full graph,
 * computed once per (anchor, amenity-set).
 */
function rankAmenities(
  data: DataProvider,
  matched: Room[],
  originId: string,
): { room: Room; distance?: number }[] {
  return matched
    .map((room) => ({ room, distance: data.route(originId, room.id)?.distance }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

export default function SearchScreen() {
  const data = useData();
  const anchor = useAnchor();
  const [query, setQuery] = useState('');
  const suggestions = data.searchAutocomplete(query, 8);
  const total = data.searchAll(query).length;
  const matchedAmenities = matchAmenities(data.amenities(), query);
  const originId = anchor?.roomId ?? 'great-hall';
  const amenities = useMemo(
    () => rankAmenities(data, matchedAmenities, originId),
    // matchedAmenities is identity-unstable per keystroke; key on its ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, originId, matchedAmenities.map((r) => r.id).join(',')],
  );
  const hasQuery = query.trim().length > 0;

  const galleryChip = (o: MetObject) => {
    if (!o.gallery) return 'Not on view';
    const floor = data.getGallery(o.gallery)?.floor;
    return floor !== undefined ? `Gallery ${o.gallery} · F${floor}` : `Gallery ${o.gallery}`;
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Search art, artists, galleries…"
        placeholderTextColor={colors.inkFaint}
        autoFocus
        autoCorrect={false}
        testID="search-input"
      />
      <FlatList
        data={suggestions}
        keyExtractor={(o) => String(o.objectID)}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          amenities.length > 0 ? (
            <View>
              {amenities.map(({ room: r, distance }) => (
                <Pressable
                  key={r.id}
                  style={styles.row}
                  onPress={() => router.push(`/?room=${r.id}`)}
                  testID={`amenity-${r.id}`}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={type.meta} numberOfLines={1}>
                      {distance !== undefined
                        ? `~${Math.round(distance)} m walk · tap to see on map`
                        : 'Amenity · tap to see on map'}
                    </Text>
                  </View>
                  <Text style={styles.galleryChip}>
                    {r.kind} · F{r.floor}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/object/${item.objectID}`)}
            testID={`suggestion-${item.objectID}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={type.meta} numberOfLines={1}>
                {item.artist || item.dept}
                {item.date ? ` · ${item.date}` : ''}
              </Text>
            </View>
            <Text style={styles.galleryChip}>{galleryChip(item)}</Text>
          </Pressable>
        )}
        ListFooterComponent={
          <View>
            {total > 0 && (
              <Pressable
                style={styles.allResults}
                onPress={() => router.push(`/results?q=${encodeURIComponent(query)}`)}
                testID="all-results-link"
              >
                <Text style={styles.allResultsText}>
                  All {total} result{total === 1 ? '' : 's'} →
                </Text>
              </Pressable>
            )}
            {hasQuery && total < 3 && (
              <Pressable
                style={styles.askDifferently}
                onPress={() =>
                  router.push(`/results?q=${encodeURIComponent(query)}&interpreted=1`)
                }
                testID="ask-differently"
              >
                <Text style={styles.askDifferentlyLabel}>Ask differently</Text>
                <Text style={type.meta}>
                  Let the Met Navigator interpret your words and re-search →
                </Text>
              </Pressable>
            )}
          </View>
        }
        ListEmptyComponent={
          hasQuery ? (
            amenities.length > 0 ? null : (
              <Text style={styles.empty}>No quick matches on view.</Text>
            )
          ) : (
            <View style={styles.hint}>
              <Text style={type.meta}>
                Search the on-view collection by title, artist, medium, or gallery
                number.
              </Text>
              <View style={styles.examples}>
                <Text style={styles.examplesLabel}>Try</Text>
                {EXAMPLE_QUERIES.map((ex) => (
                  <Pressable
                    key={ex}
                    onPress={() => setQuery(ex)}
                    testID={`example-${ex.replace(/\s+/g, '-')}`}
                  >
                    <Text style={styles.exampleText}>{ex}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  input: {
    ...type.body,
    margin: spacing.lg,
    marginBottom: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
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
    textAlign: 'right',
  },
  allResults: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  allResultsText: {
    ...type.label,
    color: colors.red,
  },
  askDifferently: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: 2,
    backgroundColor: colors.surface,
    borderLeftWidth: 2,
    borderLeftColor: colors.red,
  },
  askDifferentlyLabel: {
    ...type.label,
    color: colors.red,
  },
  empty: {
    ...type.meta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  hint: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  examples: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  examplesLabel: {
    ...type.label,
    color: colors.inkFaint,
  },
  exampleText: {
    ...type.body,
    fontFamily: type.title.fontFamily,
    color: colors.red,
  },
});
