/**
 * StalenessBadge — "verified N days ago", from a museum's `fetchedAt` (or the
 * artifact's `builtAt` fallback — see provider.ts:museumFreshness). Purely a
 * function of elapsed time: it is NOT AIC/Louvre-specific — the Met shows the
 * identical line once its own record is old enough, and shows nothing when
 * fresh (the stub's BUILTIN_MET_ENTRY carries no date at all, so it always
 * renders nothing there — zero visual change for the single-museum stub).
 *
 * Two variants, both driven by the same three-tier threshold:
 *  - 'object' (object page location card): <14 days renders NOTHING (fresh
 *    enough that surfacing an exact count would be noise); 14–59 plain
 *    secondary text; ≥60 amber + "may have moved" (a Living Map-less museum's
 *    galleries can be rehung without us knowing).
 *  - 'picker' (locate sheet's per-museum venue group, C2's grouped picker):
 *    always renders the line, even under 14 days — reassurance that the
 *    museum's data freshness is visible before you commit to that venue.
 */
import { StyleSheet, Text } from 'react-native';

import { colors, type } from '@/theme';

export type StalenessTier = 'fresh' | 'aging' | 'stale';

/** Whole days elapsed since an ISO timestamp (floor, never negative — a clock-skewed future date reads as "today"). */
export function daysSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
}

export function stalenessTier(days: number): StalenessTier {
  if (days < 14) return 'fresh';
  if (days < 60) return 'aging';
  return 'stale';
}

function verifiedText(days: number): string {
  if (days === 0) return 'Verified today';
  if (days === 1) return 'Verified 1 day ago';
  return `Verified ${days.toLocaleString('en-US')} days ago`;
}

export default function StalenessBadge({
  fetchedAt,
  variant = 'object',
  testID,
}: {
  /** ISO date (museumFreshness result) — undefined = nothing to show. */
  fetchedAt?: string;
  variant?: 'object' | 'picker';
  testID?: string;
}) {
  if (!fetchedAt) return null;
  const days = daysSince(fetchedAt);
  const tier = stalenessTier(days);
  // The object page hides fresh records entirely; the picker always shows
  // its line (freshness is reassurance there, not just a warning).
  if (variant === 'object' && tier === 'fresh') return null;

  return (
    <Text style={[type.meta, tier === 'stale' && styles.stale]} testID={testID}>
      {verifiedText(days)}
      {tier === 'stale' ? ' — may have moved' : ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  stale: {
    color: colors.amber,
    fontWeight: '600',
  },
});
