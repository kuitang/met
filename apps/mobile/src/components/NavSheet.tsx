/**
 * NavSheet — the navigation teardown (variant D: "the map IS the app").
 *
 * During navigation the home screen's top chrome disappears and this sheet
 * owns the bottom band, on the SAME DetentSheet machinery as the artifacts
 * teardown (user-confirmed requirement): drag to FULL / HALF / HEADER-ONLY,
 * same handle, same snap feel, handle-tap cycles.
 *
 * Header = destination identity, persistent at every detent: red ★ + serif
 * title (+ gallery/floor/step meta) + a bordered 44×44 ✕ that EXITS the mode
 * (closing the navigation sheet = ending navigation — one object, one
 * lifecycle). The sheet's top border doubles as a route progress bar (red
 * fill over ink, proportional to steps completed) so progress is glanceable
 * from across a gallery even at HEADER-ONLY. Tapping the title block opens
 * search to retarget.
 *
 * Body = room-grouped step list (ported from the standalone route screen's
 * card carousel — same displayInstruction phrasing, vertical now) with the
 * avoid-stairs chip and the I'M HERE — NEXT STEP checkpoint button at every
 * detent ≥ HALF.
 *
 * Arrival swaps the header for the arrival panel: WHAT'S HERE (hands off to
 * the destination's artifacts teardown) and DONE (exit + re-anchor).
 */
import { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import DetentSheet, { SheetDetent } from '@/components/DetentSheet';
import { floorLabel } from '@/components/MapGeometry';
import { StarGlyph } from '@/components/MapMarkers';
import { parseRoomId, Room, Route, RouteStep } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

/* ---- instruction phrasing (ported verbatim from route/[from]/[to]) ---- */

function center(room: Room): [number, number] {
  const [x, y, w, h] = room.rect;
  return [x + w / 2, y + h / 2];
}

/** Compass direction from one room to the next in map coords (y grows south). */
function direction(a: Room, b: Room): string {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

function shortName(room: Room): string {
  // room.id is site-scoped ("louvre:711") to disambiguate the lookup key —
  // step instructions should read the bare gallery number.
  if (room.kind === 'gallery') return `Gallery ${parseRoomId(room.id).galleryNumber}`;
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
export function displayInstruction(steps: RouteStep[], i: number): string {
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

/* ----------------------------------------------------------------------- */

export interface NavSheetProps {
  route: Route;
  /**
   * Destination identity line. Object-page entry passes the artwork title;
   * room/amenity entries pass the room name.
   */
  destTitle: string;
  activeStep: number;
  avoidStairs: boolean;
  onToggleAvoid: () => void;
  /** Tap a step row → jump the checkpoint there (monotone in the machine). */
  onStep: (i: number) => void;
  /** I'M HERE — NEXT STEP: advance + publish the room anchor. */
  onConfirmHere: () => void;
  /** ✕ — exit nav mode (chrome returns, anchor preserved). */
  onExit: () => void;
  /** Tap the title block → open search to retarget. */
  onRetarget: () => void;
  /** Arrival: open the destination's artifacts teardown (undefined = none). */
  onWhatsHere?: () => void;
  /** Arrival: exit nav and re-anchor at the destination. */
  onDone: () => void;
  onDetentChange?: (d: SheetDetent) => void;
}

export default function NavSheet({
  route,
  destTitle,
  activeStep,
  avoidStairs,
  onToggleAvoid,
  onStep,
  onConfirmHere,
  onExit,
  onRetarget,
  onWhatsHere,
  onDone,
  onDetentChange,
}: NavSheetProps) {
  const insets = useSafeAreaInsets();
  const lastStep = route.steps.length - 1;
  const arrived = activeStep >= lastStep;
  const progress = lastStep > 0 ? Math.min(1, activeStep / lastStep) : 1;

  // Keep the active step row in view as checkpoints advance.
  const listRef = useRef<FlatList<RouteStep>>(null);
  useEffect(() => {
    listRef.current?.scrollToIndex({ index: activeStep, viewPosition: 0.25, animated: true });
  }, [activeStep]);

  const dest = route.to;
  const destMeta = [
    dest.kind === 'gallery' ? `Gallery ${parseRoomId(dest.id).galleryNumber}` : null,
    `Floor ${floorLabel(dest.floor, dest.site)}`,
    `Step ${Math.min(activeStep + 1, route.steps.length)} of ${route.steps.length}`,
    `~${Math.round(route.distance)} m`,
  ]
    .filter(Boolean)
    .join(' · ');

  // The sheet's top border as route progress: red fill over the ink border.
  // pointerEvents lives in style: the prop form is deprecated on RN-web and
  // logs a dev warning (LogBox badge → HIG sweep failure).
  const progressBar = (
    <View style={styles.progressTrack}>
      <View
        style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]}
        testID="nav-progress"
      />
    </View>
  );

  const header = arrived ? (
    <View style={styles.headerRow} testID="route-arrived">
      <View style={styles.headerText}>
        <Text style={styles.arrivedTitle}>You've arrived</Text>
        <Text style={type.meta} numberOfLines={1}>
          {destTitle === dest.name ? dest.name : `${destTitle} · ${dest.name}`}
        </Text>
        <View style={styles.arrivalActions}>
          {onWhatsHere && (
            <Pressable
              style={[styles.arrivalBtn, styles.whatsHereBtn]}
              onPress={onWhatsHere}
              testID="arrived-whats-here"
            >
              <Text style={styles.actionText}>What's here</Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.arrivalBtn, styles.doneBtn]}
            onPress={onDone}
            testID="nav-done"
          >
            <Text style={styles.actionText}>Done</Text>
          </Pressable>
        </View>
      </View>
      <Pressable style={styles.closeBtn} onPress={onExit} hitSlop={8} testID="nav-close">
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  ) : (
    <View style={styles.headerRow}>
      <View style={styles.starBox}>
        <StarGlyph size={20} />
      </View>
      {/* Title block = retarget affordance: opens search, picking a result
          swaps the destination in place. */}
      <Pressable
        style={styles.headerText}
        onPress={onRetarget}
        accessibilityRole="button"
        accessibilityLabel="Change destination"
        testID="route-summary"
      >
        <Text style={styles.title} numberOfLines={2}>
          {destTitle}
        </Text>
        <Text style={type.meta} numberOfLines={1}>
          {destMeta}
        </Text>
      </Pressable>
      <Pressable
        style={styles.closeBtn}
        onPress={onExit}
        hitSlop={8}
        accessibilityLabel="End navigation"
        testID="nav-close"
      >
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );

  return (
    <DetentSheet
      header={header}
      topAccessory={progressBar}
      resetKey={`${route.from.id}->${route.to.id}`}
      onDetentChange={onDetentChange}
      testID="nav-sheet"
      handleTestID="nav-sheet-handle"
    >
      {() => (
        <>
          <View style={styles.actionRow}>
            {/* Chip toggle, not RN Switch: the web Switch renders a 40×20
                checkbox that can never meet the 44pt HIG tap target. */}
            <Pressable
              style={[styles.toggle, avoidStairs && styles.toggleActive]}
              onPress={onToggleAvoid}
              accessibilityRole="switch"
              // aria-checked (not accessibilityState): RN-web 0.21 does not
              // project accessibilityState.checked onto the DOM; the aria
              // prop maps to accessibilityState on native.
              aria-checked={avoidStairs}
              testID="avoid-stairs"
            >
              <Text style={[type.label, avoidStairs && styles.toggleTextActive]}>
                Avoid stairs{avoidStairs ? ' ✓' : ''}
              </Text>
            </Pressable>
            {!arrived && (
              <Pressable style={styles.imHereBtn} onPress={onConfirmHere} testID="im-here">
                <Text style={styles.actionText}>I'm here — next step</Text>
              </Pressable>
            )}
          </View>

          <FlatList
            ref={listRef}
            data={route.steps}
            keyExtractor={(s, i) => `${s.room.id}-${i}`}
            style={styles.list}
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
            // Render every step row up front: stub/real routes are short
            // (≤ ~20 rows) and the e2e suites read all instructions at once.
            initialNumToRender={route.steps.length}
            onScrollToIndexFailed={() => {}}
            renderItem={({ item, index }) => {
              const active = index === activeStep;
              return (
                <Pressable
                  style={[styles.stepRow, active && styles.stepRowActive]}
                  onPress={() => onStep(index)}
                  testID={`route-step-${index}`}
                >
                  <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>
                    Step {index + 1} of {route.steps.length}
                  </Text>
                  <Text style={styles.stepInstruction}>
                    {displayInstruction(route.steps, index)}
                  </Text>
                  <Text style={type.meta}>
                    {item.room.name} · Floor {floorLabel(item.room.floor, item.room.site)}
                  </Text>
                </Pressable>
              );
            }}
          />
        </>
      )}
    </DetentSheet>
  );
}

const styles = StyleSheet.create({
  // Progress border: full-bleed strip hugging the sheet's top edge (the
  // DetentSheet already draws the 2px ink border above it).
  progressTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: colors.ink,
    pointerEvents: 'none',
  },
  progressFill: {
    height: 3,
    backgroundColor: colors.red,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  starBox: {
    width: 24,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  headerText: {
    flex: 1,
    gap: 2,
    minHeight: 44, // HIG tap target (the block is the retarget affordance)
    justifyContent: 'center',
  },
  title: {
    ...type.title,
    fontSize: 20,
    lineHeight: 26,
  },
  arrivedTitle: {
    ...type.title,
    fontSize: 20,
    lineHeight: 26,
    color: colors.red,
  },
  closeBtn: {
    width: 44, // HIG ≥44pt — the exit lives where the thumb is
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  closeText: {
    ...type.label,
    letterSpacing: 0,
  },
  arrivalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  arrivalBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  whatsHereBtn: {
    backgroundColor: colors.red,
  },
  doneBtn: {
    backgroundColor: colors.ink,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
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
  imHereBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
    paddingHorizontal: spacing.md,
  },
  actionText: {
    ...type.label,
    color: colors.white,
  },
  list: {
    marginTop: spacing.sm,
  },
  stepRow: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.sm,
    minHeight: 44, // HIG tap target
  },
  stepRowActive: {
    borderColor: colors.red,
    backgroundColor: colors.white,
  },
  stepLabel: {
    ...type.label,
    color: colors.inkSecondary,
  },
  stepLabelActive: {
    color: colors.red,
  },
  stepInstruction: {
    ...type.body,
    fontFamily: type.title.fontFamily,
    fontSize: 17,
    lineHeight: 23,
  },
});
