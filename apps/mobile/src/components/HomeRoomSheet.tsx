/**
 * HomeRoomSheet — bottom sheet shown when a room is tapped on the Home map.
 * Gallery title + the objects in that room; tap an object for its detail
 * page. Two equal-weight actions (user mandate): DIRECTIONS routes there
 * from the current anchor; I'M HERE resets the anchor to this room.
 */
import { router } from 'expo-router';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { objectImageSrc } from '@/components/ObjectImage';
import { MetObject, Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

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
  onClose: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export default function HomeRoomSheet({
  room,
  objects,
  totalCount,
  originId,
  onImHere,
  onClose,
}: HomeRoomSheetProps) {
  const { dataVersion } = useData();
  return (
    <View style={styles.sheet} testID="room-sheet">
      <View style={styles.grabber} />
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={2}>
            {room.name}
          </Text>
          <Text style={type.meta}>
            Floor {room.floor}
            {/* Honest count: the list is capped, the total is not. */}
            {totalCount > 0
              ? objects.length < totalCount
                ? ` · Showing ${fmt(objects.length)} of ${fmt(totalCount)} objects`
                : ` · ${fmt(totalCount)} ${totalCount === 1 ? 'object' : 'objects'}`
              : ''}
          </Text>
        </View>
        <Pressable
          style={styles.closeBtn}
          onPress={onClose}
          hitSlop={8}
          testID="room-sheet-close"
        >
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.actionRow}>
        {originId !== room.id && (
          <Pressable
            style={[styles.actionBtn, styles.directionsBtn]}
            onPress={() => router.push(`/route/${originId}/${room.id}`)}
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

      {objects.length > 0 ? (
        <FlatList
          data={objects}
          keyExtractor={(o) => String(o.objectID)}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/object/${item.objectID}`)}
              testID={`sheet-object-${item.objectID}`}
            >
              {item.img ? (
                // Proxy on web (COEP blocks the raw CDN) — see objectImageSrc.
                <Image
                  source={{ uri: objectImageSrc(item.img, item.objectID, dataVersion) }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
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
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    maxHeight: 340,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    backgroundColor: colors.hairline,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 2,
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
  // Equal-weight action pair, ≥44pt tap targets (HIG).
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
