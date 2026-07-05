/**
 * RoomRow — the single row anatomy for gallery and amenity results in the
 * search omnibar and the All Results page (user mandate): leading glyph
 * (room number / amenity-kind code in the Met wayfinding voice), name (+ one
 * meta line), right-aligned floor chip. NO inline action buttons — tapping
 * the row is the whole grammar: it lands on the home map with the room's
 * sheet open (DIRECTIONS / I'M HERE live there, equal weight).
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { floorLabel } from '@/components/MapGeometry';
import { encodeNavId, parseRoomId, Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

/** Amenity-kind glyph codes (wayfinding voice; map uses the same idiom). */
const KIND_GLYPH: Partial<Record<Room['kind'], string>> = {
  hall: 'HALL',
  restroom: 'WC',
  elevator: 'ELEV',
  escalator: 'ESC',
  stairs: 'ST',
  dining: 'CAFE',
  water: 'WTR',
  info: 'i',
  entrance: 'ENTR',
  shop: 'SHOP',
  tickets: 'TKT',
  cloakroom: 'COAT',
  firstAid: 'AID',
  library: 'LIB',
  auditorium: 'AUD',
  classroom: 'EDU',
  changing_room: 'FAM',
};

export function roomGlyph(room: Room): string {
  if (room.kind === 'gallery') {
    // The gallery number IS the room icon when it fits the box; non-numeric
    // codes ("Exhibition Galleries 999") fall back to a generic room glyph.
    // room.id is site-scoped ("aic:243") — glyph against the bare code so
    // every non-Met museum's rows don't all collapse to "GAL".
    const { galleryNumber } = parseRoomId(room.id);
    return /^\d{1,4}[A-Za-z]?$/.test(galleryNumber) ? galleryNumber : 'GAL';
  }
  return KIND_GLYPH[room.kind] ?? 'ROOM';
}

/**
 * One tap = map focused on the room: floor switched, gallery highlighted,
 * sheet open (index.tsx `focus` param). dismissTo, not push — the home map
 * is the stack root, so this unwinds back to it with new params instead of
 * stacking a second home screen (same idiom as the header HOME button).
 * `ts` busts expo-router's param equality so re-tapping the same room after
 * closing the sheet works.
 *
 * RETARGET branch (nav mode): when search was opened from the nav sheet's
 * destination title, `navFrom` carries the live origin — the tap swaps the
 * navigation target IN PLACE (`?nav=` on the existing home-nav entry, avoid
 * setting preserved) instead of opening the room's browse sheet.
 */
export function focusRoom(room: Room, navFrom?: string, avoidStairs?: boolean): void {
  if (navFrom) {
    router.dismissTo({
      pathname: '/',
      params: {
        nav: `${encodeNavId(navFrom)}:${encodeNavId(room.id)}`,
        ...(avoidStairs ? { avoid: 'stairs' } : null),
        ts: String(Date.now()),
      },
    });
    return;
  }
  router.dismissTo({ pathname: '/', params: { focus: room.id, ts: String(Date.now()) } });
}

export default function RoomRow({
  room,
  meta,
  testID,
  navFrom,
  avoidStairs,
}: {
  room: Room;
  /** Second line, e.g. "Gallery 131" or "~42 m walk". */
  meta?: string;
  testID?: string;
  /** Nav-mode retarget origin (see focusRoom). */
  navFrom?: string;
  avoidStairs?: boolean;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => focusRoom(room, navFrom, avoidStairs)}
      testID={testID}
    >
      <View style={styles.glyphBox}>
        <Text style={styles.glyphText} numberOfLines={1}>
          {roomGlyph(room)}
        </Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {room.name}
        </Text>
        {meta ? (
          <Text style={type.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {/* Unknown floor (C3: AIC/SMK ship galleries with no authoritative
          floor mapping) — omit the chip rather than print a bare "F". */}
      {floorLabel(room.floor, room.site) ? (
        <Text style={styles.floorChip}>F{floorLabel(room.floor, room.site)}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44, // HIG tap target — the whole row is the single action
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
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
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  floorChip: {
    ...type.label,
    color: colors.red,
    textAlign: 'right',
  },
});
