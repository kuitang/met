/**
 * RoutePolyline — SVG overlay tracing a route across the stub floor plan.
 * Rendered absolutely over <FloorMap> with the same viewBox/preserveAspectRatio
 * so coordinates line up at the map's default pan/zoom. (Known stub limitation:
 * FloorMap's pinch/pan transform lives inside FloorMap, so zooming the mini map
 * offsets the overlay; Phase 2 folds the polyline into the real map component.)
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Route } from '@/data/provider';
import { colors } from '@/theme';

// Must match FloorMap's stub coordinate bounds (src/data/stub.json).
const VIEW_W = 130;
const VIEW_H = 80;

export interface RoutePolylineProps {
  route: Route;
  /** Floor currently shown on the underlying FloorMap. */
  floor: number;
  /** Index of the active step (gets the big red dot). */
  activeStep: number;
}

export default function RoutePolyline({ route, floor, activeStep }: RoutePolylineProps) {
  const pts = route.steps.map((s, i) => {
    const [x, y, w, h] = s.room.rect;
    return { x: x + w / 2, y: y + h / 2, floor: s.room.floor, index: i };
  });

  // Split the path into contiguous runs on the displayed floor so we never
  // draw a line "through" a stairs/elevator floor change.
  const runs: string[] = [];
  let current: string[] = [];
  for (const p of pts) {
    if (p.floor === floor) {
      current.push(`${p.x},${p.y}`);
    } else if (current.length) {
      if (current.length > 1) runs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 1) runs.push(current.join(' '));

  const onFloor = pts.filter((p) => p.floor === floor);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="route-polyline">
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {runs.map((points, i) => (
          <Polyline
            key={i}
            points={points}
            fill="none"
            stroke={colors.red}
            strokeWidth={1}
            strokeDasharray="2.5 1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {onFloor.map((p) =>
          p.index === activeStep ? (
            <Circle key={p.index} cx={p.x} cy={p.y} r={2.4} fill={colors.red} />
          ) : (
            <Circle
              key={p.index}
              cx={p.x}
              cy={p.y}
              r={1.3}
              fill={colors.white}
              stroke={colors.red}
              strokeWidth={0.6}
            />
          ),
        )}
      </Svg>
    </View>
  );
}
