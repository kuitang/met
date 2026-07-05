/**
 * MuseumBadge — the trailing marker on an "other museum" search row (C2
 * sectioned multi-museum results): the floor/gallery chip a same-museum row
 * carries (see RoomRow's floorChip) doesn't apply to an object at a
 * different museum, so this replaces it. Same typography as that floor chip
 * (type.label + Met red) with an added border, so it reads as a distinct
 * "elsewhere" marker rather than a floor number.
 */
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, type } from '@/theme';

export default function MuseumBadge({
  shortName,
  testID,
}: {
  /** MuseumEntry.shortName, e.g. "Art Institute". Rendered in small caps. */
  shortName: string;
  testID?: string;
}) {
  return (
    <View style={styles.badge} testID={testID}>
      <Text style={styles.text} numberOfLines={1}>
        {shortName}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    // Never stretch to the parent's cross-axis width — results.tsx places
    // this inside a column (flex:1) rowText block alongside title/artist
    // Text, whose default `alignItems: 'stretch'` would otherwise blow the
    // badge out to the full row width.
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.red,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  text: {
    ...type.label,
    color: colors.red,
    letterSpacing: 0.5,
  },
});
