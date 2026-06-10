import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import ObjectImage from '@/components/ObjectImage';
import { useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function ObjectScreen() {
  const data = useData();
  // `anchor` (optional) = the visitor's last confirmed room, threaded through
  // so "Navigate here" starts from where they actually are.
  const { id, anchor } = useLocalSearchParams<{ id: string; anchor?: string }>();
  const object = data.getObject(Number(id));

  if (!object) {
    return (
      <View style={styles.container}>
        <Text style={[type.body, styles.notFound]}>
          Object {id} not found in stub data.
        </Text>
      </View>
    );
  }

  const gallery = object.gallery ? data.getGallery(object.gallery) : undefined;

  // J15: next/previous within the same room — browse a gallery's objects
  // sequentially without re-searching.
  const roomMates = object.gallery ? data.objectsInGallery(object.gallery) : [];
  const roomIndex = roomMates.findIndex((o) => o.objectID === object.objectID);
  const cycleTo = (offset: number) => {
    const next = roomMates[(roomIndex + offset + roomMates.length) % roomMates.length];
    router.replace({
      pathname: '/object/[id]',
      params: anchor ? { id: String(next.objectID), anchor } : { id: String(next.objectID) },
    });
  };

  const objectURL = `https://www.metmuseum.org/art/collection/search/${object.objectID}`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {object.img ? <ObjectImage uri={object.img} /> : null}

      {roomMates.length > 1 && (
        <View style={styles.cycleRow}>
          <Pressable style={styles.cycleBtn} onPress={() => cycleTo(-1)} testID="object-prev">
            <Text style={styles.cycleArrow}>‹</Text>
          </Pressable>
          <Text style={styles.cycleLabel} testID="object-position">
            {roomIndex + 1} of {roomMates.length} in Gallery {object.gallery}
          </Text>
          <Pressable style={styles.cycleBtn} onPress={() => cycleTo(1)} testID="object-next">
            <Text style={styles.cycleArrow}>›</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.title} testID="object-title">
        {object.title}
      </Text>
      <Text style={type.meta}>
        {object.artist || object.dept}
        {object.date ? ` · ${object.date}` : ''}
      </Text>
      <Text style={type.meta}>{object.medium}</Text>
      <Text style={[type.meta, styles.credit]}>
        {object.credit} ({object.accession})
      </Text>

      <View style={styles.galleryRow}>
        <Text style={styles.galleryChip} testID="object-gallery-chip">
          {object.gallery ? `GALLERY ${object.gallery}` : 'NOT ON VIEW'}
        </Text>
        {gallery && (
          <Text style={type.meta}>
            On view · {gallery.name} · Floor {gallery.floor}
          </Text>
        )}
        {object.gallery && !gallery && (
          <Text style={type.meta}>On view (gallery not in stub map)</Text>
        )}
      </View>

      {gallery && (
        <Pressable
          style={styles.navigateBtn}
          onPress={() =>
            router.push({
              pathname: '/route/[from]/[to]',
              params: { from: anchor ?? 'great-hall', to: gallery.id },
            })
          }
          testID="navigate-here"
        >
          <Text style={styles.navigateBtnText}>Navigate here</Text>
        </Pressable>
      )}

      <Pressable
        style={styles.linkOut}
        onPress={() => Linking.openURL(objectURL)}
        testID="object-met-link"
      >
        <Text style={styles.linkOutText}>View on metmuseum.org ↗</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  notFound: {
    padding: spacing.lg,
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  cycleBtn: {
    width: 40,
    height: 40,
    borderWidth: 1,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cycleArrow: {
    ...type.title,
    fontSize: 24,
    lineHeight: 28,
  },
  cycleLabel: {
    ...type.label,
    color: colors.inkSecondary,
  },
  title: {
    ...type.display,
    fontSize: 26,
    lineHeight: 32,
  },
  credit: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
  },
  galleryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  galleryChip: {
    ...type.label,
    color: colors.red,
  },
  navigateBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.red,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  navigateBtnText: {
    ...type.label,
    color: colors.white,
  },
  linkOut: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  linkOutText: {
    ...type.label,
  },
});
