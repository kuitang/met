/**
 * LocateState — the user's position anchor, shared between the Home/Map
 * screen and the Locate sheet.
 *
 * Implemented as a module-level store read via useSyncExternalStore rather
 * than a React context: the root layout (_layout.tsx) is foundation-owned in
 * Gate A, so no provider can be mounted there. Semantics are identical and
 * Phase 2's positioning state machine (shared/positioning.ts) can replace
 * this file behind the same two exports.
 */
import { useSyncExternalStore } from 'react';

import { Room } from '@/data/provider';

export type AnchorSource = 'gallery' | 'artifact' | 'photo' | 'gps';

export interface Anchor {
  /** Stub Room id when the position maps to a drawn room (drives map highlight). */
  roomId?: string;
  /** Chip text, e.g. "Gallery 822 · Floor 2" or "Near Fifth Ave entrance". */
  label: string;
  floor?: number;
  source: AnchorSource;
  /**
   * When the fix was taken (epoch ms). shared/positioning's fusion rules use
   * this for freshness: a room claim decays to wing-level after
   * ROOM_ANCHOR_DECAY_MS and may then be superseded by a fresh GPS fix.
   */
  timestamp?: number;
  /**
   * GPS anchors only: floor retained from a superseded room anchor, surfaced
   * as "(assumed)" in the label (GPS itself carries no floor). Floor label
   * vocabulary of shared/positioning ("G", "1", "1M", ...).
   */
  assumedFloor?: string;
}

let anchor: Anchor | undefined;
const listeners = new Set<() => void>();

export function setAnchor(next: Anchor | undefined): void {
  anchor = next;
  for (const l of listeners) l();
}

export function getAnchor(): Anchor | undefined {
  return anchor;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnchor(): Anchor | undefined {
  return useSyncExternalStore(subscribe, getAnchor, getAnchor);
}

/** Standard anchor for a known stub room, e.g. "Gallery 822 · Floor 2". */
export function anchorForRoom(room: Room, source: AnchorSource): Anchor {
  const name = room.kind === 'gallery' ? `Gallery ${room.id}` : room.name;
  return {
    roomId: room.id,
    label: `${name} · Floor ${room.floor}`,
    floor: room.floor,
    source,
    timestamp: Date.now(),
  };
}
