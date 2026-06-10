/**
 * FloorMap — schematic SVG floor plan over the stub geometry.
 * Pinch-to-zoom + pan (gesture-handler + reanimated), floor switcher chips,
 * tap a room to highlight it and notify the parent.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { G, Rect, Text as SvgText } from 'react-native-svg';

import { Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

// Stub coordinate bounds (see src/data/stub.json).
const VIEW_W = 130;
const VIEW_H = 80;

const FLOOR_CHIPS = [
  { label: 'G', floor: 0, enabled: false }, // no ground-floor stub geometry yet
  { label: '1', floor: 1, enabled: true },
  { label: '2', floor: 2, enabled: true },
];

export interface FloorMapProps {
  /** Room to render highlighted (e.g. current location or selection). */
  highlightId?: string;
  /** Rooms along an active route, tinted on the map. */
  routeRoomIds?: string[];
  onRoomPress?: (room: Room) => void;
  /** Controlled floor; if omitted the component manages its own. */
  floor?: number;
  onFloorChange?: (floor: number) => void;
}

export default function FloorMap({
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

  // Pinch + pan via shared values on a wrapping Animated.View.
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(4, Math.max(0.75, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
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

  return (
    <View style={styles.container} testID="floor-map">
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.mapArea, animatedStyle]}>
          <Svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
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
                      onPress={() => onRoomPress?.(room)}
                      testID={`room-${room.id}`}
                    />
                    {/* pointerEvents="none": the Rect is the single tap target —
                        otherwise the label intercepts taps on the room number. */}
                    <SvgText
                      x={x + w / 2}
                      y={y + h / 2 + 1.2}
                      fontSize={isAmenity ? 2.4 : 3.4}
                      fontFamily={type.label.fontFamily}
                      fill={isHighlight ? colors.red : colors.inkSecondary}
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {roomLabel(room)}
                    </SvgText>
                  </G>
                );
              })}
            </G>
          </Svg>
        </Animated.View>
      </GestureDetector>

      <View style={styles.chips}>
        {FLOOR_CHIPS.map((c) => {
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

function roomLabel(room: Room): string {
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
  mapArea: {
    flex: 1,
  },
  chips: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
