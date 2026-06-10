import { describe, it, expect, expectTypeOf } from "vitest";
import {
  GPS_MAX_CONFIDENCE,
  ROOM_ANCHOR_DECAY_MS,
  anchorLevel,
  applyInput,
  effectiveConfidence,
  initialRouteProgress,
  onRouteAnchor,
  resolveGpsArea,
  type Anchor,
  type AreaAnchor,
  type RoomAnchor,
  type RouteProgress,
} from "./positioning.ts";

const ENTRANCE = { lat: 40.7794, lon: -73.9632 }; // Fifth Ave / Great Hall (J1)

const roomInput = (gallery: string, at = 1000) =>
  ({ type: "room", source: "manual", gallery, floor: "1", site: "fifthAve", at }) as const;

const room = (gallery: string): RoomAnchor => ({
  kind: "room",
  gallery,
  floor: "1",
  site: "fifthAve",
  source: "manual",
  confidence: 1,
  timestamp: 1000,
});

describe("GPS can never claim a room", () => {
  it("is unrepresentable at the type level: AreaAnchor has no gallery, RoomAnchor has no 'gps' source", () => {
    expectTypeOf<AreaAnchor>().not.toHaveProperty("gallery");
    expectTypeOf<RoomAnchor["source"]>().toEqualTypeOf<"manual" | "artifact" | "photo">();
    // @ts-expect-error — 'gps' is not a RoomSource
    const impossible: RoomAnchor["source"] = "gps";
    void impossible;
  });

  it("a perfect entrance fix still resolves only to a wing-level area anchor", () => {
    const a = resolveGpsArea({ ...ENTRANCE, accuracyM: 5 }, 1)!;
    expect(a.kind).toBe("area");
    expect(a.site).toBe("fifthAve");
    expect(a.label).toBe("Near Great Hall · Floor 1");
    expect("gallery" in a).toBe(false);
    expect(a.confidence).toBeLessThanOrEqual(GPS_MAX_CONFIDENCE);
  });

  it("confidence is capped and degrades with reported accuracy", () => {
    const good = resolveGpsArea({ ...ENTRANCE, accuracyM: 0 }, 1)!;
    const noisy = resolveGpsArea({ ...ENTRANCE, accuracyM: 130 }, 1)!;
    expect(good.confidence).toBe(GPS_MAX_CONFIDENCE);
    expect(noisy.confidence).toBeLessThan(good.confidence);
  });

  it("rejects outliers: worse than 300 m accuracy, or a Central Park fix", () => {
    expect(resolveGpsArea({ ...ENTRANCE, accuracyM: 800 }, 1)).toBeNull();
    // ~575 m west of the entrance, tight accuracy — still not at the museum.
    expect(resolveGpsArea({ lat: 40.7794, lon: -73.97, accuracyM: 50 }, 1)).toBeNull();
  });

  it("resolves the Cloisters entrance to the Cloisters site", () => {
    const a = resolveGpsArea({ lat: 40.8649, lon: -73.9317, accuracyM: 40 }, 1)!;
    expect(a.site).toBe("cloisters");
  });
});

describe("applyInput fusion rules", () => {
  it("manual room entry anchors at confidence 1.0", () => {
    const a = applyInput(undefined, roomInput("131")) as RoomAnchor;
    expect(a).toMatchObject({ kind: "room", gallery: "131", source: "manual", confidence: 1 });
  });

  it("photo input carries the server's confidence", () => {
    const a = applyInput(undefined, {
      type: "room",
      source: "photo",
      gallery: "822",
      floor: "2",
      site: "fifthAve",
      confidence: 0.83,
      at: 5,
    }) as RoomAnchor;
    expect(a.confidence).toBe(0.83);
  });

  it("a GPS fix fills a vacuum with an area anchor", () => {
    const a = applyInput(undefined, { type: "gps", fix: { ...ENTRANCE, accuracyM: 40 }, at: 2 });
    expect(a?.kind).toBe("area");
  });

  it("a FRESH manual anchor beats a later GPS fix (the anchor is returned untouched)", () => {
    const manual = applyInput(undefined, roomInput("131")); // t = 1000
    const afterGps = applyInput(manual, {
      type: "gps",
      fix: { ...ENTRANCE, accuracyM: 10 },
      at: 1000 + ROOM_ANCHOR_DECAY_MS - 1, // accurate, but inside the freshness window
    });
    expect(afterGps).toBe(manual); // same reference: input ignored
    expect((afterGps as RoomAnchor).gallery).toBe("131");
  });

  it("freshness beats precision: a usable GPS fix SUPERSEDES a stale room anchor", () => {
    const manual = applyInput(undefined, roomInput("131")); // t = 1000, floor "1"
    const after = applyInput(manual, {
      type: "gps",
      fix: { ...ENTRANCE, accuracyM: 40 },
      at: 1000 + ROOM_ANCHOR_DECAY_MS, // the user has been walking ≥ the decay window
    }) as AreaAnchor;
    expect(after.kind).toBe("area");
    expect(after.source).toBe("gps");
    // Floor retention: GPS carries no floor → keep the superseded floor, marked assumed.
    expect(after.assumedFloor).toBe("1");
    expect(after.label).toBe("Near Great Hall · Floor 1 (assumed)");
  });

  it("the assumed floor carries forward across subsequent GPS refreshes", () => {
    const manual = applyInput(undefined, {
      type: "room",
      source: "manual",
      gallery: "822",
      floor: "2",
      site: "fifthAve",
      at: 0,
    });
    const t1 = ROOM_ANCHOR_DECAY_MS + 1;
    const first = applyInput(manual, {
      type: "gps",
      fix: { ...ENTRANCE, accuracyM: 50 },
      at: t1,
    }) as AreaAnchor;
    const second = applyInput(first, {
      type: "gps",
      fix: { ...ENTRANCE, accuracyM: 30 },
      at: t1 + 60_000,
    }) as AreaAnchor;
    expect(second.assumedFloor).toBe("2");
    expect(second.label).toBe("Near Great Hall · Floor 2 (assumed)");
    // …until a room input provides a real floor again.
    const room = applyInput(second, roomInput("131", t1 + 120_000)) as RoomAnchor;
    expect(room.kind).toBe("room");
    expect(room.floor).toBe("1");
  });

  it("a room input replaces a GPS area anchor", () => {
    const gps = applyInput(undefined, { type: "gps", fix: { ...ENTRANCE, accuracyM: 40 }, at: 1 });
    const a = applyInput(gps, roomInput("534", 2)) as RoomAnchor;
    expect(a.kind).toBe("room");
    expect(a.gallery).toBe("534");
  });

  it("a rejected GPS fix leaves the current anchor untouched", () => {
    const gps = applyInput(undefined, { type: "gps", fix: { ...ENTRANCE, accuracyM: 40 }, at: 1 });
    const after = applyInput(gps, { type: "gps", fix: { ...ENTRANCE, accuracyM: 800 }, at: 2 });
    expect(after).toBe(gps);
  });
});

describe("time decay: room claims rot to wing-level after ROOM_ANCHOR_DECAY_MS", () => {
  const a = room("131"); // timestamp 1000, confidence 1

  it("anchorLevel flips room → wing exactly at the decay constant", () => {
    expect(anchorLevel(a, 1000)).toBe("room");
    expect(anchorLevel(a, 1000 + ROOM_ANCHOR_DECAY_MS - 1)).toBe("room");
    expect(anchorLevel(a, 1000 + ROOM_ANCHOR_DECAY_MS)).toBe("wing");
  });

  it("effectiveConfidence drops to the GPS ceiling once stale", () => {
    expect(effectiveConfidence(a, 1000)).toBe(1);
    expect(effectiveConfidence(a, 1000 + ROOM_ANCHOR_DECAY_MS)).toBeLessThanOrEqual(
      GPS_MAX_CONFIDENCE,
    );
  });

  it("GPS area anchors are wing-level from birth", () => {
    const gps = resolveGpsArea({ ...ENTRANCE, accuracyM: 5 }, 1000)!;
    expect(anchorLevel(gps, 1000)).toBe("wing");
    expect(effectiveConfidence(gps, 1000)).toBeLessThanOrEqual(GPS_MAX_CONFIDENCE);
  });
});

describe("onRouteAnchor: auto-advance and once-per-deviation recalc", () => {
  const routeGalleries = ["131", null, "375", "374", null, "822"]; // null = corridor steps
  const start: RouteProgress = { stepIndex: 0, offRouteGallery: null };

  it("a GPS area anchor can neither advance nor reroute", () => {
    const gps = applyInput(undefined, { type: "gps", fix: { ...ENTRANCE, accuracyM: 40 }, at: 1 });
    const { progress, signal } = onRouteAnchor(start, gps, routeGalleries);
    expect(signal).toEqual({ type: "none" });
    expect(progress).toBe(start);
  });

  it("an on-route anchor ahead advances to that step", () => {
    const { progress, signal } = onRouteAnchor(start, room("374"), routeGalleries);
    expect(signal).toEqual({ type: "advance", stepIndex: 3 });
    expect(progress.stepIndex).toBe(3);
  });

  it("the same or an earlier step does not regress", () => {
    const at3: RouteProgress = { stepIndex: 3, offRouteGallery: null };
    expect(onRouteAnchor(at3, room("374"), routeGalleries).signal).toEqual({ type: "none" });
    expect(onRouteAnchor(at3, room("131"), routeGalleries).signal).toEqual({ type: "none" });
    expect(onRouteAnchor(at3, room("131"), routeGalleries).progress.stepIndex).toBe(3);
  });

  it("an off-route anchor signals reroute exactly once per deviation", () => {
    const first = onRouteAnchor(start, room("999"), routeGalleries);
    expect(first.signal).toEqual({ type: "reroute", fromGallery: "999" });
    const second = onRouteAnchor(first.progress, room("999"), routeGalleries);
    expect(second.signal).toEqual({ type: "none" });
  });

  it("returning on-route re-arms the deviation detector", () => {
    const off = onRouteAnchor(start, room("999"), routeGalleries);
    const back = onRouteAnchor(off.progress, room("375"), routeGalleries);
    expect(back.signal).toEqual({ type: "advance", stepIndex: 2 });
    const offAgain = onRouteAnchor(back.progress, room("999"), routeGalleries);
    expect(offAgain.signal).toEqual({ type: "reroute", fromGallery: "999" });
  });

  it("initialRouteProgress seeds the dedupe with a pre-existing off-route anchor", () => {
    const stale: Anchor = room("999");
    const progress = initialRouteProgress(stale);
    expect(onRouteAnchor(progress, stale, routeGalleries).signal).toEqual({ type: "none" });
    // …but accepts UI-store shapes too, and an on-route one still advances.
    const ui = initialRouteProgress({ roomId: "374" });
    expect(ui.offRouteGallery).toBe("374");
  });
});
