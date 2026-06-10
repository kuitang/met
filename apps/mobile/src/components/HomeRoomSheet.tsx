/**
 * HomeRoomSheet — bottom sheet shown when a room is tapped on the Home map.
 * Gallery title + the objects in that room; tap an object for its detail
 * page. Two equal-weight actions (user mandate): DIRECTIONS routes there
 * from the current anchor; I'M HERE resets the anchor to this room.
 *
 * Three fixed detents (no continuous resize — gate decision):
 *  - FULL:   sheet top sits FULL_TOP_GAP below the safe area — reads as a
 *            full-screen list with a sliver of map context above.
 *  - HALF:   the default split (the pre-detent 340px sheet height), set on
 *            every new room selection.
 *  - HEADER: just the drag handle + title row docked at the bottom; the map
 *            above stays fully interactive (hit-testing follows the
 *            translateY transform on web and native).
 *
 * Mechanics: the sheet is a fixed-height (FULL-sized) Animated.View anchored
 * to the bottom inside a clipping wrapper; detents translateY it. Only
 * translateY animates (compositor-friendly — no per-frame layout); the list
 * viewport height is set per detent *after* the snap settles, so content is
 * fully scrollable at HALF and FULL.
 *
 * Gesture design: the pan target is the header strip only (handle + title
 * row, ≥44pt) — the simple, documented alternative to simultaneous
 * pan/scroll arbitration; the FlatList below scrolls independently. On
 * release the gesture is projected ~150ms ahead by its velocity and snaps to
 * the nearest detent (standard bottom-sheet feel: a fling from FULL can pass
 * through HALF). Tapping the handle cycles upward (header → half → full,
 * wrapping back to header) for accessibility / non-drag users.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ObjectThumb } from '@/components/ObjectImage';
import { MetObject, Room } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export type SheetDetent = 'header' | 'half' | 'full';

/** Visible sheet height at HALF — matches the pre-detent default split. */
const HALF_VISIBLE = 340;
/** Map sliver left above the sheet at FULL (below the top safe inset). */
const FULL_TOP_GAP = 12;
/** Header-strip estimate until onLayout reports the real height. */
const HEADER_FALLBACK = 96;
/** Velocity projection horizon for the release snap (~iOS pan feel). */
const PROJECT_S = 0.15;
const SPRING = { stiffness: 320, damping: 30, mass: 0.7 };

export interface HomeRoomSheetProps {
  room: Room;
  /** Display list — capped by the provider (500) in dense galleries. */
  objects: MetObject[];
  /** TRUE object count of the room; may exceed objects.length. */
  totalCount: number;
  /** Route origin (current anchor room, or the Great Hall fallback). */
  originId: string;
  /** "I'm here" — reset the visitor's anchor to this room. */
  onImHere: () => void;
  onClose: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export default function HomeRoomSheet({
  room,
  objects,
  totalCount,
  originId,
  onImHere,
  onClose,
}: HomeRoomSheetProps) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheetH = winH - insets.top - FULL_TOP_GAP;

  const [headerH, setHeaderH] = useState(HEADER_FALLBACK);
  const [detent, setDetent] = useState<SheetDetent>('half');

  // translateY per detent (0 = fully open).
  const fullTy = 0;
  const halfTy = Math.max(0, sheetH - HALF_VISIBLE);
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
    [ty, tyFor],
  );

  // New room selection resets to the half split (gate decision).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => snapTo('half'), [room.id]);

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
    [fullTy, halfTy],
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

  // List viewport per settled detent; at HEADER it's below the fold anyway.
  const listH = (detent === 'full' ? sheetH : HALF_VISIBLE) - headerH;

  return (
    // Clipping wrapper: the translated sheet must never grow the page's
    // scrollable overflow on web; box-none keeps the map tappable above it.
    <View style={styles.clip}>
      <Animated.View style={[styles.sheet, { height: sheetH }, animatedStyle]} testID="room-sheet">
        <GestureDetector gesture={pan}>
          <View onLayout={(e) => setHeaderH(Math.round(e.nativeEvent.layout.height))}>
            <Pressable
              style={styles.handle}
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={detent === 'full' ? 'Collapse sheet' : 'Expand sheet'}
              testID="sheet-handle"
            >
              <View style={styles.grabber} />
            </Pressable>
            <View style={styles.headerRow}>
              <View style={styles.headerText}>
                <Text style={styles.title} numberOfLines={2}>
                  {room.name}
                </Text>
                <Text style={type.meta}>
                  Floor {room.floor}
                  {/* Honest count: the list is capped, the total is not. */}
                  {totalCount > 0
                    ? objects.length < totalCount
                      ? ` · Showing ${fmt(objects.length)} of ${fmt(totalCount)} objects`
                      : ` · ${fmt(totalCount)} ${totalCount === 1 ? 'object' : 'objects'}`
                    : ''}
                </Text>
              </View>
              <Pressable
                style={styles.closeBtn}
                onPress={onClose}
                hitSlop={8}
                testID="room-sheet-close"
              >
                <Text style={styles.closeText}>✕</Text>
              </Pressable>
            </View>
          </View>
        </GestureDetector>

        <View style={{ height: Math.max(0, listH) }}>
          <View style={styles.actionRow}>
            {originId !== room.id && (
              <Pressable
                style={[styles.actionBtn, styles.directionsBtn]}
                onPress={() => router.push(`/route/${originId}/${room.id}`)}
                testID="room-directions"
              >
                <Text style={styles.actionText}>Directions</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.actionBtn, styles.imHereBtn]}
              onPress={onImHere}
              testID="room-im-here"
            >
              <Text style={styles.actionText}>I'm here</Text>
            </Pressable>
          </View>

          {objects.length > 0 ? (
            <FlatList
              data={objects}
              keyExtractor={(o) => String(o.objectID)}
              style={styles.list}
              contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => router.push(`/object/${item.objectID}`)}
                  testID={`sheet-object-${item.objectID}`}
                >
                  {item.img ? (
                    // Tigris CDN first, proxy fallback — see data/imageCdn.ts.
                    <ObjectThumb object={item} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.thumbEmpty]} />
                  )}
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={type.meta} numberOfLines={1}>
                      {item.artist || item.dept}
                      {item.date ? ` · ${item.date}` : ''}
                    </Text>
                  </View>
                </Pressable>
              )}
            />
          ) : (
            <Text style={styles.empty}>No objects recorded in this room yet.</Text>
          )}
        </View>
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
    // is the full header (this strip + the title row) via GestureDetector.
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 36,
    height: 4,
    backgroundColor: colors.hairline,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...type.title,
    fontSize: 20,
    lineHeight: 26,
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  closeText: {
    ...type.label,
    letterSpacing: 0,
  },
  // Two equal-weight actions: route there vs. relocate to here (PR #8).
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  directionsBtn: {
    backgroundColor: colors.red,
  },
  imHereBtn: {
    backgroundColor: colors.homeBlue,
  },
  actionText: {
    ...type.label,
    color: colors.white,
  },
  list: {
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  thumb: {
    width: 44,
    height: 44,
    backgroundColor: colors.surface,
  },
  thumbEmpty: {
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  empty: {
    ...type.meta,
    paddingVertical: spacing.md,
  },
});
