/**
 * AttributionFooter — the object page's outbound attribution block: the
 * owning museum's license attribution line + "View on {host} ↗"
 * (objectSourceUrl; the SAME testID `object-met-link` the old standalone
 * Pressable used, so the single-museum stub check keeps passing
 * byte-for-byte — BUILTIN_MET_ENTRY already carries the Met's real CC0
 * attribution/terms) + a link out to the museum's own terms page.
 *
 * Every museum in the registry ships license.attribution/termsUrl (required
 * MuseumEntry fields — see shared/openapi.yaml), so this never degrades: it
 * is generalized identically for the Met and every other museum, not a
 * non-Met special case.
 */
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MuseumEntry } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function AttributionFooter({
  museum,
  objectURL,
  objectURLHost,
  testID,
}: {
  museum: MuseumEntry;
  objectURL: string;
  objectURLHost: string;
  testID?: string;
}) {
  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.attribution} testID="object-attribution-text">
        {museum.license.attribution}
      </Text>
      <Pressable
        style={styles.linkOut}
        onPress={() => Linking.openURL(objectURL)}
        testID="object-met-link"
      >
        <Text style={styles.linkOutText}>View on {objectURLHost} ↗</Text>
      </Pressable>
      {museum.license.termsUrl ? (
        <Pressable
          style={styles.termsLink}
          onPress={() => Linking.openURL(museum.license.termsUrl)}
          testID="object-terms-link"
        >
          <Text style={styles.termsLinkText}>{museum.shortName} usage terms ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  attribution: {
    ...type.meta,
    fontSize: 12,
    color: colors.inkFaint,
  },
  linkOut: {
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    minHeight: 44, // HIG tap target
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  linkOutText: {
    ...type.label,
  },
  termsLink: {
    paddingVertical: spacing.sm,
    minHeight: 44, // HIG tap target
    alignItems: 'center',
    justifyContent: 'center',
  },
  termsLinkText: {
    ...type.meta,
    fontSize: 12,
    color: colors.inkFaint,
    textDecorationLine: 'underline',
  },
});
