/**
 * Home — "the map IS the app" (nav-mode variant D, user-approved).
 *
 * The screen has two modes, both URL-addressable:
 *  - BROWSE (default): wordmark + search bar over the full-screen map, locate
 *    chip at the bottom, room taps open the artifacts/amenity teardown.
 *  - NAVIGATION (`?nav=<fromId>:<toId>[&avoid=stairs][&obj=<objectID>]`): the
 *    top chrome disappears entirely (max map), and the NavSheet teardown —
 *    the SAME DetentSheet machinery as the room sheet — owns the bottom band.
 *    ✕ in the sheet header exits the mode in place (chrome returns, anchor
 *    preserved); the browser/native back button pops the pushed nav entry,
 *    so back = exit nav too (modal semantics). /route/[from]/[to] deep links
 *    redirect here, so existing links keep working.
 *
 * All navigation logic from the retired standalone route screen lives here
 * now, ported intact: the shared/positioning route machine (checkpoint
 * auto-advance + exactly-once reroute per deviation, "Rerouting…" toast),
 * I'M-HERE checkpoints publishing the room anchor, the avoid-stairs toggle,
 * and the off-route debug fix. Cross-floor steps auto-switch the visible
 * floor; the polyline draws the current floor solid and other floors dimmed;
 * the map re-fits to the visible route segment below the FULL detent.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  initialRouteProgress,
  onRouteAnchor,
  type RoomAnchor,
  type RouteProgress,
} from '@met/shared/positioning';

import { HALF_VISIBLE, SheetDetent } from '@/components/DetentSheet';
import FloorMap from '@/components/FloorMap';
import HomeRoomSheet, { AMENITY_HALF_VISIBLE } from '@/components/HomeRoomSheet';
import {
  Anchor,
  VENUE_NAMES,
  anchorForRoom,
  applyVenue,
  dismissVenueToast,
  getAnchor,
  setAnchor,
  useAnchor,
  useVenue,
  useVenueToast,
} from '@/components/LocateState';
import NavSheet from '@/components/NavSheet';
import RoomListBrowse from '@/components/RoomListBrowse';
import RoutePolyline, { routeBoundsOnFloor } from '@/components/RoutePolyline';
import { museumForSite, Room, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

/** Map height kept clear above the nav sheet at the HEADER-ONLY detent. */
const NAV_HEADER_INSET = 110;
/**
 * RoomListBrowse's top clearance (C3): the SAME wordmark + search bar overlay
 * that floats over FloorMap floats over this full-bleed list too, but a
 * plain scrollable list — unlike a pannable map — needs real padding so its
 * first rows aren't hidden underneath. Measured against topOverlay's actual
 * stack (paddingTop + wordmark line + gap + search bar), rounded up.
 */
const ROOM_LIST_TOP_INSET = 140;
/** Clears the locate chip + unofficial-note bottom overlay (same reasoning as ROOM_LIST_TOP_INSET, opposite edge). */
const ROOM_LIST_BOTTOM_INSET = 120;

function center(room: Room): [number, number] {
  const [x, y, w, h] = room.rect;
  return [x + w / 2, y + h / 2];
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

export default function HomeScreen() {
  const data = useData();
  const anchor = useAnchor();
  const venue = useVenue();
  const venueToast = useVenueToast();
  // Museum registry (C3): only read for capability gating (hasGeometry /
  // hasGraph) — [BUILTIN_MET_ENTRY] for the stub and pre-v2 artifacts, so
  // every check below is a no-op there (Met capabilities are all true).
  const museums = data.museums();
  // Deep-link support: `/?room=131` anchors directly (also kept for e2e).
  const {
    room: roomParam,
    focus: focusParam,
    ts: tsParam,
    nav: navParam,
    avoid: avoidParam,
    obj: objParam,
  } = useLocalSearchParams<{
    room?: string;
    focus?: string;
    ts?: string;
    nav?: string;
    avoid?: string;
    obj?: string;
  }>();
  useEffect(() => {
    if (!roomParam) return;
    const room = data.getGallery(roomParam);
    if (room) setAnchor(anchorForRoom(room, 'gallery'));
  }, [roomParam, data]);

  const [selected, setSelected] = useState<Room | undefined>();
  const [floor, setFloor] = useState(1);

  // ---- navigation mode (URL is the source of truth) ----------------------
  const [navFrom, navTo] = (navParam ?? '').split(':');
  const navActive = Boolean(navFrom && navTo);
  const avoidStairs = avoidParam === 'stairs';
  const navRoute = useMemo(
    () => (navActive ? data.route(navFrom, navTo, { avoidStairs }) : undefined),
    [data, navActive, navFrom, navTo, avoidStairs],
  );
  // Object-page entry carries the artwork as the destination identity.
  const navObject = objParam ? data.getObject(Number(objParam)) : undefined;
  const destTitle = navObject?.title ?? navRoute?.to.name ?? '';

  const [activeStep, setActiveStep] = useState(0);
  const [navDetent, setNavDetent] = useState<SheetDetent>('half');
  const [roomDetent, setRoomDetent] = useState<SheetDetent>('half');
  const [rerouting, setRerouting] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // The route machine's progress, seeded with whatever anchor existed when
  // the route appeared so a stale off-route anchor can't instantly reroute.
  const progressRef = useRef<RouteProgress>(initialRouteProgress(getAnchor()));

  const lastStep = navRoute ? navRoute.steps.length - 1 : 0;
  const step = Math.min(activeStep, lastStep);
  const arrived = navActive && navRoute !== undefined && step >= lastStep;

  // New route identity (entry, retarget, reroute, avoid toggle): reset the
  // checkpoint, re-seed the machine, snap the map to the route's first floor.
  const routeKey = navActive ? `${navFrom}->${navTo}:${avoidStairs}` : '';
  useEffect(() => {
    if (!routeKey) return;
    progressRef.current = initialRouteProgress(getAnchor());
    setActiveStep(0);
    const fromRoom = data.getGallery(navFrom);
    if (fromRoom) setFloor(fromRoom.floor);
    // data/navFrom are captured by routeKey; run exactly once per new route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const goToStep = (index: number) => {
    if (!navRoute) return;
    const i = Math.max(0, Math.min(index, lastStep));
    // Keep the machine's notion of the reached checkpoint monotone with the UI.
    progressRef.current = {
      ...progressRef.current,
      stepIndex: Math.max(progressRef.current.stepIndex, i),
    };
    setActiveStep(i);
    // Cross-floor steps (elevator/stairs) auto-switch the visible floor.
    setFloor(navRoute.steps[i].room.floor);
  };

  // ---- positioning state machine wiring -----------------------------------
  // The global anchor (Locate sheet, room-sheet "I'm here", checkpoints)
  // drives the route via shared/positioning's onRouteAnchor: a fix ahead on
  // the route auto-advances; an off-route fix recalcs from the new anchor
  // (once per deviation); GPS area anchors can do neither by construction.
  useEffect(() => {
    if (!navRoute) return;
    const roomAnchor = roomAnchorOf(anchor);
    if (!roomAnchor) return; // GPS/unknown: never advances, never reroutes
    const ids = navRoute.steps.map((s) => s.room.id);
    const { progress, signal } = onRouteAnchor(progressRef.current, roomAnchor, ids);
    progressRef.current = progress;
    if (signal.type === 'advance') {
      goToStep(signal.stepIndex);
    } else if (signal.type === 'reroute') {
      const fixRoom = data.getGallery(signal.fromGallery);
      if (!fixRoom || data.route(fixRoom.id, navTo, { avoidStairs }) === undefined) return;
      setRerouting(true);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setRerouting(false), 1600);
      // New origin in the URL: the routeKey effect resets step + floor.
      router.setParams({ nav: `${fixRoom.id}:${navTo}` });
    }
    // The machine must run exactly once per anchor change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // One tap grammar for search room rows: `/?focus=131` (gallery or amenity
  // id) lands here with the floor switched, the room highlighted, and its
  // sheet open — the anchor is NOT touched (DIRECTIONS / I'M HERE live in the
  // sheet). `ts` busts expo-router param equality so re-tapping the same room
  // re-opens the sheet; cross-venue rooms drag the venue (with the toast).
  // Nav-mode retargets arrive via the `nav` param instead (see RoomRow).
  useEffect(() => {
    if (!focusParam || navActive) return;
    const room = data.getGallery(focusParam);
    if (!room) return;
    applyVenue(room.site ?? 'fifthAve', 'browse');
    setSelected(room);
    setFloor(room.floor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, tsParam, data]);

  // Follow the anchor's floor when it changes (e.g. set via the Locate
  // sheet). In nav mode the route machine owns the floor (goToStep).
  useEffect(() => {
    if (!navActive && anchor?.floor !== undefined) setFloor(anchor.floor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // ---- nav-mode actions ----------------------------------------------------
  /**
   * Exit nav IN PLACE (✕, DONE, arrival handoff): clear the nav params on the
   * current history entry — chrome returns, anchor untouched. The native/
   * browser back button is the other exit: entry points PUSH the nav state.
   */
  const exitNav = () => {
    setRerouting(false);
    router.setParams({ nav: '', avoid: '', obj: '' });
  };

  // Checkpoint button: advance the step, and publish the reached room as the
  // user's anchor when it is a real gallery (keeps the home map/locate chip
  // honest; the machine sees it as an on-route fix at the current step).
  const confirmHere = () => {
    if (!navRoute) return;
    const i = Math.min(step + 1, lastStep);
    goToStep(i);
    const room = navRoute.steps[i].room;
    if (room.kind === 'gallery' && data.getGallery(room.id)) {
      setAnchor(anchorForRoom(room, 'gallery'));
    }
  };

  // Debug stand-in for a confident off-route location fix (room entry, photo,
  // artifact tap): publish an anchor at the nearest gallery NOT on the current
  // route and let the positioning machine drive the reroute.
  const simulateOffRouteFix = () => {
    if (!navRoute) return;
    const onRoute = new Set(navRoute.steps.map((s) => s.room.id));
    const currentRoom = navRoute.steps[step].room;
    const [cx, cy] = center(currentRoom);
    const fix = data
      .galleries()
      .filter((r) => !onRoute.has(r.id) && data.route(r.id, navTo, { avoidStairs }) !== undefined)
      .sort((a, b) => {
        const da =
          Math.hypot(center(a)[0] - cx, center(a)[1] - cy) +
          (a.floor !== currentRoom.floor ? 1000 : 0);
        const db =
          Math.hypot(center(b)[0] - cx, center(b)[1] - cy) +
          (b.floor !== currentRoom.floor ? 1000 : 0);
        return da - db;
      })[0];
    if (!fix) return;
    setAnchor(anchorForRoom(fix, 'gallery'));
  };

  // ---- derived map props ---------------------------------------------------
  const highlightId = selected?.id ?? (navRoute ? navRoute.steps[step].room.id : anchor?.roomId);

  // Routes never cross venues (site isolation, J14): the origin room's venue
  // is the route's venue; browse mode follows the venue state.
  const mapSite = navRoute ? (navRoute.from.site ?? venue.venue) : venue.venue;

  // Museum owning the visible site (C3). Nav mode only ever exists for a
  // hasGraph museum (the Met today) — hasGeometry defaults true so pre-v2
  // artifacts and the stub are unaffected.
  const mapMuseum = museumForSite(museums, mapSite);
  const hasGeometry = mapMuseum?.capabilities.hasGeometry ?? true;
  // RoomListBrowse's input: only rendered when !hasGeometry, but cheap
  // either way and keeps the hook order stable.
  const browseRooms = useMemo(
    () => data.galleries().filter((r) => (r.site ?? 'fifthAve') === mapSite),
    [data, mapSite],
  );
  const browseFloorOrder = mapMuseum?.sites.find((s) => s.siteId === mapSite)?.floorOrder;
  // The room sheet's own museum (may differ from mapMuseum in nav mode, if a
  // future museum ever mixed hasGraph sites — today always the same site).
  const selectedMuseum = selected ? museumForSite(museums, selected.site) : undefined;

  // HOME glyph marker: the visitor's anchor room when it's at the visible
  // venue (it advances with "I'm here" checkpoints); in nav mode fall back to
  // the active step room so the current position always reads.
  const anchorRoom = anchor?.roomId ? data.getGallery(anchor.roomId) : undefined;
  const homeRoom =
    anchorRoom && (anchorRoom.site ?? 'fifthAve') === mapSite
      ? anchorRoom
      : navRoute
        ? navRoute.steps[step].room
        : undefined;

  // Re-fit the viewport to the visible route segment whenever the route, the
  // floor, or the sheet detent changes — except at FULL, where the sheet
  // covers the map anyway (the noted improvement over the mockup pass).
  const navBounds = navRoute && navDetent !== 'full' ? routeBoundsOnFloor(navRoute, floor) : undefined;
  const fitBounds = navBounds
    ? {
        ...navBounds,
        insetBottom: navDetent === 'half' ? HALF_VISIBLE : NAV_HEADER_INSET,
        key: `${routeKey}:${floor}:${navDetent}`,
      }
    : undefined;

  // Keep the map's +/− zoom rail above whichever sheet owns the bottom band
  // (nav sheet, room sheet, or room-over-nav). At HALF the rail rides the
  // sheet's visible height; at HEADER it clears the docked header; at FULL
  // the sheet covers the map anyway, so the HEADER inset is moot but keeps
  // the rail steady on the way up/down. No sheet → FloorMap's default rail.
  const sheetInset = (d: SheetDetent, half: number) =>
    d === 'half' ? half + spacing.md : NAV_HEADER_INSET + spacing.md;
  const navInset = navActive && navRoute ? sheetInset(navDetent, HALF_VISIBLE) : 0;
  const roomInset = selected
    ? sheetInset(
        roomDetent,
        selected.kind !== 'gallery' && selected.kind !== 'hall'
          ? AMENITY_HALF_VISIBLE
          : HALF_VISIBLE,
      )
    : 0;
  const controlsBottomInset =
    navInset || roomInset ? Math.max(navInset, roomInset) : undefined;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.mapFill}>
        {hasGeometry ? (
          <FloorMap
            floor={floor}
            onFloorChange={setFloor}
            highlightId={highlightId}
            onRoomPress={setSelected}
            site={mapSite}
            homeRoom={homeRoom}
            targetRoom={navRoute?.to}
            routeRoomIds={navRoute?.steps.map((s) => s.room.id)}
            overlay={
              navRoute ? <RoutePolyline route={navRoute} floor={floor} activeStep={step} /> : undefined
            }
            fitBounds={fitBounds}
            controlsBottomInset={controlsBottomInset}
          />
        ) : (
          // No gallery geometry (C3: every non-Met museum today) — no map to
          // draw, honestly: a floor-grouped/ungrouped room list, NOT the stub
          // schematic (that would draw fake rooms for a real museum).
          <RoomListBrowse
            rooms={browseRooms}
            floorOrder={browseFloorOrder}
            topInset={ROOM_LIST_TOP_INSET}
            bottomInset={ROOM_LIST_BOTTOM_INSET}
          />
        )}
      </View>

      {/* MODAL nav semantics (variant D): entering navigation hides the top
          chrome entirely — wordmark + search bar gone, floor chips stay (they
          are map controls). ✕ in the NavSheet header brings it back. */}
      {!navActive && (
        // pointerEvents lives in style: the prop form is deprecated on RN-web
        // and logs a dev warning (LogBox badge → HIG sweep failure).
        <View style={styles.topOverlay}>
          <View style={styles.header}>
            <Text style={styles.wordmark}>
              Muse<Text style={styles.wordmarkAccent}>Walk</Text>
            </Text>
          </View>
          <Pressable
            style={styles.searchBar}
            onPress={() => router.push('/search')}
            testID="home-search-bar"
          >
            <Text style={styles.searchPlaceholder}>Search art, artists, galleries…</Text>
          </Pressable>
        </View>
      )}

      {/* Auto-reroute feedback from the positioning machine, over the map. */}
      {rerouting && (
        <View style={styles.reroutingToast} testID="rerouting-toast">
          <Text style={styles.reroutingText}>Rerouting…</Text>
        </View>
      )}

      {/* Bottom chrome hides while a sheet owns the bottom band (room sheet
          across all detents, or navigation mode); the chip returns — with any
          anchor change — when the sheet closes / nav exits. */}
      {!selected && !navActive && (
        <View style={styles.bottomOverlay}>
          {/* Dismissible toast raised by automatic venue switches (GPS fix at
            the other venue, or tapping a cross-venue search result). */}
          {venueToast ? (
            <Pressable style={styles.venueToast} onPress={dismissVenueToast} testID="venue-toast">
              <Text style={styles.venueToastText}>{venueToast}</Text>
              <Text style={styles.venueToastClose}>✕</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.locateChip, !anchor && styles.locateChipUnknown]}
            onPress={() => router.push('/locate')}
            testID="locate-chip"
          >
            {/* Single line + tail ellipsis: long real gallery titles (e.g.
                "Gallery Exhibition Galleries 964 & 965 · Floor G") must
                truncate, never wrap, never reach the screen edge. */}
            <Text style={styles.locateChipText} numberOfLines={1}>
              {anchor ? anchor.label : 'Location unknown — tap to set'}
            </Text>
            <Text style={styles.locateChipVenue} numberOfLines={1} testID="locate-chip-venue">
              {VENUE_NAMES[venue.venue]}
            </Text>
          </Pressable>

          {/* Brand-required disclosure: nominative use of the museum's name in
            descriptive copy only — never in the wordmark. */}
          <Text style={styles.unofficialNote}>
            An unofficial companion for The Metropolitan Museum of Art
          </Text>
        </View>
      )}

      {/* Nav requested but impossible (cross-venue target, unknown room):
          honest dead-end with the one-tap way out. */}
      {navActive && !navRoute && (
        <View style={styles.noRoute} testID="route-not-found">
          <Text style={[type.body, styles.noRouteText]}>
            No route found between “{navFrom}” and “{navTo}” — routes never cross between the
            Fifth Avenue building and The Cloisters.
          </Text>
          <Pressable
            style={styles.noRouteClose}
            onPress={exitNav}
            accessibilityLabel="End navigation"
            testID="nav-close"
          >
            <Text style={styles.noRouteCloseText}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* The navigation teardown — same clipping-layer pattern as the room
          sheet so its FULL detent can rise past the (hidden) chrome. */}
      {navActive && navRoute && (
        <NavSheet
          route={navRoute}
          destTitle={destTitle}
          activeStep={step}
          avoidStairs={avoidStairs}
          onToggleAvoid={() => router.setParams({ avoid: avoidStairs ? '' : 'stairs' })}
          onStep={goToStep}
          onConfirmHere={confirmHere}
          onExit={exitNav}
          // Retarget: tapping the destination title opens search; room rows
          // there swap the target in place (route recomputes from the current
          // anchor — see RoomRow.focusRoom's retarget branch).
          onRetarget={() =>
            router.push({
              pathname: '/search',
              params: {
                retarget: anchor?.roomId ?? navFrom,
                ...(avoidStairs ? { avoid: 'stairs' } : null),
              },
            })
          }
          // Arrival handoff: WHAT'S HERE opens the destination's artifacts
          // teardown — seamless return to browse, anchored at the destination.
          onWhatsHere={
            data.objectsInGallery(navRoute.to.id).length > 0
              ? () => {
                  const dest = navRoute.to;
                  setAnchor(anchorForRoom(dest, 'gallery'));
                  setSelected(dest);
                  setFloor(dest.floor);
                  exitNav();
                }
              : undefined
          }
          onDone={() => {
            setAnchor(anchorForRoom(navRoute.to, 'gallery'));
            exitNav();
          }}
          onDetentChange={setNavDetent}
        />
      )}

      {/* Debug-only control, overlaid on the map (j9 drives the reroute with
          it). Rendered after the NavSheet clipping layer so it stays tappable
          at the HEADER-ONLY detent. */}
      {navActive && navRoute && !arrived && (
        <Pressable style={styles.debugBtn} onPress={simulateOffRouteFix} testID="simulate-fix">
          <Text style={styles.debugText}>Simulate off-route fix (debug)</Text>
        </Pressable>
      )}

      {/* The room sheet is its own full-screen clipping layer (not part of
          the bottom column) so its FULL detent can rise past the chrome. In
          nav mode it stacks OVER the nav sheet: I'M HERE doubles as a manual
          location fix (the machine advances/reroutes), DIRECTIONS retargets. */}
      {selected && (
        <HomeRoomSheet
          room={selected}
          objects={data.objectsInGallery(selected.id)}
          totalCount={data.galleryObjectCount(selected.id)}
          originId={anchor?.roomId ?? 'great-hall'}
          hasGraph={selectedMuseum?.capabilities.hasGraph ?? true}
          museumShortName={selectedMuseum?.shortName ?? ''}
          onImHere={() => {
            setAnchor(anchorForRoom(selected, 'gallery'));
            setSelected(undefined);
          }}
          onDirections={() => {
            const origin = anchor?.roomId ?? (navActive ? navFrom : undefined) ?? 'great-hall';
            if (navActive) {
              // Already navigating: swap the target in place (same history
              // entry — back still exits the whole nav session).
              router.setParams({ nav: `${origin}:${selected.id}`, obj: '' });
            } else {
              // Entering nav PUSHES a new home entry: back = exit nav mode.
              router.push({ pathname: '/', params: { nav: `${origin}:${selected.id}` } });
            }
            setSelected(undefined);
          }}
          onClose={() => setSelected(undefined)}
          onDetentChange={setRoomDetent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  mapFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  topOverlay: {
    pointerEvents: 'box-none',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  wordmark: {
    ...type.display,
    fontSize: 28,
    lineHeight: 34,
    textTransform: 'uppercase',
  },
  wordmarkAccent: {
    color: colors.red,
  },
  searchBar: {
    // Leave the right edge clear for the FloorMap floor chips underneath
    // (44pt chips + spacing.md inset).
    marginRight: 60,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  searchPlaceholder: {
    ...type.body,
    color: colors.inkFaint,
  },
  bottomOverlay: {
    pointerEvents: 'box-none',
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Horizontal limits live on the overlay as padding so children can use
    // maxWidth '100%': margins do NOT cap a nowrap chip (its intrinsic
    // min-content width is the full single-line title — measured riding the
    // screen edge with "Gallery Exhibition Galleries 964 & 965 · Floor G").
    paddingLeft: spacing.lg,
    paddingRight: spacing.md, // ≥16px breathing room at the right screen edge
  },
  locateChip: {
    alignSelf: 'flex-start',
    maxWidth: '100%', // hard cap; the texts above ellipsize at one line
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  locateChipUnknown: {
    backgroundColor: colors.red,
  },
  locateChipText: {
    ...type.label,
    color: colors.white,
  },
  // Second line: the active venue (Fifth Avenue / The Cloisters) — venue is
  // part of location state, surfaced on the chip, set via the locate sheet.
  locateChipVenue: {
    ...type.label,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1,
    color: 'rgba(255,255,255,0.75)',
  },
  unofficialNote: {
    ...type.meta,
    fontSize: 11,
    lineHeight: 14,
    color: colors.inkSecondary,
    marginRight: spacing.sm, // overlay padding supplies the rest
    marginBottom: spacing.sm,
  },
  venueToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'flex-start',
    maxWidth: '100%', // same breathing-room rule as the locate chip
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44, // HIG tap target (tap anywhere to dismiss)
    backgroundColor: colors.red,
  },
  venueToastText: {
    ...type.label,
    color: colors.white,
    flexShrink: 1, // long toast copy shrinks before pushing ✕ off the chip
  },
  venueToastClose: {
    ...type.label,
    color: colors.white,
  },
  reroutingToast: {
    position: 'absolute',
    top: spacing.xl,
    alignSelf: 'center',
    backgroundColor: colors.ink,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  reroutingText: {
    ...type.label,
    color: colors.white,
  },
  noRoute: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  noRouteText: {
    flex: 1,
  },
  noRouteClose: {
    width: 44, // HIG tap target
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  noRouteCloseText: {
    ...type.label,
    letterSpacing: 0,
  },
  debugBtn: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.lg,
    minHeight: 44, // HIG tap target
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  debugText: {
    ...type.meta,
    fontSize: 12,
    color: colors.inkFaint,
    textDecorationLine: 'underline',
  },
});
