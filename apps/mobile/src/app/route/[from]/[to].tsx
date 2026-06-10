import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  initialRouteProgress,
  onRouteAnchor,
  type RoomAnchor,
  type RouteProgress,
} from '@met/shared/positioning';

import FloorMap from '@/components/FloorMap';
import {
  Anchor,
  anchorForRoom,
  getAnchor,
  getVenue,
  setAnchor,
  useAnchor,
} from '@/components/LocateState';
import RoutePolyline from '@/components/RoutePolyline';
import { Room, RouteStep, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

function center(room: Room): [number, number] {
  const [x, y, w, h] = room.rect;
  return [x + w / 2, y + h / 2];
}

/** Compass direction from one room to the next in stub coords (y grows south). */
function direction(a: Room, b: Room): string {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

/**
 * UI location anchor → positioning-machine RoomAnchor. GPS anchors map to
 * undefined: shared/positioning's AreaAnchor carries no gallery by design, so
 * a GPS fix can neither advance a checkpoint nor trigger a reroute.
 */
function roomAnchorOf(a: Anchor | undefined): RoomAnchor | undefined {
  if (!a || a.source === 'gps' || !a.roomId) return undefined;
  return {
    kind: 'room',
    gallery: a.roomId,
    floor: String(a.floor ?? ''),
    site: 'fifthAve',
    source: a.source === 'gallery' ? 'manual' : a.source,
    confidence: 1,
    timestamp: a.timestamp ?? Date.now(),
  };
}

function shortName(room: Room): string {
  if (room.kind === 'gallery') return `Gallery ${room.id}`;
  if (room.kind === 'stairs' || room.kind === 'elevator' || room.kind === 'restroom') {
    return `the ${room.name.toLowerCase()}`;
  }
  return room.name;
}

/**
 * Richer wayfinding phrasing over the provider's step skeleton, e.g.
 * "Exit Gallery 130 through the east door into Gallery 131".
 * Floor changes ("Take the elevator to Floor 2") pass through untouched.
 */
function displayInstruction(steps: RouteStep[], i: number): string {
  const step = steps[i];
  if (i === 0) return `Start in ${shortName(step.room)}`;
  if (!/^(Walk through|Go to|Arrive)/.test(step.instruction)) return step.instruction;
  const prev = steps[i - 1].room;
  if (prev.floor !== step.room.floor) return step.instruction;
  const dir = direction(prev, step.room);
  if (step.room.kind === 'stairs' || step.room.kind === 'elevator') {
    return `Head ${dir} to the ${step.room.name}`;
  }
  if (i === steps.length - 1) {
    return `Exit ${shortName(prev)} through the ${dir} door — you've reached ${shortName(step.room)}`;
  }
  return `Exit ${shortName(prev)} through the ${dir} door into ${shortName(step.room)}`;
}

export default function RouteScreen() {
  const data = useData();
  const { width } = useWindowDimensions();
  const { from, to, avoid } = useLocalSearchParams<{
    from: string;
    to: string;
    avoid?: string; // deep link: /route/131/822?avoid=stairs
  }>();

  // The route origin is state, not just the URL param: a confident location
  // fix mid-route (stub: the debug button below) re-anchors and re-routes.
  const [origin, setOrigin] = useState(from);
  const [avoidStairs, setAvoidStairs] = useState(avoid === 'stairs');
  // Cold deep links: in the static web export the search params hydrate a
  // render after mount — sync the toggle when ?avoid= (first) appears. User
  // toggles afterwards don't re-run this (the param itself is unchanged).
  useEffect(() => {
    if (avoid !== undefined) setAvoidStairs(avoid === 'stairs');
  }, [avoid]);
  const route = useMemo(
    () => data.route(origin, to, { avoidStairs }),
    [data, origin, to, avoidStairs],
  );
  const [activeStep, setActiveStep] = useState(0);
  const [floor, setFloor] = useState(route?.from.floor ?? 1);
  const [rerouting, setRerouting] = useState(false);
  const listRef = useRef<FlatList<RouteStep>>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const cardWidth = width - spacing.lg * 2;
  const snap = cardWidth + spacing.sm;
  const lastStep = route ? route.steps.length - 1 : 0;

  // ---- positioning state machine wiring -----------------------------------
  // The global anchor (Locate sheet, artifact taps, "I'm here") drives the
  // checkpoint via shared/positioning's onRouteAnchor: a fix ahead on the
  // route auto-advances; an off-route fix recalcs from the new anchor (once
  // per deviation); GPS area anchors can do neither by construction.
  const anchor = useAnchor();
  // Seed the dedupe with whatever anchor existed when the screen opened, so a
  // stale off-route anchor doesn't trigger an instant reroute on mount.
  const progressRef = useRef<RouteProgress>(initialRouteProgress(getAnchor()));
  // Debounce for the known step/scroll regression (docs/mockup/README.md):
  // goToStep animates the card list, and onScroll would round a mid-flight
  // offset back to an earlier step. Ignore scroll-sync while a programmatic
  // scroll is settling.
  const scrollQuietUntil = useRef(0);

  const goToStep = (index: number) => {
    if (!route) return;
    const i = Math.max(0, Math.min(index, lastStep));
    // Keep the machine's notion of the reached checkpoint monotone with the UI.
    progressRef.current = {
      ...progressRef.current,
      stepIndex: Math.max(progressRef.current.stepIndex, i),
    };
    scrollQuietUntil.current = Date.now() + 700;
    setActiveStep(i);
    setFloor(route.steps[i].room.floor);
    listRef.current?.scrollToOffset({ offset: i * snap, animated: true });
  };

  const restart = (firstFloor: number) => {
    progressRef.current = { stepIndex: 0, offRouteGallery: null };
    scrollQuietUntil.current = Date.now() + 700;
    setActiveStep(0);
    setFloor(firstFloor);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  useEffect(() => {
    if (!route) return;
    const roomAnchor = roomAnchorOf(anchor);
    if (!roomAnchor) return; // GPS/unknown: never advances, never reroutes
    const ids = route.steps.map((s) => s.room.id);
    const { progress, signal } = onRouteAnchor(progressRef.current, roomAnchor, ids);
    progressRef.current = progress;
    if (signal.type === 'advance') {
      goToStep(signal.stepIndex);
    } else if (signal.type === 'reroute') {
      const fixRoom = data.getGallery(signal.fromGallery);
      if (!fixRoom || data.route(fixRoom.id, to, { avoidStairs }) === undefined) return;
      setRerouting(true);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setRerouting(false), 1600);
      setOrigin(fixRoom.id);
      restart(fixRoom.floor);
    }
    // goToStep/restart are stable per render; the machine must run exactly
    // once per anchor change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  if (!route) {
    return (
      <View style={styles.center}>
        <Text style={type.body} testID="route-not-found">
          No route found between “{from}” and “{to}” — routes never cross
          between the Fifth Avenue building and The Cloisters.
        </Text>
      </View>
    );
  }

  const arrived = activeStep >= lastStep;
  const routeRoomIds = route.steps.map((s) => s.room.id);
  const currentRoom = route.steps[Math.min(activeStep, lastStep)].room;
  const destObjects = data.objectsInGallery(route.to.id);

  // HOME marker = the visitor's anchor room when it's at this route's venue
  // (it advances with "I'm here" checkpoints); else the active step room.
  const routeSite = route.from.site ?? 'fifthAve';
  const anchorRoom = anchor?.roomId ? data.getGallery(anchor.roomId) : undefined;
  const homeRoom =
    anchorRoom && (anchorRoom.site ?? 'fifthAve') === routeSite ? anchorRoom : currentRoom;

  // Checkpoint button: advance the step, and publish the reached room as the
  // user's anchor when it is a real gallery (keeps the home map/locate chip
  // honest; the machine sees it as an on-route fix at the current step).
  const confirmHere = () => {
    const i = Math.min(activeStep + 1, lastStep);
    goToStep(i);
    const room = route.steps[i].room;
    if (room.kind === 'gallery' && data.getGallery(room.id)) {
      setAnchor(anchorForRoom(room, 'gallery'));
    }
  };

  // Debug stand-in for a confident off-route location fix (room entry, photo,
  // artifact tap): publish an anchor at the nearest gallery NOT on the current
  // route and let the positioning machine drive the reroute.
  const simulateOffRouteFix = () => {
    const onRoute = new Set(routeRoomIds);
    const [cx, cy] = center(currentRoom);
    const fix = data
      .galleries()
      .filter((r) => !onRoute.has(r.id) && data.route(r.id, to, { avoidStairs }) !== undefined)
      .sort((a, b) => {
        const da = Math.hypot(center(a)[0] - cx, center(a)[1] - cy) + (a.floor !== currentRoom.floor ? 1000 : 0);
        const db = Math.hypot(center(b)[0] - cx, center(b)[1] - cy) + (b.floor !== currentRoom.floor ? 1000 : 0);
        return da - db;
      })[0];
    if (!fix) return;
    setAnchor(anchorForRoom(fix, 'gallery'));
  };

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <Text style={styles.summaryTitle} testID="route-summary">
          {route.from.name} → {route.to.name}
        </Text>
        <View style={styles.toggleRow}>
          <Text style={type.meta}>
            {route.steps.length} steps · ~{Math.round(route.distance)} m
          </Text>
          {/* Chip toggle, not RN Switch: the web Switch renders a 40×20
              checkbox that can never meet the 44pt HIG tap target. */}
          <Pressable
            style={[styles.toggle, avoidStairs && styles.toggleActive]}
            onPress={() => {
              setAvoidStairs(!avoidStairs);
              restart(route.from.floor);
            }}
            accessibilityRole="switch"
            // aria-checked (not accessibilityState): RN-web 0.21 does not
            // project accessibilityState.checked onto the DOM; the aria prop
            // maps to accessibilityState on native.
            aria-checked={avoidStairs}
            testID="avoid-stairs"
          >
            <Text style={[type.label, avoidStairs && styles.toggleTextActive]}>
              Avoid stairs{avoidStairs ? ' ✓' : ''}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.mapWrap}>
        <FloorMap
          floor={floor}
          onFloorChange={setFloor}
          highlightId={currentRoom.id}
          routeRoomIds={routeRoomIds}
          // Routes never cross venues (site isolation, J14): the origin room's
          // venue is the route's venue. Fall back to the app venue state.
          site={route.from.site ?? getVenue().venue}
          // HOME = where the visitor is; STAR = the destination. Both inside
          // the map transform + as floor-chip bubbles, so cross-floor routes
          // read at a glance.
          homeRoom={homeRoom}
          targetRoom={route.to}
          // Overlay slot: polyline + dots render inside the pan/zoom transform.
          overlay={<RoutePolyline route={route} floor={floor} activeStep={activeStep} />}
        />
        {rerouting && (
          <View style={styles.toast} testID="rerouting-toast">
            <Text style={styles.toastText}>Rerouting…</Text>
          </View>
        )}
        {/* Debug-only control: overlaid on the map, NOT in the column flow.
            In the footer it cost 52px of vertical budget, which pushed the
            footer below the fold on iPhone-size viewports once the step
            cards stopped (wrongly) absorbing the shortfall. */}
        <Pressable
          style={styles.debugBtn}
          onPress={simulateOffRouteFix}
          testID="simulate-fix"
        >
          <Text style={styles.debugText}>Simulate off-route fix (debug)</Text>
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        style={styles.cards}
        data={route.steps}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={snap}
        decelerationRate="fast"
        contentContainerStyle={styles.cardsContent}
        keyExtractor={(s, i) => `${s.room.id}-${i}`}
        getItemLayout={(_, index) => ({ length: snap, offset: index * snap, index })}
        // onScroll (not onMomentumScrollEnd) so swipes sync the active step on
        // web too, where RNW does not reliably emit momentum events.
        scrollEventThrottle={16}
        onScroll={(e) => {
          // Programmatic goToStep scrolls animate through intermediate
          // offsets; syncing those would regress the just-advanced step.
          if (Date.now() < scrollQuietUntil.current) return;
          const i = Math.max(
            0,
            Math.min(Math.round(e.nativeEvent.contentOffset.x / snap), lastStep),
          );
          if (i !== activeStep) {
            setActiveStep(i);
            setFloor(route.steps[i].room.floor);
          }
        }}
        renderItem={({ item, index }) => {
          const active = index === activeStep;
          return (
            <Pressable
              style={[styles.card, { width: cardWidth }, active && styles.cardActive]}
              onPress={() => goToStep(index)}
              testID={`route-step-${index}`}
            >
              <Text style={[styles.cardLabel, active && styles.cardLabelActive]}>
                Step {index + 1} of {route.steps.length}
              </Text>
              <Text style={styles.cardInstruction}>
                {displayInstruction(route.steps, index)}
              </Text>
              <Text style={type.meta}>
                {item.room.name} · Floor {item.room.floor}
              </Text>
            </Pressable>
          );
        }}
      />

      <View style={styles.footer}>
        {arrived ? (
          <View style={styles.arrival} testID="route-arrived">
            <Text style={styles.arrivalTitle}>You've arrived</Text>
            <Text style={type.meta}>{route.to.name}</Text>
            {destObjects.length > 0 && (
              <Pressable
                style={styles.arrivalBtn}
                onPress={() => router.push(`/results?gallery=${route.to.id}`)}
                testID="arrived-whats-here"
              >
                <Text style={styles.arrivalBtnText}>What's here</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <Pressable
            style={styles.imHereBtn}
            onPress={confirmHere}
            testID="im-here"
          >
            <Text style={styles.imHereText}>I'm here — next step</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  summary: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  summaryTitle: {
    ...type.title,
    fontSize: 18,
    lineHeight: 24,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggle: {
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.white,
  },
  toggleActive: {
    borderColor: colors.red,
    backgroundColor: colors.red,
  },
  toggleTextActive: {
    color: colors.white,
  },
  mapWrap: {
    flex: 1,
    minHeight: 180,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  toast: {
    position: 'absolute',
    top: spacing.md,
    alignSelf: 'center',
    backgroundColor: colors.ink,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  toastText: {
    ...type.label,
    color: colors.white,
  },
  cards: {
    flexGrow: 0,
    // RN-web ScrollView defaults to flexShrink:1 — without this the step
    // strip gets shrunk below its tallest card on small viewports and long
    // instructions clip at the card bottom. The map (flex:1) absorbs the
    // shortfall instead.
    flexShrink: 0,
  },
  cardsContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.xs,
    minHeight: 110,
  },
  cardActive: {
    borderColor: colors.red,
    backgroundColor: colors.white,
  },
  cardLabel: {
    ...type.label,
    color: colors.inkSecondary,
  },
  cardLabelActive: {
    color: colors.red,
  },
  cardInstruction: {
    ...type.body,
    fontFamily: type.title.fontFamily,
    fontSize: 17,
    lineHeight: 23,
  },
  footer: {
    padding: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  imHereBtn: {
    backgroundColor: colors.red,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  imHereText: {
    ...type.label,
    color: colors.white,
  },
  arrival: {
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: colors.mapRoomActive,
    padding: spacing.md,
    gap: spacing.xs,
    alignItems: 'center',
  },
  arrivalTitle: {
    ...type.title,
    fontSize: 20,
    lineHeight: 26,
    color: colors.red,
  },
  arrivalBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.ink,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  arrivalBtnText: {
    ...type.label,
    color: colors.white,
  },
  debugBtn: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  debugText: {
    ...type.meta,
    fontSize: 12,
    color: colors.inkFaint,
    textDecorationLine: 'underline',
  },
});
