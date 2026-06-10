/**
 * MuseWalk theme — our own visual language: black/white with Met-red
 * (#e4002b) accents, serif display type, all-caps nav labels, generous
 * whitespace. System serif stack (no font dependency).
 */
import { Platform } from 'react-native';

export const colors = {
  background: '#ffffff',
  surface: '#f6f5f3', // warm off-white panels
  ink: '#111111', // near-black text
  inkSecondary: '#55524e',
  inkFaint: '#8a8682',
  hairline: '#d9d6d2',
  red: '#e4002b', // Met red — accents, active states, highlights
  redPressed: '#b30022',
  // Current-location blue (home glyph). Paired with Met-red for the target
  // star: a colorblind-safe pair (no red/green) — see components/MapMarkers.
  homeBlue: '#1B6CA8',
  white: '#ffffff',
  black: '#000000',
  // Map-specific
  mapRoom: '#efedea',
  mapRoomStroke: '#b9b5b0',
  mapRoomActive: '#fbe3e8', // red-tinted highlight fill
  mapAmenity: '#e3e1de',
} as const;

/** 4pt-based spacing scale; generous whitespace is part of the look. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

const serif = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: "Georgia, 'Times New Roman', serif",
});

const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default:
    "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif",
});

export const type = {
  /** Big serif display, e.g. screen titles. */
  display: {
    fontFamily: serif,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700' as const,
    color: colors.ink,
  },
  /** Serif section/object titles. */
  title: {
    fontFamily: serif,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700' as const,
    color: colors.ink,
  },
  /** Body copy. */
  body: {
    fontFamily: sans,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400' as const,
    color: colors.ink,
  },
  /** Secondary/meta text (artist, date, credit lines). */
  meta: {
    fontFamily: sans,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400' as const,
    color: colors.inkSecondary,
  },
  /** All-caps nav/label style — the Met wayfinding voice. */
  label: {
    fontFamily: sans,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600' as const,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
    color: colors.ink,
  },
} as const;

export const theme = { colors, spacing, type } as const;
export type Theme = typeof theme;
