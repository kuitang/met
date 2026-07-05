/**
 * WayfindingCard — static location context for a graphless museum's room
 * (`capabilities.hasGraph: false` — every non-Met museum today; see
 * data/src/sources/registry.ts). Wherever a DIRECTIONS action would
 * otherwise route the visitor there, there is no graph to compute a path
 * over — this renders the room's identity instead, so the slot is never just
 * empty: a large room-code glyph (the same wayfinding idiom as RoomRow's/
 * HomeRoomSheet's amenity glyph box) + the room's name + a meta line
 * ("Floor 2 · Art Institute of Chicago") — floor omitted when the source
 * data doesn't know it (AIC/SMK ship galleries with no authoritative
 * floor mapping; floorLabel('') signals this, not "Floor NaN").
 *
 * Two surfaces, one `compact` toggle:
 *  - object page location card (full-size) — replaces "Navigate here".
 *  - HomeRoomSheet's action row (compact) — replaces the hidden DIRECTIONS
 *    button; "I'm here" stays (anchoring at a room is still honest without a
 *    graph — only routing there is not).
 */
import { StyleSheet, Text, View } from 'react-native';

import { floorLabel } from '@/components/MapGeometry';
import { roomGlyph } from '@/components/RoomRow';
import { Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function WayfindingCard({
  room,
  museumShortName,
  compact,
  testID,
}: {
  room: Room;
  museumShortName: string;
  /** Compact = HomeRoomSheet's action-row variant (smaller glyph, one line). */
  compact?: boolean;
  testID?: string;
}) {
  const floorTxt = floorLabel(room.floor, room.site);
  const metaLine = [floorTxt ? `Floor ${floorTxt}` : null, museumShortName]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.card, compact && styles.cardCompact]} testID={testID}>
      <View style={[styles.glyphBox, compact && styles.glyphBoxCompact]}>
        <Text
          style={[styles.glyphText, compact && styles.glyphTextCompact]}
          numberOfLines={1}
        >
          {roomGlyph(room)}
        </Text>
      </View>
      <View style={styles.textCol}>
        <Text style={compact ? styles.roomNameCompact : styles.roomName} numberOfLines={compact ? 1 : 2}>
          {room.name}
        </Text>
        {metaLine ? (
          <Text style={type.meta} numberOfLines={1}>
            {metaLine}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  cardCompact: {
    flex: 1,
    minHeight: 44, // HIG tap target parity with the button it replaces
    padding: spacing.sm,
  },
  glyphBox: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  glyphBoxCompact: {
    width: 36,
    height: 36,
  },
  glyphText: {
    ...type.title,
    fontSize: 20,
    lineHeight: 24,
  },
  glyphTextCompact: {
    ...type.label,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  roomName: {
    ...type.title,
    fontSize: 18,
    lineHeight: 23,
  },
  roomNameCompact: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
});
