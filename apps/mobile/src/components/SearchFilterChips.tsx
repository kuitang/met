/**
 * Filter chips for the All Results screen: Floor, Site, Permanent/Exhibition,
 * Has image. Each group is a mutually-exclusive toggle (tap again to clear).
 */
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { MetObject } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export interface ResultFilters {
  floor?: number;
  site?: 'fifth' | 'cloisters';
  rotation?: 'permanent' | 'exhibition';
  hasImage?: boolean;
}

/**
 * Apply filters against stub data. `floorOf` resolves a gallery number to a
 * floor via the stub map (galleries outside the drawn stub map have no floor
 * and are excluded when a floor filter is active).
 */
export function applyFilters(
  objects: MetObject[],
  f: ResultFilters,
  floorOf: (galleryId: string) => number | undefined,
): MetObject[] {
  return objects.filter((o) => {
    if (f.floor !== undefined && floorOf(o.gallery) !== f.floor) return false;
    if (f.site && (o.dept === 'The Cloisters' ? 'cloisters' : 'fifth') !== f.site)
      return false;
    // Stub data is all permanent collection; the real provider will carry a
    // rotation field. "Exhibition" therefore filters to zero rows for now.
    if (f.rotation === 'exhibition') return false;
    if (f.hasImage && !o.img) return false;
    return true;
  });
}

/** Exported so other scoping chip rows (e.g. ScopeChips) share the same anatomy/styling. */
export function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export default function SearchFilterChips({
  filters,
  onChange,
}: {
  filters: ResultFilters;
  onChange: (next: ResultFilters) => void;
}) {
  const toggle = <K extends keyof ResultFilters>(key: K, value: ResultFilters[K]) =>
    onChange({ ...filters, [key]: filters[key] === value ? undefined : value });

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.row}
      testID="filter-chips"
    >
      <Chip
        label="Floor 1"
        active={filters.floor === 1}
        onPress={() => toggle('floor', 1)}
        testID="filter-floor-1"
      />
      <Chip
        label="Floor 2"
        active={filters.floor === 2}
        onPress={() => toggle('floor', 2)}
        testID="filter-floor-2"
      />
      <Chip
        label="Fifth Ave"
        active={filters.site === 'fifth'}
        onPress={() => toggle('site', 'fifth')}
        testID="filter-site-fifth"
      />
      <Chip
        label="Cloisters"
        active={filters.site === 'cloisters'}
        onPress={() => toggle('site', 'cloisters')}
        testID="filter-site-cloisters"
      />
      <Chip
        label="Permanent"
        active={filters.rotation === 'permanent'}
        onPress={() => toggle('rotation', 'permanent')}
        testID="filter-rotation-permanent"
      />
      <Chip
        label="Exhibition"
        active={filters.rotation === 'exhibition'}
        onPress={() => toggle('rotation', 'exhibition')}
        testID="filter-rotation-exhibition"
      />
      <Chip
        label="Has image"
        active={!!filters.hasImage}
        onPress={() => toggle('hasImage', true)}
        testID="filter-has-image"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexGrow: 0,
    // RN-web ScrollView defaults to flexShrink:1, and the sibling results
    // FlatList's flex-basis is its full content height — with a long result
    // list (e.g. 145 rows for "sphinx" on the real provider) flexbox shrinks
    // this strip to a few px and the chips render as clipped, label-less top
    // slivers. The strip must keep its intrinsic height; the list scrolls.
    flexShrink: 0,
  },
  row: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.white,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
  },
  chipActive: {
    borderColor: colors.red,
    backgroundColor: colors.red,
  },
  chipText: {
    ...type.label,
    letterSpacing: 1,
  },
  chipTextActive: {
    color: colors.white,
  },
});
