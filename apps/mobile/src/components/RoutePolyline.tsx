/**
 * RoutePolyline — SVG overlay tracing a route across the floor plan.
 * Rendered absolutely over <FloorMap> with the same viewBox/preserveAspectRatio
 * so coordinates line up at the map's default pan/zoom.
 *
 * Two coordinate sources, one render path:
 *  - `route.geo` (real provider): the shared/routing node path pre-projected
 *    into FloorMap's meter space + that projection's viewBox (see the Route.geo
 *    contract in src/data/provider.ts) — the polyline follows real doorways.
 *  - stub fallback: straight segments between step-room rect centers in the
 *    stub's 130×80 schematic space.
 *
 * (Known limitation, unchanged from Gate A: FloorMap's pinch/pan transform
 * lives inside FloorMap, so zooming the map offsets the overlay; folding the
 * polyline into the map's viewport is integration work once the real map's
 * overlay slot exists.)
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Route } from '@/data/provider';
import { colors } from '@/theme';

// Stub coordinate bounds — must match FloorMap's stub viewBox (stub.json).
const STUB_VIEW = { x: 0, y: 0, w: 130, h: 80 };

export interface RoutePolylineProps {
  route: Route;
  /** Floor currently shown on the underlying FloorMap. */
  floor: number;
  /** Index of the active step (gets the big red dot). */
  activeStep: number;
}

export default function RoutePolyline({ route, floor, activeStep }: RoutePolylineProps) {
  const vb = route.geo?.view ?? STUB_VIEW;
  // Stroke/marker sizes are tuned for the 130-unit stub box; scale them with
  // the viewBox so the real meter-space map gets the same visual weight.
  const u = vb.w / STUB_VIEW.w;

  // Line geometry: the real node path when present, else step-room centers.
  const linePts =
    route.geo?.path ??
    route.steps.map((s) => {
      const [x, y, w, h] = s.room.rect;
      return { x: x + w / 2, y: y + h / 2, floor: s.room.floor };
    });

  // Split the path into contiguous runs on the displayed floor so we never
  // draw a line "through" a stairs/elevator floor change.
  const runs: string[] = [];
  let current: string[] = [];
  for (const p of linePts) {
    if (p.floor === floor) {
      current.push(`${p.x},${p.y}`);
    } else if (current.length) {
      if (current.length > 1) runs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 1) runs.push(current.join(' '));

  // Checkpoint dots always sit at step rooms (rect centers work in both
  // spaces: real-provider Room.rect is the projected polygon bbox).
  const stepPts = route.steps.map((s, i) => {
    const [x, y, w, h] = s.room.rect;
    return { x: x + w / 2, y: y + h / 2, floor: s.room.floor, index: i };
  });
  const onFloor = stepPts.filter((p) => p.floor === floor);

  return (
    // pointerEvents in style — the prop form logs an RN-web deprecation warning.
    <View
      style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
      testID="route-polyline"
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {runs.map((points, i) => (
          <Polyline
            key={i}
            points={points}
            fill="none"
            stroke={colors.red}
            strokeWidth={1 * u}
            strokeDasharray={`${2.5 * u} ${1.5 * u}`}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {onFloor.map((p) =>
          p.index === activeStep ? (
            <Circle key={p.index} cx={p.x} cy={p.y} r={2.4 * u} fill={colors.red} />
          ) : (
            <Circle
              key={p.index}
              cx={p.x}
              cy={p.y}
              r={1.3 * u}
              fill={colors.white}
              stroke={colors.red}
              strokeWidth={0.6 * u}
            />
          ),
        )}
      </Svg>
    </View>
  );
}
