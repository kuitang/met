/**
 * DetentSheet — the shared three-detent bottom-sheet machinery, extracted
 * verbatim from HomeRoomSheet (PR #9) so the navigation teardown (NavSheet)
 * snaps, drags and cycles IDENTICALLY to the artifacts teardown. One
 * machinery, two consumers — never two spring tunings.
 *
 * Three fixed detents (no continuous resize — gate decision):
 *  - FULL:   sheet top sits FULL_TOP_GAP below the safe area — reads as a
 *            full-screen sheet with a sliver of map context above.
 *  - HALF:   the default split (`halfVisible` px visible), set on every
 *            `resetKey` change.
 *  - HEADER: just the drag handle + header row docked at the bottom; the map
 *            above stays fully interactive (hit-testing follows the
 *            translateY transform on web and native).
 *
 * Mechanics: the sheet is a fixed-height (FULL-sized) Animated.View anchored
 * to the bottom inside a clipping wrapper; detents translateY it. Only
 * translateY animates (compositor-friendly — no per-frame layout); the body
 * viewport height is set per detent *after* the snap settles, so content is
 * fully scrollable at HALF and FULL.
 *
 * Gesture design: the pan target is the header strip only (handle + header
 * row, ≥44pt) — the simple, documented alternative to simultaneous
 * pan/scroll arbitration; lists in the body scroll independently. On release
 * the gesture is projected ~150ms ahead by its velocity and snaps to the
 * nearest detent (standard bottom-sheet feel: a fling from FULL can pass
 * through HALF). Tapping the handle cycles upward (header → half → full,
 * wrapping back to header) for accessibility / non-drag users.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '@/theme';

export type SheetDetent = 'header' | 'half' | 'full';

/** Visible sheet height at HALF — matches the pre-detent default split. */
export const HALF_VISIBLE = 340;
/** Map sliver left above the sheet at FULL (below the top safe inset). */
const FULL_TOP_GAP = 12;
/** Header-strip estimate until onLayout reports the real height. */
const HEADER_FALLBACK = 96;
/** Velocity projection horizon for the release snap (~iOS pan feel). */
const PROJECT_S = 0.15;
const SPRING = { stiffness: 320, damping: 30, mass: 0.7 };

export interface DetentSheetProps {
  /** Header row rendered inside the pan target, below the drag handle. */
  header: React.ReactNode;
  /**
   * Pinned to the sheet's very top edge, full-bleed (above the horizontal
   * padding) — the NavSheet route-progress border renders here.
   */
  topAccessory?: React.ReactNode;
  /** Body content, given the settled body viewport height and detent. */
  children: (bodyH: number, detent: SheetDetent) => React.ReactNode;
  /** Visible height at the HALF detent (e.g. thin amenity variant). */
  halfVisible?: number;
  /** Snaps back to HALF whenever this changes (new room / new route). */
  resetKey: string;
  onDetentChange?: (d: SheetDetent) => void;
  testID?: string;
  /** Distinct per consumer: a room sheet can stack over the nav sheet. */
  handleTestID?: string;
}

export default function DetentSheet({
  header,
  topAccessory,
  children,
  halfVisible = HALF_VISIBLE,
  resetKey,
  onDetentChange,
  testID,
  handleTestID = 'sheet-handle',
}: DetentSheetProps) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetH = winH - insets.top - FULL_TOP_GAP;

  const [headerH, setHeaderH] = useState(HEADER_FALLBACK);
  const [detent, setDetentState] = useState<SheetDetent>('half');
  const setDetent = useCallback(
    (d: SheetDetent) => {
      setDetentState(d);
      onDetentChange?.(d);
    },
    [onDetentChange],
  );

  // translateY per detent (0 = fully open).
  const fullTy = 0;
  const halfTy = Math.max(0, sheetH - halfVisible);
  const headerTy = Math.max(0, sheetH - headerH);
  const tyFor = useCallback(
    (d: SheetDetent) => (d === 'full' ? 0 : d === 'half' ? halfTy : headerTy),
    [halfTy, headerTy],
  );

  const ty = useSharedValue(halfTy);
  const startTy = useSharedValue(halfTy);

  const snapTo = useCallback(
    (d: SheetDetent) => {
      setDetent(d);
      ty.value = withSpring(tyFor(d), SPRING);
    },
    [setDetent, ty, tyFor],
  );

  // New room/route selection resets to the half split (gate decision).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => snapTo('half'), [resetKey]);

  // Window resize / header measurement: re-pin the current detent (no spring).
  useEffect(() => {
    ty.value = tyFor(detent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetH, headerH]);

  /** JS-side detent bookkeeping after a gesture-driven snap (worklet → JS). */
  // On web the handle travels with the pointer, so a drag released over the
  // handle still synthesizes a click on it (native cancels the responder;
  // web does not) — the timestamp lets cycle() swallow that ghost click.
  const lastPanEnd = useRef(0);
  const settle = useCallback(
    (target: number) => {
      lastPanEnd.current = Date.now();
      setDetent(target === fullTy ? 'full' : target === halfTy ? 'half' : 'header');
    },
    [fullTy, halfTy, setDetent],
  );

  const pan = Gesture.Pan()
    // Let handle taps and the close button win over micro-movements.
    .activeOffsetY([-6, 6])
    .onStart(() => {
      startTy.value = ty.value;
    })
    .onUpdate((e) => {
      ty.value = Math.min(headerTy, Math.max(fullTy, startTy.value + e.translationY));
    })
    .onEnd((e) => {
      const projected = ty.value + e.velocityY * PROJECT_S;
      let target = fullTy;
      for (const d of [halfTy, headerTy]) {
        if (Math.abs(d - projected) < Math.abs(target - projected)) target = d;
      }
      ty.value = withSpring(target, SPRING);
      runOnJS(settle)(target);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ty.value }],
  }));

  const cycle = () => {
    if (Date.now() - lastPanEnd.current < 300) return; // ghost click after a pan
    snapTo(detent === 'header' ? 'half' : detent === 'half' ? 'full' : 'header');
  };

  // Body viewport per settled detent; at HEADER it's below the fold anyway.
  // The 2px top border renders INSIDE the sheet's height — subtract it, or
  // the body's last row overhangs the fold by 2px (render-sanity clip audit).
  const bodyH = Math.max(0, (detent === 'full' ? sheetH : halfVisible) - headerH - 2);

  return (
    // Clipping wrapper: the translated sheet must never grow the page's
    // scrollable overflow on web; box-none keeps the map tappable above it.
    <View style={styles.clip}>
      <Animated.View style={[styles.sheet, { height: sheetH }, animatedStyle]} testID={testID}>
        {topAccessory}
        <GestureDetector gesture={pan}>
          <View onLayout={(e) => setHeaderH(Math.round(e.nativeEvent.layout.height))}>
            <Pressable
              style={styles.handle}
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={detent === 'full' ? 'Collapse sheet' : 'Expand sheet'}
              testID={handleTestID}
            >
              <View style={styles.grabber} />
            </Pressable>
            {header}
          </View>
        </GestureDetector>

        <View style={{ height: bodyH }}>{children(bodyH, detent)}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    pointerEvents: 'box-none',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.white,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    paddingHorizontal: spacing.lg,
  },
  handle: {
    // The whole strip is the tap-to-cycle target (HIG ≥44pt); the pan target
    // is the full header (this strip + the header row) via GestureDetector.
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 36,
    height: 4,
    backgroundColor: colors.hairline,
  },
});
