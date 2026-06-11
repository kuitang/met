import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import FloorMap from '@/components/FloorMap';
import HomeRoomSheet from '@/components/HomeRoomSheet';
import {
  VENUE_NAMES,
  anchorForRoom,
  applyVenue,
  dismissVenueToast,
  setAnchor,
  useAnchor,
  useVenue,
  useVenueToast,
} from '@/components/LocateState';
import { Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function HomeScreen() {
  const data = useData();
  const anchor = useAnchor();
  const venue = useVenue();
  const venueToast = useVenueToast();
  // Deep-link support: `/?room=131` anchors directly (also kept for e2e).
  const { room: roomParam, focus: focusParam, ts: tsParam } = useLocalSearchParams<{
    room?: string;
    focus?: string;
    ts?: string;
  }>();
  useEffect(() => {
    if (!roomParam) return;
    const room = data.getGallery(roomParam);
    if (room) setAnchor(anchorForRoom(room, 'gallery'));
  }, [roomParam, data]);

  const [selected, setSelected] = useState<Room | undefined>();
  const [floor, setFloor] = useState(1);

  // One tap grammar for search room rows: `/?focus=131` (gallery or amenity
  // id) lands here with the floor switched, the room highlighted, and its
  // sheet open — the anchor is NOT touched (DIRECTIONS / I'M HERE live in the
  // sheet). `ts` busts expo-router param equality so re-tapping the same room
  // re-opens the sheet; cross-venue rooms drag the venue (with the toast).
  useEffect(() => {
    if (!focusParam) return;
    const room = data.getGallery(focusParam);
    if (!room) return;
    applyVenue(room.site ?? 'fifthAve', 'browse');
    setSelected(room);
    setFloor(room.floor);
  }, [focusParam, tsParam, data]);

  // Follow the anchor's floor when it changes (e.g. set via the Locate sheet).
  useEffect(() => {
    if (anchor?.floor !== undefined) setFloor(anchor.floor);
  }, [anchor]);

  const highlightId = selected?.id ?? anchor?.roomId;

  // HOME glyph marker at the anchor room (when it's at the active venue).
  const anchorRoom = anchor?.roomId ? data.getGallery(anchor.roomId) : undefined;
  const homeRoom =
    anchorRoom && (anchorRoom.site ?? 'fifthAve') === venue.venue ? anchorRoom : undefined;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.mapFill}>
        <FloorMap
          floor={floor}
          onFloorChange={setFloor}
          highlightId={highlightId}
          onRoomPress={setSelected}
          site={venue.venue}
          homeRoom={homeRoom}
        />
      </View>

      {/* pointerEvents lives in style: the prop form is deprecated on RN-web
          and logs a dev warning (LogBox badge → HIG sweep failure). */}
      <View style={styles.topOverlay}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>
            Muse<Text style={styles.wordmarkAccent}>Walk</Text>
          </Text>
        </View>
        <Pressable
          style={styles.searchBar}
          onPress={() => router.push('/search')}
          testID="home-search-bar"
        >
          <Text style={styles.searchPlaceholder}>Search art, artists, galleries…</Text>
        </Pressable>
      </View>

      {/* Bottom chrome hides while a room sheet is open: the sheet owns the
          bottom band across all three detents (it would cover the chip at
          half/full and crowd the map readout at header-only); the chip
          returns — with any anchor change — when the sheet closes. */}
      {!selected && (
        <View style={styles.bottomOverlay}>
          {/* Dismissible toast raised by automatic venue switches (GPS fix at
            the other venue, or tapping a cross-venue search result). */}
          {venueToast ? (
            <Pressable style={styles.venueToast} onPress={dismissVenueToast} testID="venue-toast">
              <Text style={styles.venueToastText}>{venueToast}</Text>
              <Text style={styles.venueToastClose}>✕</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.locateChip, !anchor && styles.locateChipUnknown]}
            onPress={() => router.push('/locate')}
            testID="locate-chip"
          >
            <Text style={styles.locateChipText}>
              {anchor ? anchor.label : 'Location unknown — tap to set'}
            </Text>
            <Text style={styles.locateChipVenue} testID="locate-chip-venue">
              {VENUE_NAMES[venue.venue]}
            </Text>
          </Pressable>

          {/* Brand-required disclosure: nominative use of the museum's name in
            descriptive copy only — never in the wordmark. */}
          <Text style={styles.unofficialNote}>
            An unofficial companion for The Metropolitan Museum of Art
          </Text>
        </View>
      )}

      {/* The room sheet is its own full-screen clipping layer (not part of
          the bottom column) so its FULL detent can rise past the chrome. */}
      {selected && (
        <HomeRoomSheet
          room={selected}
          objects={data.objectsInGallery(selected.id)}
          totalCount={data.galleryObjectCount(selected.id)}
          originId={anchor?.roomId ?? 'great-hall'}
          onImHere={() => {
            setAnchor(anchorForRoom(selected, 'gallery'));
            setSelected(undefined);
          }}
          onDirections={() => setSelected(undefined)}
          onClose={() => setSelected(undefined)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  mapFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  topOverlay: {
    pointerEvents: 'box-none',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  wordmark: {
    ...type.display,
    fontSize: 28,
    lineHeight: 34,
    textTransform: 'uppercase',
  },
  wordmarkAccent: {
    color: colors.red,
  },
  searchBar: {
    // Leave the right edge clear for the FloorMap floor chips underneath
    // (44pt chips + spacing.md inset).
    marginRight: 60,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  searchPlaceholder: {
    ...type.body,
    color: colors.inkFaint,
  },
  bottomOverlay: {
    pointerEvents: 'box-none',
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  locateChip: {
    alignSelf: 'flex-start',
    marginLeft: spacing.lg,
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  locateChipUnknown: {
    backgroundColor: colors.red,
  },
  locateChipText: {
    ...type.label,
    color: colors.white,
  },
  // Second line: the active venue (Fifth Avenue / The Cloisters) — venue is
  // part of location state, surfaced on the chip, set via the locate sheet.
  locateChipVenue: {
    ...type.label,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1,
    color: 'rgba(255,255,255,0.75)',
  },
  unofficialNote: {
    ...type.meta,
    fontSize: 11,
    lineHeight: 14,
    color: colors.inkSecondary,
    marginLeft: spacing.lg,
    marginRight: spacing.lg,
    marginBottom: spacing.sm,
  },
  venueToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'flex-start',
    marginLeft: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44, // HIG tap target (tap anywhere to dismiss)
    backgroundColor: colors.red,
  },
  venueToastText: {
    ...type.label,
    color: colors.white,
  },
  venueToastClose: {
    ...type.label,
    color: colors.white,
  },
});
