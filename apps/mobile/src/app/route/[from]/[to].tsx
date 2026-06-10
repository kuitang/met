import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import FloorMap from '@/components/FloorMap';
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
  const { from, to } = useLocalSearchParams<{ from: string; to: string }>();

  // The route origin is state, not just the URL param: a confident location
  // fix mid-route (stub: the debug button below) re-anchors and re-routes.
  const [origin, setOrigin] = useState(from);
  const [avoidStairs, setAvoidStairs] = useState(false);
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

  if (!route) {
    return (
      <View style={styles.center}>
        <Text style={type.body}>
          No route found between “{from}” and “{to}” in stub data.
        </Text>
      </View>
    );
  }

  const lastStep = route.steps.length - 1;
  const arrived = activeStep >= lastStep;
  const routeRoomIds = route.steps.map((s) => s.room.id);
  const currentRoom = route.steps[Math.min(activeStep, lastStep)].room;
  const destObjects = data.objectsInGallery(route.to.id);

  const goToStep = (index: number) => {
    const i = Math.max(0, Math.min(index, lastStep));
    setActiveStep(i);
    setFloor(route.steps[i].room.floor);
    listRef.current?.scrollToOffset({ offset: i * snap, animated: true });
  };

  const restart = (firstFloor: number) => {
    setActiveStep(0);
    setFloor(firstFloor);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  // Stub stand-in for a confident off-route location fix (room entry, photo,
  // artifact tap): re-anchor at the nearest gallery NOT on the current route.
  const simulateOffRouteFix = () => {
    const onRoute = new Set(routeRoomIds);
    const [cx, cy] = center(currentRoom);
    const fix = data
      .galleries()
      .filter((r) => !onRoute.has(r.id))
      .sort((a, b) => {
        const da = Math.hypot(center(a)[0] - cx, center(a)[1] - cy) + (a.floor !== currentRoom.floor ? 1000 : 0);
        const db = Math.hypot(center(b)[0] - cx, center(b)[1] - cy) + (b.floor !== currentRoom.floor ? 1000 : 0);
        return da - db;
      })[0];
    if (!fix) return;
    setRerouting(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setRerouting(false), 1600);
    setOrigin(fix.id);
    restart(fix.floor);
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
          <View style={styles.toggle}>
            <Text style={type.label}>Avoid stairs</Text>
            <Switch
              value={avoidStairs}
              onValueChange={(v) => {
                setAvoidStairs(v);
                restart(route.from.floor);
              }}
              trackColor={{ true: colors.red }}
              // react-native-web-only prop: keep the "on" thumb white, not teal
              {...(Platform.OS === 'web' ? { activeThumbColor: colors.white } : null)}
              testID="avoid-stairs"
            />
          </View>
        </View>
      </View>

      <View style={styles.mapWrap}>
        <FloorMap
          floor={floor}
          onFloorChange={setFloor}
          highlightId={currentRoom.id}
          routeRoomIds={routeRoomIds}
        />
        <RoutePolyline route={route} floor={floor} activeStep={activeStep} />
        {rerouting && (
          <View style={styles.toast} testID="rerouting-toast">
            <Text style={styles.toastText}>Rerouting…</Text>
          </View>
        )}
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
            onPress={() => goToStep(activeStep + 1)}
            testID="im-here"
          >
            <Text style={styles.imHereText}>I'm here — next step</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.debugBtn}
          onPress={simulateOffRouteFix}
          testID="simulate-fix"
        >
          <Text style={styles.debugText}>Simulate off-route fix (debug)</Text>
        </Pressable>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
    alignSelf: 'center',
    paddingVertical: spacing.xs,
  },
  debugText: {
    ...type.meta,
    fontSize: 12,
    color: colors.inkFaint,
    textDecorationLine: 'underline',
  },
});
