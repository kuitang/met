/**
 * RoomListBrowse — the home map area's replacement for museums with no
 * gallery geometry (`capabilities.hasGeometry: false` — every non-Met museum
 * today; see data/src/sources/registry.ts). There is no floor plan to draw,
 * so the "map" is instead a scrollable list of the venue's gallery rooms:
 * floor-grouped with jump chips when the museum's rows carry a real floor
 * (Cleveland's room-code ranges, the Louvre's own floor JSON), or one flat
 * ungrouped list — chips hidden — when every room's floor is unknown (AIC,
 * SMK: no authoritative gallery→floor mapping published, see
 * data/src/sources/{aic,smk}.ts). NEVER the stub schematic fallback: that
 * would draw fake rooms for a museum whose real shape we don't have.
 *
 * Reuses RoomRow's exact anatomy and one-tap grammar unchanged (a row IS
 * `focusRoom` — dismissTo `/?focus=` — same as every other room-row entry
 * point), so tapping a room here opens the identical room sheet the map
 * would have.
 */
import { useMemo, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { floorLabel } from '@/components/MapGeometry';
import RoomRow from '@/components/RoomRow';
import { parseRoomId, Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

const UNKNOWN_FLOOR_KEY = ' unknown'; // sorts after any real floorOrder entry, never collides with a label

type ListItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'room'; key: string; room: Room };

function byGalleryNumber(a: Room, b: Room): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

export default function RoomListBrowse({
  rooms,
  floorOrder,
  /** Clears the wordmark + search bar header overlay (index.tsx topOverlay), which floats above this full-bleed list the same way it floats above FloorMap. */
  topInset,
  /** Clears the locate chip + unofficial-note bottom overlay, which also floats over this list (a pannable map can be panned clear of it; a list needs real bottom padding instead). */
  bottomInset = 0,
  testID = 'room-list-browse',
}: {
  /** The active venue's gallery rooms only (caller filters by site). */
  rooms: Room[];
  /** The site's registry floorOrder (bottom → top); omitted/empty falls back to one flat list. */
  floorOrder?: string[];
  topInset: number;
  bottomInset?: number;
  testID?: string;
}) {
  const anyKnownFloor = useMemo(() => rooms.some((r) => Number.isFinite(r.floor)), [rooms]);
  const grouped = (floorOrder?.length ?? 0) > 0 && anyKnownFloor;

  const { items, floorChips } = useMemo(() => {
    if (!grouped) {
      const flat: ListItem[] = [...rooms]
        .sort(byGalleryNumber)
        .map((room) => ({ kind: 'room' as const, key: room.id, room }));
      return { items: flat, floorChips: [] as string[] };
    }
    const bySection = new Map<string, Room[]>();
    for (const room of rooms) {
      const key = Number.isFinite(room.floor) ? floorLabel(room.floor, room.site) : UNKNOWN_FLOOR_KEY;
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(room);
    }
    const order = [...(floorOrder ?? []), UNKNOWN_FLOOR_KEY].filter((k) => bySection.has(k));
    const out: ListItem[] = [];
    for (const key of order) {
      out.push({
        kind: 'header',
        key: `hdr-${key}`,
        label: key === UNKNOWN_FLOOR_KEY ? 'FLOOR UNKNOWN' : `FLOOR ${key}`,
      });
      out.push(
        ...bySection
          .get(key)!
          .sort(byGalleryNumber)
          .map((room) => ({ kind: 'room' as const, key: room.id, room })),
      );
    }
    // Chips only for floors that actually hold a room (never the unknown bucket).
    return { items: out, floorChips: order.filter((k) => k !== UNKNOWN_FLOOR_KEY) };
  }, [rooms, grouped, floorOrder]);

  const listRef = useRef<FlatList<ListItem>>(null);
  const scrollToFloor = (label: string) => {
    const index = items.findIndex((it) => it.kind === 'header' && it.label === `FLOOR ${label}`);
    if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0 });
  };

  return (
    <View style={[styles.container, { paddingTop: topInset }]} testID={testID}>
      {floorChips.length > 0 && (
        <View style={styles.chipRow} testID="room-list-floor-chips">
          {floorChips.map((label) => (
            <Pressable
              key={label}
              style={styles.chip}
              onPress={() => scrollToFloor(label)}
              testID={`room-list-floor-${label}`}
            >
              <Text style={styles.chipText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(it) => it.key}
        style={styles.list}
        onScrollToIndexFailed={() => {}}
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={styles.sectionHeader}>{item.label}</Text>
          ) : (
            <RoomRow
              room={item.room}
              // Bare gallery number for display — item.room.id is site-scoped
              // ("aic:243") to disambiguate the testID/lookup key, but the
              // visible meta line should read "Gallery 243", not the scope
              // prefix (found during the D8 multi-museum gate-video work).
              meta={`Gallery ${parseRoomId(item.room.id).galleryNumber}`}
              testID={`room-list-row-${item.room.id}`}
            />
          )
        }
        contentContainerStyle={[styles.listContent, { paddingBottom: spacing.xxl + bottomInset }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  chip: {
    minHeight: 36,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  chipText: {
    ...type.label,
    letterSpacing: 0,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.xxl,
  },
  sectionHeader: {
    ...type.label,
    color: colors.inkSecondary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
});
