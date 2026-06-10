/**
 * HomeRoomSheet — bottom sheet shown when a room is tapped on the Home map.
 * Gallery title + the objects in that room (stub data); tap an object for
 * its detail page, or get directions from the current anchor.
 */
import { router } from 'expo-router';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { MetObject, Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export interface HomeRoomSheetProps {
  room: Room;
  objects: MetObject[];
  /** Route origin (current anchor room, or the Great Hall fallback). */
  originId: string;
  onClose: () => void;
}

export default function HomeRoomSheet({ room, objects, originId, onClose }: HomeRoomSheetProps) {
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
            {objects.length > 0
              ? ` · ${objects.length} ${objects.length === 1 ? 'object' : 'objects'}`
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

      {originId !== room.id && (
        <Pressable
          style={styles.directionsBtn}
          onPress={() => router.push(`/route/${originId}/${room.id}`)}
          testID="room-directions"
        >
          <Text style={styles.directionsText}>Directions</Text>
        </Pressable>
      )}

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
                <Image source={{ uri: item.img }} style={styles.thumb} resizeMode="cover" />
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
        <Text style={styles.empty}>No stub objects recorded in this room.</Text>
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
  directionsBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.red,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  directionsText: {
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
