import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAnchor } from '@/components/LocateState';
import RoomRow from '@/components/RoomRow';
import { MetObject, useData } from '@/data/provider';
import { matchAmenities, rankAmenities } from '@/data/roomSearch';
import { colors, spacing, type } from '@/theme';

// Chosen to hit stub data: "gold swords" deliberately under-matches locally
// and demos the Ask-differently fallback. (Plan example "pyramid" has no stub
// object yet — restore once the real catalog lands.)
const EXAMPLE_QUERIES = ['Monet', 'gold swords', 'sphinx', 'restroom'];

export default function SearchScreen() {
  const data = useData();
  const anchor = useAnchor();
  // Nav-mode retarget (opened from the nav sheet's destination title):
  // `retarget` carries the route origin — room rows swap the navigation
  // target in place instead of opening a browse sheet (see RoomRow).
  const { retarget, avoid } = useLocalSearchParams<{ retarget?: string; avoid?: string }>();
  const [query, setQuery] = useState('');
  const suggestions = data.searchAutocomplete(query, 8);
  const total = data.searchAll(query).length;
  // Room rows above object rows: galleries (exact number → number prefixes →
  // title matches, ranked in shared/search.ts) then amenities nearest-first.
  const galleryRows = data.searchGalleries(query, 4);
  const matchedAmenities = matchAmenities(data.amenities(), query);
  const originId = anchor?.roomId ?? 'great-hall';
  const amenities = useMemo(
    () => rankAmenities(data, matchedAmenities, originId),
    // matchedAmenities is identity-unstable per keystroke; key on its ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, originId, matchedAmenities.map((r) => r.id).join(',')],
  );
  const hasQuery = query.trim().length > 0;
  const hasRoomRows = galleryRows.length > 0 || amenities.length > 0;

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
          hasRoomRows ? (
            <View>
              {/* One row anatomy, one tap grammar (user mandate): a room row
                  carries NO inline actions — tapping it lands on the home map
                  with the room's sheet open (DIRECTIONS / I'M HERE there). */}
              {galleryRows.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  meta={room.kind === 'gallery' ? `Gallery ${room.id}` : undefined}
                  testID={`gallery-${room.id}`}
                  navFrom={retarget}
                  avoidStairs={avoid === 'stairs'}
                />
              ))}
              {/* Amenity rows are ranked nearest-first by graph distance from
                  the anchor, so the top row IS the nearest instance. */}
              {amenities.map(({ room, distance }) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  meta={distance !== undefined ? `~${Math.round(distance)} m walk` : 'Amenity'}
                  testID={`amenity-${room.id}`}
                  navFrom={retarget}
                  avoidStairs={avoid === 'stairs'}
                />
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
                  {'Let MuseWalk interpret your words and re-search →'}
                </Text>
              </Pressable>
            )}
          </View>
        }
        ListEmptyComponent={
          hasQuery ? (
            hasRoomRows ? null : (
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
