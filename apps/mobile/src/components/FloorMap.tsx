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
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
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
import { HomeGlyph, StarGlyph, homePathD, starPathD } from '@/components/MapMarkers';
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

// One tap of the + / − map buttons multiplies the scale by this.
const ZOOM_STEP = 1.4;

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
export const labelPassThrough: object =
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
  /**
   * The visitor's current anchor room → HOME glyph marker (colors.homeBlue)
   * at the room's center, plus a mini home badge on that floor's chip.
   */
  homeRoom?: Room;
  /**
   * Navigation target room → STAR glyph marker (Met red), plus a mini star
   * badge on that floor's chip — cross-floor routes stay legible at a glance.
   * Home/star shapes (not red/green color pairing) carry the distinction.
   */
  targetRoom?: Room;
  /**
   * SVG overlay rendered INSIDE the map's pan/zoom transform, in viewBox
   * coordinates (real map: projected meters; stub: the 130×80 schematic).
   * This is the overlay slot RoutePolyline plugs into, so route lines and
   * markers pan/zoom with the floor plan in every gesture state.
   */
  overlay?: React.ReactNode;
  /**
   * Fit request (nav mode): animate the viewport to frame these viewBox-space
   * bounds, keeping `insetBottom` px clear at the bottom (the nav sheet).
   * Re-applied whenever `key` changes (route / floor / detent), so user pans
   * in between are respected, not fought.
   */
  fitBounds?: { x: number; y: number; w: number; h: number; insetBottom: number; key: string };
}

/** fitBounds + the active viewBox, resolved by Real/Stub map for MapViewport. */
type FitRequest = NonNullable<FloorMapProps['fitBounds']> & {
  viewBox: { x: number; y: number; w: number; h: number };
};

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
  fit,
}: {
  children: React.ReactNode;
  maxScale?: number;
  /** Reported when a pinch/wheel settles — drives zoom-gated labels. */
  onZoomEnd?: (scale: number) => void;
  /** Frame these viewBox bounds in the area above `insetBottom` (nav mode). */
  fit?: FitRequest;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // ---- fit-to-bounds (nav mode) -------------------------------------------
  // Math: the SVG fills the layout box with preserveAspectRatio "meet", so a
  // viewBox point p lands at L(p) = letterboxOffset + (p - vbOrigin) * k.
  // The pan/zoom transform then maps it to C + s·(L(p) − C) + (tx,ty), where
  // C is the view center (RN transforms pivot on the view center). Solving
  // for "bounds center → center of the visible band, bounds fit inside it"
  // gives s and (tx,ty) directly.
  const [layout, setLayout] = useState<{ w: number; h: number } | undefined>();
  useEffect(() => {
    if (!fit || !layout || layout.w === 0 || layout.h === 0) return;
    const { viewBox: vb, insetBottom } = fit;
    const W = layout.w;
    const H = layout.h;
    const visH = Math.max(80, H - insetBottom);
    const k = Math.min(W / vb.w, H / vb.h);
    // Breathing room around the route (15%, min 6 viewBox units ≈ one room).
    const bw = Math.max(fit.w * 1.3, 12);
    const bh = Math.max(fit.h * 1.3, 12);
    const s = Math.min(maxScale, Math.max(0.75, Math.min(W / (k * bw), visH / (k * bh))));
    const lcx = (W - k * vb.w) / 2 + (fit.x + fit.w / 2 - vb.x) * k;
    const lcy = (H - k * vb.h) / 2 + (fit.y + fit.h / 2 - vb.y) * k;
    const nextTx = -s * (lcx - W / 2);
    const nextTy = visH / 2 - H / 2 - s * (lcy - H / 2);
    const t = { duration: 350 };
    scale.value = withTiming(s, t);
    tx.value = withTiming(nextTx, t);
    ty.value = withTiming(nextTy, t);
    savedScale.value = s;
    savedTx.value = nextTx;
    savedTy.value = nextTy;
    onZoomEnd?.(s);
    // Re-fit only when the request identity or the layout changes — user
    // gestures in between must not be clobbered per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit?.key, layout]);

  // ---- zoom anchoring -------------------------------------------------------
  // The transform is translate(t) then scale(s) about the view center C, so a
  // layout point L lands at C + s·(L − C) + t. The invariant point of a scale
  // change at constant t is L = C → screen C + t: the map point that was at
  // the viewport center BEFORE any pan — zooming after panning visibly pulled
  // the map toward/away from an off-center (even off-screen) point (measured:
  // pan (120,150) → pinch fixed point drifted (108,135) from center). The
  // idiomatic anchor is the CURRENT viewport center: keep C + s(L−C) + t
  // fixed at C for the L now under the center (L − C = −t/s), which gives
  // t' = t · s'/s. Every zoom path below (pinch, wheel, buttons) applies it.
  const MIN_SCALE = 0.75;

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(maxScale, Math.max(MIN_SCALE, savedScale.value * e.scale));
      const r = next / savedScale.value;
      scale.value = next;
      tx.value = savedTx.value * r;
      ty.value = savedTy.value * r;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
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
              Math.max(MIN_SCALE, scale.value * Math.exp(-e.deltaY / 300)),
            );
            const r = next / scale.value; // center anchoring — see above
            scale.value = next;
            savedScale.value = next;
            tx.value *= r;
            ty.value *= r;
            savedTx.value = tx.value;
            savedTy.value = ty.value;
            onZoomEnd?.(next);
          },
        } as object)
      : null;

  // Floating + / − controls: one ZOOM_STEP per tap, spring-animated, same
  // viewport-center anchoring as pinch/wheel (t' = t·s'/s on the targets).
  const zoomBy = (factor: number) => {
    const next = Math.min(maxScale, Math.max(MIN_SCALE, savedScale.value * factor));
    if (next === savedScale.value) return;
    const r = next / savedScale.value;
    const nextTx = savedTx.value * r;
    const nextTy = savedTy.value * r;
    const spring = { stiffness: 320, damping: 30, mass: 0.7 }; // DetentSheet's snap feel
    scale.value = withSpring(next, spring);
    tx.value = withSpring(nextTx, spring);
    ty.value = withSpring(nextTy, spring);
    savedScale.value = next;
    savedTx.value = nextTx;
    savedTy.value = nextTy;
    onZoomEnd?.(next);
  };

  return (
    <View style={styles.mapFill}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.mapArea, animatedStyle]}
          testID="map-viewport"
          onLayout={(e) =>
            setLayout({
              w: Math.round(e.nativeEvent.layout.width),
              h: Math.round(e.nativeEvent.layout.height),
            })
          }
          {...wheelProps}
        >
          {children}
        </Animated.View>
      </GestureDetector>
      {/* pointerEvents in style — the prop form warns on RN-web (see chips). */}
      <View style={styles.zoomCtrls}>
        <Pressable
          style={styles.zoomBtn}
          onPress={() => zoomBy(ZOOM_STEP)}
          accessibilityLabel="Zoom in"
          testID="zoom-in"
        >
          <Text style={styles.zoomGlyph}>+</Text>
        </Pressable>
        <Pressable
          style={styles.zoomBtn}
          onPress={() => zoomBy(1 / ZOOM_STEP)}
          accessibilityLabel="Zoom out"
          testID="zoom-out"
        >
          <Text style={styles.zoomGlyph}>−</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Current-location / target markers (in-SVG, inside the transform)    */
/* ------------------------------------------------------------------ */

/**
 * HOME (current anchor, blue) and STAR (target, Met red) glyphs at room
 * centers, drawn inside the pan/zoom transform so they track every gesture.
 * `u` scales glyph weight with the viewBox (1 in the 130-unit stub space).
 */
function MarkerGlyphs({
  homeRoom,
  targetRoom,
  floor,
  u,
}: {
  homeRoom?: Room;
  targetRoom?: Room;
  floor: number;
  u: number;
}) {
  const center = (r: Room): [number, number] => {
    const [x, y, w, h] = r.rect;
    return [x + w / 2, y + h / 2];
  };
  const halo = { stroke: colors.white, strokeWidth: 0.7 * u, strokeLinejoin: 'round' as const };
  return (
    <>
      {targetRoom && targetRoom.floor === floor && (
        <Path
          d={starPathD(...center(targetRoom), 3.4 * u)}
          fill={colors.red}
          {...halo}
          {...labelPassThrough}
          testID="marker-target"
        />
      )}
      {homeRoom && homeRoom.floor === floor && (
        <Path
          d={homePathD(...center(homeRoom), 3 * u)}
          fill={colors.homeBlue}
          {...halo}
          {...labelPassThrough}
          testID="marker-home"
        />
      )}
    </>
  );
}

/**
 * Mini home/star badges on a floor chip: the chip of the floor holding the
 * current location carries a home bubble, the target's floor a star bubble —
 * cross-floor routes are legible without switching floors.
 */
function ChipBadges({
  label,
  homeLabel,
  targetLabel,
}: {
  label: string;
  homeLabel?: string;
  targetLabel?: string;
}) {
  return (
    <>
      {homeLabel === label && (
        <View style={[styles.chipBadge, styles.chipBadgeHome]} testID={`chip-badge-home-${label}`}>
          <HomeGlyph size={10} />
        </View>
      )}
      {targetLabel === label && (
        <View
          style={[styles.chipBadge, styles.chipBadgeTarget]}
          testID={`chip-badge-target-${label}`}
        >
          <StarGlyph size={10} />
        </View>
      )}
    </>
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
  homeRoom,
  targetRoom,
  overlay,
  fitBounds,
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
        site, // anchors set from a map tap must carry the venue
      });
    },
    [onRoomPress, site],
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
        <MapViewport
          key={site}
          maxScale={8}
          onZoomEnd={setZoom}
          fit={fitBounds ? { ...fitBounds, viewBox: vb } : undefined}
        >
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
              {overlay}
              <MarkerGlyphs
                homeRoom={homeRoom}
                targetRoom={targetRoom}
                floor={floorNumber(floor)}
                u={vb.w / STUB_VIEW_W}
              />
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
              <ChipBadges
                label={label}
                homeLabel={homeRoom && floorLabel(homeRoom.floor)}
                targetLabel={targetRoom && floorLabel(targetRoom.floor)}
              />
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
  homeRoom,
  targetRoom,
  overlay,
  fitBounds,
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
      <MapViewport
        fit={
          fitBounds
            ? { ...fitBounds, viewBox: { x: 0, y: 0, w: STUB_VIEW_W, h: STUB_VIEW_H } }
            : undefined
        }
      >
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
            {overlay}
            <MarkerGlyphs homeRoom={homeRoom} targetRoom={targetRoom} floor={floor} u={1} />
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
              <ChipBadges
                label={c.label}
                homeLabel={homeRoom && floorLabel(homeRoom.floor)}
                targetLabel={targetRoom && floorLabel(targetRoom.floor)}
              />
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
    // Web: 'clip', not 'hidden' — overflow:hidden makes the container a
    // programmatically-scrollable box, and Chrome's scroll-into-view (e.g.
    // focusing the zoom buttons) silently scrolled it by the pan offset,
    // visually un-panning the map (measured scrollLeft=88 after an 88px
    // pan). 'clip' clips identically but can never scroll. Native 'hidden'
    // has no scroll semantics, so it keeps the supported value.
    overflow: Platform.OS === 'web' ? ('clip' as 'hidden') : 'hidden',
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
    // The column spans the map's full height; without box-none the empty
    // strip between chips swallows taps meant for right-edge rooms (seen as
    // untappable room-131 on WebKit). Style form, not prop — see above.
    pointerEvents: 'box-none',
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
  // Floating + / − zoom controls: bottom-right, above the bottom band where
  // the locate chip / sheets live, left of nothing — the floor-chip column
  // anchors to the top of the same right rail, so the two never meet.
  zoomCtrls: {
    position: 'absolute',
    right: spacing.md,
    bottom: 120,
    gap: spacing.sm,
    pointerEvents: 'box-none',
  },
  zoomBtn: {
    width: 44, // HIG tap target
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomGlyph: {
    ...type.title,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
  },
  // Mini home/star bubbles on the floor chips (see ChipBadges).
  chipBadge: {
    position: 'absolute',
    top: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipBadgeHome: {
    left: -4,
  },
  chipBadgeTarget: {
    right: -4,
  },
});
