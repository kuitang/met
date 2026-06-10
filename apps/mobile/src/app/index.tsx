import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import FloorMap from '@/components/FloorMap';
import HomeRoomSheet from '@/components/HomeRoomSheet';
import { anchorForRoom, setAnchor, useAnchor } from '@/components/LocateState';
import { Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function HomeScreen() {
  const data = useData();
  const anchor = useAnchor();
  // Deep-link support: `/?room=131` anchors directly (also kept for e2e).
  const { room: roomParam } = useLocalSearchParams<{ room?: string }>();
  useEffect(() => {
    if (!roomParam) return;
    const room = data.getGallery(roomParam);
    if (room) setAnchor(anchorForRoom(room, 'gallery'));
  }, [roomParam, data]);

  const [selected, setSelected] = useState<Room | undefined>();
  const [floor, setFloor] = useState(1);

  // Follow the anchor's floor when it changes (e.g. set via the Locate sheet).
  useEffect(() => {
    if (anchor?.floor !== undefined) setFloor(anchor.floor);
  }, [anchor]);

  const highlightId = selected?.id ?? anchor?.roomId;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.mapFill}>
        <FloorMap
          floor={floor}
          onFloorChange={setFloor}
          highlightId={highlightId}
          onRoomPress={setSelected}
        />
      </View>

      {/* pointerEvents lives in style: the prop form is deprecated on RN-web
          and logs a dev warning (LogBox badge → HIG sweep failure). */}
      <View style={styles.topOverlay}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>The Met</Text>
          <Text style={styles.headerLabel}>Navigator</Text>
        </View>
        <Pressable
          style={styles.searchBar}
          onPress={() => router.push('/search')}
          testID="home-search-bar"
        >
          <Text style={styles.searchPlaceholder}>Search art, artists, galleries…</Text>
        </Pressable>
      </View>

      <View style={styles.bottomOverlay}>
        <Pressable
          style={[styles.locateChip, !anchor && styles.locateChipUnknown]}
          onPress={() => router.push('/locate')}
          testID="locate-chip"
        >
          <Text style={styles.locateChipText}>
            {anchor ? anchor.label : 'Location unknown — tap to set'}
          </Text>
        </Pressable>

        {selected && (
          <HomeRoomSheet
            room={selected}
            objects={data.objectsInGallery(selected.id)}
            originId={anchor?.roomId ?? 'great-hall'}
            onClose={() => setSelected(undefined)}
          />
        )}
      </View>
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
  headerLabel: {
    ...type.label,
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
});
