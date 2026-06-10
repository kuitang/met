/**
 * FloorMap — the floor plan.
 *
 * Two render paths behind one component:
 *  - Real geometry (Living Map polygons out of met.sqlite's blobs table) when
 *    the DataProvider implements galleriesGeometry(site, floor) — see
 *    MapGeometry.ts for the provider contract. Floor chips are driven by the
 *    data; the venue (Fifth Avenue ⇄ The Cloisters) is location state passed
 *    in via the `site` prop (no site switcher on the map — see LocateState);
 *    closed galleries render hatched/dimmed; gallery numbers label rooms
 *    (large rooms always, every room once zoomed in).
 *  - Stub schematic (rects from stub.json) when the provider is the Gate A
 *    stub — keeps the mockup checks green.
 *
 * Pan/zoom is a screen-space transform on a wrapping Animated.View (pinch +
 * drag + desktop wheel), so zooming never re-renders the SVG; room paths are
 * memoized per (site, floor) and each <RoomShape> is React.memo'd so a
 * highlight change re-renders one path, not ~300.
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  G,
  Line,
  Path,
  Pattern,
  Rect,
  Text as SvgText,
} from 'react-native-svg';

import {
  buildSiteGeometry,
  floorLabel,
  floorNumber,
  GeometryFn,
  MapShape,
  resolveGeometryFn,
  Site,
} from '@/components/MapGeometry';
import { Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

// Stub coordinate bounds (see src/data/stub.json).
const STUB_VIEW_W = 130;
const STUB_VIEW_H = 80;

const STUB_FLOOR_CHIPS = [
  { label: 'G', floor: 0, enabled: false }, // no ground-floor stub geometry
  { label: '1', floor: 1, enabled: true },
  { label: '2', floor: 2, enabled: true },
];

// Real-map label policy: big rooms always labeled; every room once zoomed in.
const LABEL_ZOOM = 1.6;
const LABEL_AREA_M2 = 150;

/**
 * Tap handler for an SVG shape. On web, react-native-svg implements onPress
 * via the legacy responder/Touchable mixin, which React DOM rejects with six
 * "Unknown event handler property" console errors per shape (and the Expo dev
 * LogBox badge those spawn fails the HIG tap-target sweep). Its `prepare()`
 * forwards unknown props verbatim to the DOM node, so a plain onClick is the
 * clean path there; native keeps onPress.
 */
/**
 * SVG label text must never intercept taps meant for the shape under it.
 * On web the pointerEvents *prop* trips RN-web's createDOMProps deprecation
 * warning (LogBox badge → HIG sweep failure); style is the clean route there
 * (prepare() resolves it onto the DOM node as CSS pointer-events).
 */
const labelPassThrough: object =
  Platform.OS === 'web' ? { style: { pointerEvents: 'none' } } : { pointerEvents: 'none' };

function svgPress(handler: () => void): object {
  // onPress: null (not undefined) on web — prepare() runs
  // `if (onPress !== null) clean.onClick = props.onPress`, so an undefined
  // onPress silently clobbers the forwarded onClick (measured: rect had
  // onClick: undefined). Null skips both the clobber and the responder mixin.
  return Platform.OS === 'web' ? { onClick: handler, onPress: null } : { onPress: handler };
}

export interface FloorMapProps {
  /** Room to render highlighted (e.g. current location or selection). */
  highlightId?: string;
  /** Rooms along an active route, tinted on the map. */
  routeRoomIds?: string[];
  onRoomPress?: (room: Room) => void;
  /** Controlled floor; if omitted the component manages its own. */
  floor?: number;
  onFloorChange?: (floor: number) => void;
  /**
   * Venue to render. Venue is location state, not map chrome (gate decision):
   * the map has no site switcher — callers pass the active venue from
   * LocateState (the locate sheet's segmented row / GPS auto-detect own it).
   * The stub schematic has Fifth Avenue only and ignores this.
   */
  site?: Site;
}

export default function FloorMap(props: FloorMapProps) {
  const data = useData();
  const geometry = useMemo(() => resolveGeometryFn(data), [data]);
  return geometry ? (
    <RealFloorMap geometry={geometry} {...props} />
  ) : (
    <StubFloorMap {...props} />
  );
}

/* ------------------------------------------------------------------ */
/* Shared pan/zoom viewport                                            */
/* ------------------------------------------------------------------ */

function MapViewport({
  children,
  maxScale = 4,
  onZoomEnd,
}: {
  children: React.ReactNode;
  maxScale?: number;
  /** Reported when a pinch/wheel settles — drives zoom-gated labels. */
  onZoomEnd?: (scale: number) => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(maxScale, Math.max(0.75, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (onZoomEnd) runOnJS(onZoomEnd)(scale.value);
    });

  const pan = Gesture.Pan()
    .minDistance(8)
    .maxPointers(1)
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const gesture = Gesture.Simultaneous(pinch, pan);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  // Desktop web: wheel-to-zoom (gesture-handler pinch is touch-only).
  const wheelProps =
    Platform.OS === 'web'
      ? ({
          onWheel: (e: { deltaY: number; preventDefault?: () => void }) => {
            e.preventDefault?.();
            const next = Math.min(
              maxScale,
              Math.max(0.75, scale.value * Math.exp(-e.deltaY / 300)),
            );
            scale.value = next;
            savedScale.value = next;
            onZoomEnd?.(next);
          },
        } as object)
      : null;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.mapArea, animatedStyle]} {...wheelProps}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

/* ------------------------------------------------------------------ */
/* Real geometry path                                                  */
/* ------------------------------------------------------------------ */

interface RoomShapeProps {
  shape: MapShape;
  highlighted: boolean;
  onRoute: boolean;
  onPressShape: (s: MapShape) => void;
}

const RoomShape = memo(function RoomShape({
  shape,
  highlighted,
  onRoute,
  onPressShape,
}: RoomShapeProps) {
  const active = highlighted || onRoute;
  const tappable = shape.kind === 'gallery';
  const fill = active
    ? colors.mapRoomActive
    : shape.kind === 'outline'
      ? colors.background
      : shape.kind === 'circulation'
        ? colors.surface
        : shape.kind === 'amenity'
          ? colors.mapAmenity
          : shape.closed
            ? 'url(#closed-hatch)'
            : colors.mapRoom;
  return (
    <Path
      d={shape.d}
      fill={fill}
      fillRule="evenodd"
      opacity={shape.closed && !active ? 0.55 : 1}
      stroke={highlighted ? colors.red : colors.mapRoomStroke}
      strokeWidth={highlighted ? 1 : shape.kind === 'gallery' ? 0.3 : 0.15}
      {...(tappable ? svgPress(() => onPressShape(shape)) : null)}
      testID={tappable ? `room-${shape.id}` : undefined}
    />
  );
});

function RealFloorMap({
  geometry,
  highlightId,
  routeRoomIds,
  onRoomPress,
  floor: floorProp,
  onFloorChange,
  site = 'fifthAve',
}: FloorMapProps & { geometry: GeometryFn }) {
  const siteGeo = useMemo(() => buildSiteGeometry(geometry, site), [geometry, site]);

  const [floorState, setFloorState] = useState('1');
  const requested = floorProp !== undefined ? floorLabel(floorProp) : floorState;
  // A floor the venue doesn't have (e.g. arriving at the Cloisters on "3")
  // falls back to 1 / the lowest — venue switches never strand the map.
  const floor = siteGeo.floors.includes(requested)
    ? requested
    : siteGeo.floors.includes('1')
      ? '1'
      : siteGeo.floors[0];
  const setFloor = (label: string) => {
    setFloorState(label);
    onFloorChange?.(floorNumber(label));
  };

  const [zoom, setZoom] = useState(1);
  const shapes = siteGeo.shapesByFloor.get(floor) ?? [];
  const routeSet = useMemo(() => new Set(routeRoomIds ?? []), [routeRoomIds]);

  const handlePress = useCallback(
    (shape: MapShape) => {
      onRoomPress?.({
        id: shape.id,
        name: shape.name,
        floor: shape.floorNumeric,
        kind: 'gallery',
        rect: shape.bbox,
      });
    },
    [onRoomPress],
  );

  const vb = siteGeo.viewBox;
  const labeled = shapes.filter(
    (s) =>
      s.kind === 'gallery' &&
      s.label &&
      (zoom >= LABEL_ZOOM || s.areaM2 >= LABEL_AREA_M2),
  );

  return (
    <View style={styles.container} testID="floor-map">
      {/* Marker for e2e: this subtree means real polygons, not the stub. */}
      <View style={styles.mapFill} testID="floor-map-real">
        {/* key={site}: reset pan/zoom when jumping between buildings. */}
        <MapViewport key={site} maxScale={8} onZoomEnd={setZoom}>
          <Svg
            width="100%"
            height="100%"
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <Defs>
              <Pattern
                id="closed-hatch"
                patternUnits="userSpaceOnUse"
                width={3}
                height={3}
                patternTransform="rotate(45)"
              >
                <Rect width={3} height={3} fill={colors.mapRoom} />
                <Line x1={0} y1={0} x2={0} y2={3} stroke={colors.mapRoomStroke} strokeWidth={1} />
              </Pattern>
            </Defs>
            <G>
              {shapes.map((s) => (
                <RoomShape
                  key={s.id}
                  shape={s}
                  highlighted={s.id === highlightId}
                  onRoute={routeSet.has(s.id)}
                  onPressShape={handlePress}
                />
              ))}
              {labeled.map((s) => (
                <SvgText
                  key={`label-${s.id}`}
                  x={s.labelX}
                  y={s.labelY + 1}
                  fontSize={s.areaM2 >= LABEL_AREA_M2 ? 3.6 : 2.4}
                  fontFamily={type.label.fontFamily}
                  fill={
                    s.id === highlightId
                      ? colors.red
                      : s.closed
                        ? colors.inkFaint
                        : colors.inkSecondary
                  }
                  textAnchor="middle"
                  {...labelPassThrough}
                >
                  {s.label}
                </SvgText>
              ))}
            </G>
          </Svg>
        </MapViewport>
      </View>

      <View style={styles.chips}>
        {siteGeo.floors.map((label) => {
          const active = label === floor;
          return (
            <Pressable
              key={label}
              onPress={() => setFloor(label)}
              testID={`floor-chip-${label}`}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Stub schematic path (Gate A mockup)                                 */
/* ------------------------------------------------------------------ */

function StubFloorMap({
  highlightId,
  routeRoomIds,
  onRoomPress,
  floor: floorProp,
  onFloorChange,
}: FloorMapProps) {
  const data = useData();
  const [floorState, setFloorState] = useState(1);
  const floor = floorProp ?? floorState;
  const setFloor = (f: number) => {
    setFloorState(f);
    onFloorChange?.(f);
  };

  const rooms = useMemo(
    () => [...data.galleries(), ...data.amenities()].filter((r) => r.floor === floor),
    [data, floor],
  );
  const routeSet = useMemo(() => new Set(routeRoomIds ?? []), [routeRoomIds]);

  return (
    <View style={styles.container} testID="floor-map">
      <MapViewport>
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${STUB_VIEW_W} ${STUB_VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <G>
            {rooms.map((room) => {
              const [x, y, w, h] = room.rect;
              const isHighlight = room.id === highlightId;
              const onRoute = routeSet.has(room.id);
              const isAmenity = room.kind !== 'gallery' && room.kind !== 'hall';
              return (
                <G key={room.id}>
                  <Rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    fill={
                      isHighlight || onRoute
                        ? colors.mapRoomActive
                        : isAmenity
                          ? colors.mapAmenity
                          : colors.mapRoom
                    }
                    stroke={isHighlight ? colors.red : colors.mapRoomStroke}
                    strokeWidth={isHighlight ? 1 : 0.4}
                    {...svgPress(() => onRoomPress?.(room))}
                    testID={`room-${room.id}`}
                  />
                  {/* labelPassThrough: the Rect is the single tap target —
                      otherwise the label intercepts taps on the room number. */}
                  <SvgText
                    x={x + w / 2}
                    y={y + h / 2 + 1.2}
                    fontSize={isAmenity ? 2.4 : 3.4}
                    fontFamily={type.label.fontFamily}
                    fill={isHighlight ? colors.red : colors.inkSecondary}
                    textAnchor="middle"
                    {...labelPassThrough}
                  >
                    {stubRoomLabel(room)}
                  </SvgText>
                </G>
              );
            })}
          </G>
        </Svg>
      </MapViewport>

      <View style={styles.chips}>
        {STUB_FLOOR_CHIPS.map((c) => {
          const active = c.floor === floor;
          return (
            <Pressable
              key={c.label}
              disabled={!c.enabled}
              onPress={() => setFloor(c.floor)}
              testID={`floor-chip-${c.label}`}
              style={[
                styles.chip,
                active && styles.chipActive,
                !c.enabled && styles.chipDisabled,
              ]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function stubRoomLabel(room: Room): string {
  switch (room.kind) {
    case 'hall':
      return 'GREAT HALL';
    case 'restroom':
      return 'WC';
    case 'elevator':
      return 'ELEV';
    case 'stairs':
      return 'STAIRS';
    default:
      return room.id;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  mapFill: {
    flex: 1,
  },
  mapArea: {
    flex: 1,
  },
  chips: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    // On short maps (route screen, small phones) a single column of floor
    // chips is taller than the map and the overflow is clipped — lower
    // floors became unreachable. Cap the column at the map height and let
    // it wrap; 'wrap-reverse' puts the first column at the right edge so
    // extra columns grow leftward over the map instead of off-screen.
    bottom: spacing.md,
    flexWrap: 'wrap-reverse',
    gap: spacing.sm,
  },
  // Apple HIG: every tap target ≥44×44 pt.
  chip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  chipDisabled: {
    opacity: 0.35,
  },
  chipText: {
    ...type.label,
    letterSpacing: 0,
  },
  chipTextActive: {
    color: colors.white,
  },
});
