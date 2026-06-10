/**
 * Positioning fusion state machine for Met Navigator. Platform-neutral pure
 * functions: the Expo client owns the UI store; the rules that decide which
 * fix wins, what GPS may claim, and when a route recalculates live here.
 *
 * Anchor model — {anchor, confidence, source, timestamp} as a discriminated
 * union whose TYPE makes a GPS room-claim unrepresentable:
 *
 *   RoomAnchor  — gallery-level. Sources: manual room entry (1.0), artifact
 *                 pick (1.0), photo-localization confirm (server confidence).
 *                 `source` deliberately excludes 'gps'.
 *   AreaAnchor  — wing/entrance-level. The ONLY anchor a GPS fix can produce;
 *                 it has no gallery field at all. Confidence is capped at
 *                 GPS_MAX_CONFIDENCE. Why: measured browser-GPS reality
 *                 (data/evals/reports/gps.md) — 65 m indoor noise spreads
 *                 fixes over 69 candidate rooms with the true room hit only
 *                 14% of the time. Room-level GPS would be majority-wrong.
 *
 * Replacement rules (applyInput) — gate-review-confirmed fusion semantics:
 *   - any room input (manual / artifact / photo confirm) replaces whatever
 *     anchor exists — it is an explicit user statement; FRESH MANUAL BEATS
 *     EVERYTHING;
 *   - freshness beats precision: a usable GPS fix SUPERSEDES a room anchor
 *     that has gone stale (older than ROOM_ANCHOR_DECAY_MS — the user has
 *     been walking; the old room is probably wrong), but never a fresh one;
 *   - floor retention: GPS carries no floor, so when GPS supersedes a room
 *     anchor the superseded anchor's floor is kept as `assumedFloor` and
 *     surfaced in the label as "(assumed)". It also carries forward across
 *     subsequent GPS refreshes until a room input provides a real floor;
 *   - time decay: a room anchor's *claim* decays from room-level to
 *     wing-level confidence after ROOM_ANCHOR_DECAY_MS (see anchorLevel /
 *     effectiveConfidence).
 *
 * Off-route detection (onRouteAnchor): room-anchored fixes drive checkpoint
 * auto-advance and recalc; an off-route anchor signals `reroute` exactly once
 * per deviation (deduped by gallery until the user is back on a route).
 */

export type Site = "fifthAve" | "cloisters";

/** Anchor sources that may claim a specific room. 'gps' is not assignable. */
export type RoomSource = "manual" | "artifact" | "photo";

export interface RoomAnchor {
  kind: "room";
  gallery: string;
  /** Floor label vocabulary: "G", "1", "1M", "2", ... */
  floor: string;
  site: Site;
  source: RoomSource;
  confidence: number;
  timestamp: number;
}

export interface AreaAnchor {
  kind: "area";
  site: Site;
  /**
   * Display string, e.g. "Near Great Hall · Floor 1" or — when this anchor
   * superseded a room anchor — "Near Great Hall · Floor 2 (assumed)".
   */
  label: string;
  /** Place part of the label, kept so refreshes can re-derive it. */
  place: string;
  /**
   * Floor retained from a superseded room anchor (GPS itself carries no
   * floor). Carries forward across GPS refreshes until a room input provides
   * a real floor. Floor label vocabulary: "G", "1", "1M", "2", ...
   */
  assumedFloor?: string;
  source: "gps";
  confidence: number;
  timestamp: number;
}

export type Anchor = RoomAnchor | AreaAnchor;

export interface GpsFix {
  lat: number;
  lon: number;
  /** Reported horizontal accuracy in meters (0/unknown treated as good). */
  accuracyM: number;
}

export type PositionInput =
  | {
      type: "room";
      source: RoomSource;
      gallery: string;
      floor: string;
      site: Site;
      /** Photo confirms pass the server's confidence; manual/artifact omit (1.0). */
      confidence?: number;
      at: number;
    }
  | { type: "gps"; fix: GpsFix; at: number };

/** Hard ceiling on GPS confidence — wing-level is the maximum claim. */
export const GPS_MAX_CONFIDENCE = 0.4;
/** Fixes with worse reported accuracy than this are ignored outright. */
export const GPS_MAX_ACCURACY_M = 300;
/** Fixes farther than this from a site entrance are off-campus outliers. */
export const GPS_MAX_DISTANCE_M = 350;

/**
 * How long a room-level claim (manual / artifact / photo) stays trustworthy.
 * Defense of the constant: Met galleries are ~10–20 m across and browsing
 * pace runs ~0.3–0.5 m/s (dwell included), so 4 minutes ≈ 70–120 m ≈ 4–8
 * rooms of plausible drift — the same multi-room spread the GPS eval measured
 * at wing level (data/evals/reports/gps.md). Past this the old room is
 * majority-wrong, so the claim decays to wing-level confidence and a fresh
 * usable GPS fix is allowed to supersede the anchor.
 */
export const ROOM_ANCHOR_DECAY_MS = 4 * 60_000;

const SITE_ENTRANCES: ReadonlyArray<{
  site: Site;
  place: string;
  /** Floor of the entrance itself, when one is meaningful to display. */
  entranceFloor?: string;
  lat: number;
  lon: number;
}> = [
  // Fifth Avenue main entrance == the Great Hall (J1 coordinates).
  { site: "fifthAve", place: "Near Great Hall", entranceFloor: "1", lat: 40.7794, lon: -73.9632 },
  { site: "cloisters", place: "Near the Cloisters entrance", lat: 40.8649, lon: -73.9317 },
];

const D2R = Math.PI / 180;

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

/**
 * Resolve a raw GPS fix to a wing-level AreaAnchor, or null when the fix is
 * unusable (accuracy worse than GPS_MAX_ACCURACY_M, or farther than
 * GPS_MAX_DISTANCE_M from every site entrance — e.g. the Central Park
 * outlier case in data/evals/reports/gps.md).
 */
export function resolveGpsArea(fix: GpsFix, at: number): AreaAnchor | null {
  if (fix.accuracyM > GPS_MAX_ACCURACY_M) return null;
  let best: (typeof SITE_ENTRANCES)[number] | null = null;
  let bestD = Infinity;
  for (const e of SITE_ENTRANCES) {
    const d = haversineM(fix.lat, fix.lon, e.lat, e.lon);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best === null || bestD > GPS_MAX_DISTANCE_M) return null;
  // Confidence scales down with reported accuracy, capped at the GPS ceiling.
  const confidence =
    GPS_MAX_CONFIDENCE * Math.min(1, 65 / Math.max(fix.accuracyM, 1));
  const label = best.entranceFloor ? `${best.place} · Floor ${best.entranceFloor}` : best.place;
  return {
    kind: "area",
    site: best.site,
    label,
    place: best.place,
    source: "gps",
    confidence,
    timestamp: at,
  };
}

/** Area anchor carrying a floor retained from a superseded room anchor. */
function withAssumedFloor(area: AreaAnchor, floor: string): AreaAnchor {
  return { ...area, assumedFloor: floor, label: `${area.place} · Floor ${floor} (assumed)` };
}

/**
 * Where the anchor's claim stands right now: room anchors decay to wing level
 * once they are older than ROOM_ANCHOR_DECAY_MS (the user kept walking); GPS
 * area anchors are wing-level by construction.
 */
export function anchorLevel(anchor: Anchor, now: number): "room" | "wing" {
  return anchor.kind === "room" && now - anchor.timestamp < ROOM_ANCHOR_DECAY_MS
    ? "room"
    : "wing";
}

/** Confidence after time decay — a stale room claim is worth no more than GPS. */
export function effectiveConfidence(anchor: Anchor, now: number): number {
  return anchorLevel(anchor, now) === "room"
    ? anchor.confidence
    : Math.min(anchor.confidence, GPS_MAX_CONFIDENCE);
}

/**
 * The fusion step: fold one input into the current anchor. Returns the next
 * anchor — `current` itself (same reference) when the input is ignored.
 *
 * Gate-confirmed semantics:
 *  - any room input replaces whatever exists (fresh manual beats everything);
 *  - freshness beats precision: a usable GPS fix supersedes a room anchor
 *    older than ROOM_ANCHOR_DECAY_MS — the user has been walking and the old
 *    room is probably wrong — but never a fresh one;
 *  - floor retention: when GPS supersedes a room anchor, the superseded
 *    anchor's floor is kept as `assumedFloor` ("(assumed)" in the label) and
 *    carries forward across subsequent GPS refreshes.
 */
export function applyInput(
  current: Anchor | undefined,
  input: PositionInput,
): Anchor | undefined {
  if (input.type === "room") {
    return {
      kind: "room",
      gallery: input.gallery,
      floor: input.floor,
      site: input.site,
      source: input.source,
      confidence: input.source === "photo" ? (input.confidence ?? 1) : 1,
      timestamp: input.at,
    };
  }
  const area = resolveGpsArea(input.fix, input.at);
  if (!area) return current; // unusable fix changes nothing
  if (current?.kind === "room") {
    // A fresh explicit room claim beats a wing-level fix; a stale one doesn't.
    if (input.at - current.timestamp < ROOM_ANCHOR_DECAY_MS) return current;
    return withAssumedFloor(area, current.floor);
  }
  if (current?.kind === "area" && current.assumedFloor !== undefined) {
    return withAssumedFloor(area, current.assumedFloor);
  }
  return area;
}

// ---------------------------------------------------------------------------
// Route tracking: anchor changes → checkpoint auto-advance / recalc signals.

export interface RouteProgress {
  /** Index of the step the user is currently on. */
  stepIndex: number;
  /** Gallery already reported off-route — dedupes to one signal per deviation. */
  offRouteGallery: string | null;
}

export type RouteSignal =
  | { type: "advance"; stepIndex: number }
  | { type: "reroute"; fromGallery: string }
  | { type: "none" };

export function initialRouteProgress(
  preexisting?: Anchor | { roomId?: string } | null,
): RouteProgress {
  // An anchor that already existed when the route opened is not a *new* fix:
  // seed the dedupe so a stale off-route anchor doesn't instantly reroute.
  const gallery =
    preexisting && "kind" in preexisting
      ? preexisting.kind === "room"
        ? preexisting.gallery
        : null
      : (preexisting?.roomId ?? null);
  return { stepIndex: 0, offRouteGallery: gallery };
}

/**
 * Evaluate a (new) anchor against the active route. `routeGalleries` is the
 * per-step gallery list (null for corridor/landing steps). Only RoomAnchors
 * participate: an AreaAnchor (GPS) can neither advance nor reroute — the type
 * carries no gallery to compare. Signals:
 *   advance  — anchor matches a step ahead of the current one;
 *   reroute  — anchor's gallery is not on the route (once per deviation);
 *   none     — GPS/unknown anchor, same/behind step, or already-reported.
 */
export function onRouteAnchor(
  progress: RouteProgress,
  anchor: Anchor | undefined,
  routeGalleries: ReadonlyArray<string | null>,
): { progress: RouteProgress; signal: RouteSignal } {
  if (!anchor || anchor.kind !== "room") return { progress, signal: { type: "none" } };
  const idx = routeGalleries.indexOf(anchor.gallery);
  if (idx === -1) {
    if (progress.offRouteGallery === anchor.gallery)
      return { progress, signal: { type: "none" } };
    return {
      progress: { ...progress, offRouteGallery: anchor.gallery },
      signal: { type: "reroute", fromGallery: anchor.gallery },
    };
  }
  if (idx > progress.stepIndex) {
    return {
      progress: { stepIndex: idx, offRouteGallery: null },
      signal: { type: "advance", stepIndex: idx },
    };
  }
  // Same or earlier step: stay put (steps advance monotonically; the user can
  // always scrub back manually). Being on route clears the deviation dedupe.
  return {
    progress: progress.offRouteGallery === null ? progress : { ...progress, offRouteGallery: null },
    signal: { type: "none" },
  };
}
