/**
 * RoutePolyline — SVG group tracing a route across the floor plan.
 *
 * Rendered INSIDE FloorMap via its `overlay` prop, i.e. inside the map's
 * pan/zoom transform and SVG viewBox — so the path and checkpoint dots track
 * the floor plan through every gesture state. (This replaces the Phase-2
 * absolutely-positioned sibling overlay, whose known limitation was exactly
 * that: FloorMap's pinch/pan transform lived inside FloorMap, so zooming the
 * map offset the overlay.)
 *
 * Two coordinate sources, one render path:
 *  - `route.geo` (real provider): the shared/routing node path pre-projected
 *    into FloorMap's meter space (see the Route.geo contract in
 *    src/data/provider.ts) — the polyline follows real doorways. The viewBox
 *    of that projection equals the map's, so coordinates land 1:1.
 *  - stub fallback: straight segments between step-room rect centers in the
 *    stub's 130×80 schematic space.
 */
import { Circle, G, Polyline } from 'react-native-svg';

import { labelPassThrough } from '@/components/FloorMap';
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

/** Route line geometry: the real node path when present, else step centers. */
function linePoints(route: Route): { x: number; y: number; floor: number }[] {
  return (
    route.geo?.path ??
    route.steps.map((s) => {
      const [x, y, w, h] = s.room.rect;
      return { x: x + w / 2, y: y + h / 2, floor: s.room.floor };
    })
  );
}

/**
 * Bounding box (viewBox coords) of the route's segment on `floor` — what the
 * nav-mode map fit centers on. Undefined when the route never touches the
 * floor (the map then keeps its current viewport).
 */
export function routeBoundsOnFloor(
  route: Route,
  floor: number,
): { x: number; y: number; w: number; h: number } | undefined {
  const pts = linePoints(route).filter((p) => p.floor === floor);
  for (const s of route.steps) {
    if (s.room.floor !== floor) continue;
    const [x, y, w, h] = s.room.rect;
    pts.push({ x: x + w / 2, y: y + h / 2, floor });
  }
  if (pts.length === 0) return undefined;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export default function RoutePolyline({ route, floor, activeStep }: RoutePolylineProps) {
  const vb = route.geo?.view ?? STUB_VIEW;
  // Stroke/marker sizes are tuned for the 130-unit stub box; scale them with
  // the viewBox so the real meter-space map gets the same visual weight.
  const u = vb.w / STUB_VIEW.w;

  const linePts = linePoints(route);

  // Split the path into contiguous same-floor runs so a line never crosses
  // "through" a stairs/elevator floor change. The displayed floor's runs draw
  // solid; other floors' runs draw dimmed underneath — cross-floor routes
  // stay legible without switching floors (the Met Explorer pattern).
  const runs: { points: string; onFloor: boolean }[] = [];
  let current: string[] = [];
  let currentOn: boolean | null = null;
  const flush = () => {
    if (current.length > 1 && currentOn !== null)
      runs.push({ points: current.join(' '), onFloor: currentOn });
    current = [];
  };
  for (const p of linePts) {
    const on = p.floor === floor;
    if (currentOn !== null && on !== currentOn) flush();
    currentOn = on;
    current.push(`${p.x},${p.y}`);
  }
  flush();

  // Checkpoint dots always sit at step rooms (rect centers work in both
  // spaces: real-provider Room.rect is the projected polygon bbox).
  const stepPts = route.steps.map((s, i) => {
    const [x, y, w, h] = s.room.rect;
    return { x: x + w / 2, y: y + h / 2, floor: s.room.floor, index: i };
  });
  const onFloor = stepPts.filter((p) => p.floor === floor);

  return (
    // Pass-through pointer events: route art must never intercept room taps.
    <G testID="route-polyline" {...labelPassThrough}>
      {runs.map((run, i) => (
        <Polyline
          key={i}
          points={run.points}
          fill="none"
          stroke={colors.red}
          strokeOpacity={run.onFloor ? 1 : 0.25}
          strokeWidth={(run.onFloor ? 1 : 0.7) * u}
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
    </G>
  );
}
