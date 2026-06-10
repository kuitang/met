/**
 * MapMarkers — the home (current location) / star (navigation target) glyph
 * language (user mandate, colorblind-safe): the SHAPES alone disambiguate the
 * two roles, so the color pairing avoids red/green entirely:
 *
 *   current location = HOME glyph, colors.homeBlue (#1B6CA8)
 *   navigation target = STAR glyph, colors.red (Met red #e4002b)
 *
 * Contrast on the map background (#efedea cream / #f6f5f3 surface), WCAG
 * relative-luminance math: #1B6CA8 ≈ 5.0:1, #e4002b ≈ 4.0:1 — both clear the
 * 3:1 graphics floor, and every map glyph additionally carries a white halo
 * stroke. For deuteranopia/protanopia the blue/red pair stays separable
 * (blue is unaffected; red darkens but the house-vs-star outline carries the
 * meaning regardless).
 *
 * Exports: raw path-d generators (for FloorMap's in-SVG markers, drawn in
 * viewBox units inside the pan/zoom transform) and standalone <Svg> icons
 * (header home button, floor-chip badges).
 */
import Svg, { Path } from 'react-native-svg';

import { colors } from '@/theme';

/** Filled house outline centered on (cx, cy); s = half-height. */
export function homePathD(cx: number, cy: number, s: number): string {
  const f = (n: number) => +n.toFixed(2);
  return [
    `M${f(cx)},${f(cy - s)}`, // roof apex
    `L${f(cx + s)},${f(cy - 0.2 * s)}`, // right eave
    `L${f(cx + 0.62 * s)},${f(cy - 0.2 * s)}`,
    `L${f(cx + 0.62 * s)},${f(cy + s)}`, // right wall
    `L${f(cx - 0.62 * s)},${f(cy + s)}`, // floor
    `L${f(cx - 0.62 * s)},${f(cy - 0.2 * s)}`, // left wall
    `L${f(cx - s)},${f(cy - 0.2 * s)}`, // left eave
    'Z',
  ].join('');
}

/** Five-pointed star centered on (cx, cy); s = outer radius. */
export function starPathD(cx: number, cy: number, s: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? s : 0.42 * s;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${+(cx + r * Math.cos(a)).toFixed(2)},${+(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Standalone home glyph (header button, floor-chip badge). */
export function HomeGlyph({ size = 16, color = colors.homeBlue }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="-10 -10 20 20">
      <Path d={homePathD(0, 0, 8.5)} fill={color} />
    </Svg>
  );
}

/** Standalone star glyph (floor-chip badge). */
export function StarGlyph({ size = 16, color = colors.red }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="-10 -10 20 20">
      <Path d={starPathD(0, 0, 9)} fill={color} />
    </Svg>
  );
}
