/**
 * ScopeChips — the museum-scope toggle shown under the search field on
 * `/search` and `/results` once the artifact carries more than one museum
 * (C2). Two mutually-exclusive chips: the active museum ("AT {shortName}")
 * or "All museums" (the default). Selecting the museum chip scopes
 * searchAutocomplete/searchAll at the SQL level (museum filter) and hides
 * the OTHER MUSEUMS section; state is component-local, not persisted.
 * Reuses SearchFilterChips' Chip anatomy/styling for visual consistency.
 */
import { StyleSheet, View } from 'react-native';

import { Chip } from '@/components/SearchFilterChips';
import { spacing } from '@/theme';

export type MuseumScope = 'here' | 'all';

export default function ScopeChips({
  activeLabel,
  scope,
  onChange,
}: {
  /** Active museum's shortName, e.g. "The Met". */
  activeLabel: string;
  scope: MuseumScope;
  onChange: (next: MuseumScope) => void;
}) {
  return (
    <View style={styles.row} testID="scope-chips">
      <Chip
        label={activeLabel}
        active={scope === 'here'}
        onPress={() => onChange('here')}
        testID="scope-chip-here"
      />
      <Chip
        label="All museums"
        active={scope === 'all'}
        onPress={() => onChange('all')}
        testID="scope-chip-all"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
});
