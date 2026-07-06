import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAnchor, useVenue } from '@/components/LocateState';
import MuseumBadge from '@/components/MuseumBadge';
import RoomRow from '@/components/RoomRow';
import ScopeChips, { type MuseumScope } from '@/components/ScopeChips';
import {
  MetObject,
  museumForSite,
  museumSiteIds,
  parseRoomId,
  partitionByMuseum,
  useData,
} from '@/data/provider';
import { matchAmenities, rankAmenities } from '@/data/roomSearch';
import { colors, spacing, type } from '@/theme';

// Chosen to hit stub data: "gold swords" deliberately under-matches locally
// and demos the Ask-differently fallback. (Plan example "pyramid" has no stub
// object yet — restore once the real catalog lands.)
const EXAMPLE_QUERIES = ['Monet', 'gold swords', 'sphinx', 'restroom'];

/** One flat FlatList item: either an object row or a section header (C2
 *  sectioned multi-museum results — see the module doc in ScopeChips.tsx). */
type ListItem =
  | { kind: 'object'; key: string; object: MetObject; other: boolean }
  | { kind: 'header'; key: string; label: string };

export default function SearchScreen() {
  const data = useData();
  const anchor = useAnchor();
  const venue = useVenue();
  // Nav-mode retarget (opened from the nav sheet's destination title):
  // `retarget` carries the route origin — room rows swap the navigation
  // target in place instead of opening a browse sheet (see RoomRow).
  const { retarget, avoid } = useLocalSearchParams<{ retarget?: string; avoid?: string }>();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MuseumScope>('all');

  // Multi-museum sectioning (C2): only ever engages when the artifact
  // actually carries >1 museum — a single-museum artifact (every artifact
  // today except the AIC-merged one) renders byte-identical to before.
  const museums = data.museums();
  const isMultiMuseum = museums.length > 1;
  const activeMuseum = museumForSite(museums, venue.venue) ?? museums[0];
  const activeSiteIds = useMemo(() => museumSiteIds(activeMuseum), [activeMuseum]);
  const scopedMuseum = isMultiMuseum && scope === 'here' ? activeMuseum.id : undefined;
  // Only 'all' scope (and only with >1 museum) ever shows sections — 'here'
  // scoping is already SQL-scoped to one museum, so there is nothing to
  // section (same as the single-museum case: a plain flat list).
  const showSections = isMultiMuseum && scope === 'all';

  // activeMuseum ranks (never filters) the visitor's museum first — the
  // "All museums" scope stays global but a Met visitor's "pyramid" is Met
  // pyramids before the Rijksmuseum's Bloempiramide tulip vases.
  const boostMuseum = isMultiMuseum ? activeMuseum.id : undefined;
  const suggestions = data.searchAutocomplete(query, 8, scopedMuseum, boostMuseum);
  const total = data.searchAll(
    query,
    scopedMuseum ? { museum: scopedMuseum } : undefined,
    boostMuseum,
  ).length;
  // Room rows above object rows: galleries (exact number → number prefixes →
  // title matches, ranked in shared/search.ts) then amenities nearest-first.
  // Room rows are always scoped to the active museum's sites (never show a
  // gallery/amenity from a museum the visitor isn't currently browsing).
  const galleryRowsRaw = data.searchGalleries(query, 4);
  const galleryRows = isMultiMuseum
    ? galleryRowsRaw.filter((r) => activeSiteIds.has(r.site ?? 'fifthAve'))
    : galleryRowsRaw;
  const matchedAmenitiesRaw = matchAmenities(data.amenities(), query);
  const matchedAmenities = isMultiMuseum
    ? matchedAmenitiesRaw.filter((r) => activeSiteIds.has(r.site ?? 'fifthAve'))
    : matchedAmenitiesRaw;
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
    // o.gallery is site-scoped ("aic:243") to disambiguate the lookup key —
    // the visible chip reads the bare gallery number.
    const num = parseRoomId(o.gallery).galleryNumber;
    return floor !== undefined ? `Gallery ${num} · F${floor}` : `Gallery ${num}`;
  };

  const listItems: ListItem[] = (() => {
    const asItem = (o: MetObject, other: boolean): ListItem => ({
      kind: 'object',
      key: String(o.objectID),
      object: o,
      other,
    });
    if (!showSections) return suggestions.map((o) => asItem(o, false));
    const { active, other } = partitionByMuseum(suggestions, activeMuseum.id);
    const items: ListItem[] = [];
    if (active.length > 0) {
      items.push({
        kind: 'header',
        key: 'hdr-active',
        label: `AT ${activeMuseum.shortName.toUpperCase()}`,
      });
      items.push(...active.map((o) => asItem(o, false)));
    }
    if (other.length > 0) {
      items.push({ kind: 'header', key: 'hdr-other', label: 'OTHER MUSEUMS' });
      items.push(...other.map((o) => asItem(o, true)));
    }
    return items;
  })();

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
      {isMultiMuseum && (
        <ScopeChips activeLabel={activeMuseum.shortName} scope={scope} onChange={setScope} />
      )}
      <FlatList
        data={listItems}
        keyExtractor={(item) => item.key}
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
                  meta={
                    room.kind === 'gallery'
                      ? `Gallery ${parseRoomId(room.id).galleryNumber}`
                      : undefined
                  }
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
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={styles.sectionHeader}>{item.label}</Text>
          ) : (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/object/${item.object.objectID}`)}
              testID={`suggestion-${item.object.objectID}`}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.object.title}
                </Text>
                <Text style={type.meta} numberOfLines={1}>
                  {item.object.artist || item.object.dept}
                  {item.object.date ? ` · ${item.object.date}` : ''}
                </Text>
              </View>
              {item.other ? (
                <MuseumBadge
                  shortName={museumForSite(museums, item.object.site)?.shortName ?? ''}
                  testID={`museum-badge-${item.object.objectID}`}
                />
              ) : (
                <Text style={styles.galleryChip}>{galleryChip(item.object)}</Text>
              )}
            </Pressable>
          )
        }
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
  // Multi-museum section headers ("AT THE MET" / "OTHER MUSEUMS") — small
  // caps, secondary color, matching the codebase's all-caps label idiom.
  sectionHeader: {
    ...type.label,
    color: colors.inkSecondary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
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
