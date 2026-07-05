/**
 * LocateState — the user's position anchor AND active venue (Fifth Avenue ⇄
 * The Cloisters), shared between the Home/Map screen, the Locate sheet, and
 * the object screen. Venue is location state, not map chrome (gate decision):
 * the map renders whatever venue this store says, and the coupling rules of
 * shared/positioning.ts (header: "VENUE / ANCHOR COUPLING") apply — switching
 * venue clears any anchor from the other venue, and a room anchor drags the
 * venue with it.
 *
 * Implemented as a module-level store read via useSyncExternalStore rather
 * than a React context: the root layout (_layout.tsx) is foundation-owned in
 * Gate A, so no provider can be mounted there. The fusion *rules* live in
 * shared/positioning.ts; this file is only the UI-facing store.
 */
import { useSyncExternalStore } from 'react';

import type { Site, VenueSource, VenueState } from '@met/shared/positioning';

import { floorLabel } from '@/components/MapGeometry';
import { parseRoomId, Room } from '@/data/provider';

export type AnchorSource = 'gallery' | 'artifact' | 'photo' | 'gps';

export interface Anchor {
  /** Stub Room id when the position maps to a drawn room (drives map highlight). */
  roomId?: string;
  /** Chip text, e.g. "Gallery 822 · Floor 2" or "Near Fifth Ave entrance". */
  label: string;
  floor?: number;
  /** Venue the anchor belongs to; undefined (stub data) is treated as fifthAve. */
  site?: Site;
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

/**
 * Site display names. The Met pair is baked (the stub provider has no meta);
 * `registerVenueNames` overlays names from the artifact's meta.museums so
 * future sites resolve without touching this module. `venueName()` falls back
 * to the raw site id for anything unregistered.
 */
const BUILTIN_VENUE_NAMES: Record<Site, string> = {
  fifthAve: 'Fifth Avenue',
  cloisters: 'The Cloisters',
};
let registeredVenueNames: Record<Site, string> = {};

export function registerVenueNames(names: Record<Site, string>): void {
  registeredVenueNames = { ...registeredVenueNames, ...names };
}

export function venueName(site: Site): string {
  return registeredVenueNames[site] ?? BUILTIN_VENUE_NAMES[site] ?? site;
}

/** @deprecated import venueName() — kept for existing call sites. */
export const VENUE_NAMES: Record<Site, string> = BUILTIN_VENUE_NAMES;

let anchor: Anchor | undefined;
let venue: VenueState = { venue: 'fifthAve', source: 'default', timestamp: 0 };
/** Dismissible toast shown after an automatic venue switch (gps/browse). */
let venueToast: string | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Set the anchor. Coupling rule 1 (shared/positioning.ts): a defined anchor's
 * site always equals the active venue — so an anchor at the other venue drags
 * the venue with it (silently: the anchor label itself is the feedback).
 */
export function setAnchor(next: Anchor | undefined): void {
  anchor = next;
  const site = next?.site;
  if (site && site !== venue.venue) {
    venue = {
      venue: site,
      source: next.source === 'gps' ? 'gps' : 'room',
      timestamp: Date.now(),
    };
  }
  emit();
}

export function getAnchor(): Anchor | undefined {
  return anchor;
}

export function getVenue(): VenueState {
  return venue;
}

/**
 * Switch the active venue. Coupling rule 2: an anchor from the other venue is
 * cleared. Causes 'gps' and 'browse' raise the dismissible toast; 'manual'
 * (locate-sheet segmented row) pins the venue for the session — GPS will not
 * auto-switch away from it (enforced by applyFusedInput, which reads
 * venue.source). 'room' switches silently (the anchor label is the feedback).
 */
export function applyVenue(next: Site, cause: Exclude<VenueSource, 'default'>): void {
  if (venue.venue === next) {
    // Re-affirming: a manual pin sticks; anything else may upgrade to manual.
    if (cause === 'manual' && venue.source !== 'manual') {
      venue = { venue: next, source: 'manual', timestamp: Date.now() };
      emit();
    }
    return;
  }
  if (anchor && (anchor.site ?? 'fifthAve') !== next) anchor = undefined;
  venue = { venue: next, source: cause, timestamp: Date.now() };
  if (cause === 'gps') venueToast = `You're at ${venueName(next)} — switched`;
  else if (cause === 'browse') venueToast = `Showing ${venueName(next)} — switched`;
  emit();
}

export function dismissVenueToast(): void {
  if (venueToast === undefined) return;
  venueToast = undefined;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnchor(): Anchor | undefined {
  return useSyncExternalStore(subscribe, getAnchor, getAnchor);
}

export function useVenue(): VenueState {
  return useSyncExternalStore(subscribe, getVenue, getVenue);
}

const getVenueToast = () => venueToast;
export function useVenueToast(): string | undefined {
  return useSyncExternalStore(subscribe, getVenueToast, getVenueToast);
}

/**
 * Standard anchor for a known room, e.g. "Gallery 822 · Floor 2" — or just
 * "Gallery 241" when the floor is unknown (C3: AIC/SMK ship galleries with no
 * authoritative floor mapping; floorLabel('') signals this).
 */
export function anchorForRoom(room: Room, source: AnchorSource): Anchor {
  // room.id is site-scoped ("louvre:711") to disambiguate the lookup key —
  // the visible chip text should read the bare gallery number.
  const name =
    room.kind === 'gallery' ? `Gallery ${parseRoomId(room.id).galleryNumber}` : room.name;
  const floorTxt = floorLabel(room.floor, room.site);
  return {
    roomId: room.id,
    label: floorTxt ? `${name} · Floor ${floorTxt}` : name,
    floor: room.floor,
    site: room.site,
    source,
    timestamp: Date.now(),
  };
}
