/**
 * HomeRoomSheet — bottom sheet shown when a room is tapped on the Home map.
 * Gallery title + the objects in that room; tap an object for its detail
 * page. Two equal-weight actions (user mandate): DIRECTIONS routes there
 * from the current anchor; I'M HERE resets the anchor to this room.
 *
 * Detent/drag/snap mechanics live in DetentSheet (extracted in the nav-mode
 * pass so the navigation teardown shares the identical machinery); this file
 * owns only the room content: header anatomy, action row, object list, and
 * the thin amenity variant (one tap grammar, PR #13).
 */
import { router } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import DetentSheet, { HALF_VISIBLE } from '@/components/DetentSheet';
import { floorLabel } from '@/components/MapGeometry';
import { ObjectThumb } from '@/components/ObjectImage';
import { roomGlyph } from '@/components/RoomRow';
import { MetObject, Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export type { SheetDetent } from '@/components/DetentSheet';

/** HALF height of the thin amenity variant: header + action row only. */
const AMENITY_HALF_VISIBLE = 220;

export interface HomeRoomSheetProps {
  room: Room;
  /** Display list — capped by the provider (500) in dense galleries. */
  objects: MetObject[];
  /** TRUE object count of the room; may exceed objects.length. */
  totalCount: number;
  /** Route origin (current anchor room, or the Great Hall fallback). */
  originId: string;
  /** "I'm here" — reset the visitor's anchor to this room. */
  onImHere: () => void;
  /**
   * DIRECTIONS — the parent owns the navigation (home enters nav mode via
   * `?nav=` params, or retargets in place when already navigating) and
   * closes the sheet. Hidden when the room already is the origin.
   */
  onDirections?: () => void;
  onClose: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export default function HomeRoomSheet({
  room,
  objects,
  totalCount,
  originId,
  onImHere,
  onDirections,
  onClose,
}: HomeRoomSheetProps) {
  const insets = useSafeAreaInsets();

  // Thin amenity variant (one tap grammar): amenities have no object list —
  // the sheet is kind glyph + name + floor + the two actions, nothing else.
  const isAmenity = room.kind !== 'gallery' && room.kind !== 'hall';

  const header = (
    <View style={styles.headerRow}>
      {/* Amenity sheets lead with the kind glyph (WC / ELEV / CAFE …),
          same wayfinding code as the search room rows. */}
      {isAmenity && (
        <View style={styles.glyphBox} testID="sheet-amenity-glyph">
          <Text style={styles.glyphText} numberOfLines={1}>
            {roomGlyph(room)}
          </Text>
        </View>
      )}
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={2}>
          {room.name}
        </Text>
        <Text style={type.meta}>
          {/* Label vocabulary (G / 1M / …), not the numeric floor. */}
          Floor {floorLabel(room.floor)}
          {/* Honest count: the list is capped, the total is not. */}
          {!isAmenity && totalCount > 0
            ? objects.length < totalCount
              ? ` · Showing ${fmt(objects.length)} of ${fmt(totalCount)} objects`
              : ` · ${fmt(totalCount)} ${totalCount === 1 ? 'object' : 'objects'}`
            : ''}
        </Text>
      </View>
      <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8} testID="room-sheet-close">
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );

  return (
    <DetentSheet
      header={header}
      halfVisible={isAmenity ? AMENITY_HALF_VISIBLE : HALF_VISIBLE}
      resetKey={room.id}
      testID="room-sheet"
    >
      {() => (
        <>
          <View style={styles.actionRow}>
            {originId !== room.id && onDirections && (
              <Pressable
                style={[styles.actionBtn, styles.directionsBtn]}
                onPress={onDirections}
                testID="room-directions"
              >
                <Text style={styles.actionText}>Directions</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.actionBtn, styles.imHereBtn]}
              onPress={onImHere}
              testID="room-im-here"
            >
              <Text style={styles.actionText}>I'm here</Text>
            </Pressable>
          </View>

          {isAmenity ? null : objects.length > 0 ? (
            <FlatList
              data={objects}
              keyExtractor={(o) => String(o.objectID)}
              style={styles.list}
              contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => router.push(`/object/${item.objectID}`)}
                  testID={`sheet-object-${item.objectID}`}
                >
                  {item.img ? (
                    // Tigris CDN first, proxy fallback — see data/imageCdn.ts.
                    <ObjectThumb object={item} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbEmpty]} />
                  )}
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={type.meta} numberOfLines={1}>
                      {item.artist || item.dept}
                      {item.date ? ` · ${item.date}` : ''}
                    </Text>
                  </View>
                </Pressable>
              )}
            />
          ) : (
            <Text style={styles.empty}>No objects recorded in this room yet.</Text>
          )}
        </>
      )}
    </DetentSheet>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  // Amenity-kind glyph box — same wayfinding code language as RoomRow.
  glyphBox: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
  },
  glyphText: {
    ...type.label,
    letterSpacing: 0,
    fontSize: 11,
    lineHeight: 14,
  },
  title: {
    ...type.title,
    fontSize: 20,
    lineHeight: 26,
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  closeText: {
    ...type.label,
    letterSpacing: 0,
  },
  // Two equal-weight actions: route there vs. relocate to here (PR #8).
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  directionsBtn: {
    backgroundColor: colors.red,
  },
  imHereBtn: {
    backgroundColor: colors.homeBlue,
  },
  actionText: {
    ...type.label,
    color: colors.white,
  },
  list: {
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  thumb: {
    width: 44,
    height: 44,
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
  empty: {
    ...type.meta,
    paddingVertical: spacing.md,
  },
});
