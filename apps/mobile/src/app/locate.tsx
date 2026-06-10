import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { components } from '@met/shared';
import {
  GPS_MAX_CONFIDENCE,
  applyFusedInput,
  resolveGpsArea,
  type Anchor as SharedAnchor,
  type Site,
} from '@met/shared/positioning';

import { floorLabel, floorNumber } from '@/components/MapGeometry';
import {
  Anchor,
  VENUE_NAMES,
  anchorForRoom,
  applyVenue,
  getAnchor,
  getVenue,
  setAnchor,
  useVenue,
} from '@/components/LocateState';
import { apiBase } from '@/data/apiBase';
import { MetObject, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

type LocatePhotoResponse = components['schemas']['LocatePhotoResponse'];

type GpsState =
  | { phase: 'resolving' }
  | { phase: 'resolved'; anchor: Anchor }
  /** Fix was usable, but a FRESH room anchor outranks it (fusion rules). */
  | { phase: 'kept'; anchor: Anchor }
  | { phase: 'unavailable' };

/**
 * Photo localization (POST /api/v1/locate/photo): one round trip; the server
 * OCRs any wall label in frame (deterministic catalog match) and runs
 * embedding retrieval for top-3 candidates. The client only uploads bytes.
 */
type PhotoState =
  | { phase: 'matching'; uri: string }
  | { phase: 'done'; uri: string; res: LocatePhotoResponse }
  | { phase: 'failed'; uri: string };

/**
 * UI store anchor → shared/positioning anchor, so the locator's GPS fix runs
 * through the real fusion rules (applyInput): a fresh room claim beats the
 * fix; a stale one (> ROOM_ANCHOR_DECAY_MS) is superseded with its floor
 * retained as "(assumed)".
 */
function sharedAnchorOf(a: Anchor | undefined): SharedAnchor | undefined {
  if (!a) return undefined;
  const site: Site = a.site ?? 'fifthAve';
  if (a.source === 'gps') {
    return {
      kind: 'area',
      site,
      label: a.label,
      place: site === 'fifthAve' ? 'Near Great Hall' : 'Near the Cloisters entrance',
      assumedFloor: a.assumedFloor,
      source: 'gps',
      confidence: GPS_MAX_CONFIDENCE,
      timestamp: a.timestamp ?? 0,
    };
  }
  if (!a.roomId) return undefined;
  return {
    kind: 'room',
    gallery: a.roomId,
    floor: floorLabel(a.floor ?? 1),
    site,
    source: a.source === 'gallery' ? 'manual' : a.source,
    confidence: 1,
    timestamp: a.timestamp ?? 0,
  };
}

/**
 * Locate sheet (modal) — one display, no tabs. GPS resolves first and
 * auto-applies a wing-level anchor; the text box (gallery number or artifact
 * name) and the photo flow are overrides that beat the GPS anchor.
 */
export default function LocateScreen() {
  const data = useData();
  const venue = useVenue();
  const [gps, setGps] = useState<GpsState>({ phase: 'resolving' });
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [artifactHits, setArtifactHits] = useState<MetObject[]>([]);
  const [photo, setPhoto] = useState<PhotoState | undefined>();
  // Set once a manual override applied (or the sheet closed): a late GPS fix
  // must never clobber an explicit room/artifact/photo anchor.
  const overridden = useRef(false);

  // Opening the locator always re-resolves GPS (freshness beats precision):
  // the fix is folded through shared/positioning.applyFusedInput, so it
  // supersedes a STALE room anchor (keeping its floor as "(assumed)") but
  // never a fresh one — by type it can only ever claim a wing, never a
  // gallery — and a confident fix at the OTHER venue auto-switches the app
  // venue (dismissible toast) unless the venue was manually pinned.
  useEffect(() => {
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) throw new Error('denied');
        const pos = await Location.getCurrentPositionAsync({});
        if (overridden.current) return;
        const now = Date.now();
        const fix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? 0,
        };
        const fused = applyFusedInput(
          { anchor: sharedAnchorOf(getAnchor()), venue: getVenue() },
          { type: 'gps', fix, at: now },
        );
        // Venue auto-switch first, so setAnchor's coupling sees the new venue
        // and the toast ("You're at The Cloisters — switched") is raised.
        for (const ev of fused.events) applyVenue(ev.venue, ev.cause);
        const next = fused.state.anchor;
        if (next?.kind === 'area' && next.timestamp === now) {
          const anchor: Anchor = {
            // Wing-level only: highlight the entrance hall, never a gallery.
            roomId: next.site === 'fifthAve' ? 'great-hall' : undefined,
            label: next.label,
            floor:
              next.assumedFloor !== undefined
                ? floorNumber(next.assumedFloor)
                : next.site === 'fifthAve'
                  ? 1
                  : undefined,
            site: next.site,
            assumedFloor: next.assumedFloor,
            source: 'gps',
            timestamp: now,
          };
          setAnchor(anchor);
          setGps({ phase: 'resolved', anchor });
        } else if (resolveGpsArea(fix, now) && getAnchor()) {
          // Usable fix, but the current room anchor is still fresh — keep it.
          setGps({ phase: 'kept', anchor: getAnchor()! });
        } else {
          // Rejected outright (poor accuracy / off-campus outlier), or the
          // fix is at a venue the user manually pinned away from.
          setGps({ phase: 'unavailable' });
        }
      } catch {
        if (!overridden.current) setGps({ phase: 'unavailable' });
      }
    })();
    return () => {
      overridden.current = true;
    };
  }, []);

  const apply = (anchor: Anchor) => {
    overridden.current = true;
    setAnchor(anchor);
    router.dismissTo('/');
  };

  const onInput = (t: string) => {
    setInput(t);
    setError('');
    setArtifactHits([]);
  };

  const locateRoom = () => {
    const id = input.trim();
    const room = id ? data.getGallery(id) : undefined;
    if (!room) {
      setArtifactHits([]);
      setError(`Gallery “${id}” isn't on the map — check the number posted at the room entrance.`);
      return;
    }
    apply(anchorForRoom(room, 'gallery'));
  };

  const pickArtifact = (o: MetObject) => {
    const room = data.getGallery(o.gallery);
    apply(
      room
        ? anchorForRoom(room, 'artifact')
        : { label: `Gallery ${o.gallery}`, source: 'artifact', timestamp: Date.now() },
    );
  };

  const locateArtifact = () => {
    const q = input.trim();
    const hits = q ? data.searchAutocomplete(q, 6).filter((o) => o.gallery) : [];
    if (hits.length === 0) {
      setArtifactHits([]);
      setError(
        q
          ? `No artifact on view matches “${q}”.`
          : 'Type an artifact name or accession number first.',
      );
      return;
    }
    if (hits.length === 1) {
      pickArtifact(hits[0]);
      return;
    }
    setError('');
    setArtifactHits(hits);
  };

  /** Photo anchor for a gallery number the server matched. */
  const applyPhotoGallery = (galleryNumber: string, floor: string) => {
    const room = data.getGallery(galleryNumber);
    apply(
      room
        ? anchorForRoom(room, 'photo')
        : {
            label: `Gallery ${galleryNumber}${floor ? ` · Floor ${floor}` : ''}`,
            floor: floor ? floorNumber(floor) : undefined,
            source: 'photo',
            timestamp: Date.now(),
          },
    );
  };

  const locateByPhoto = async (uri: string, base64: string) => {
    setPhoto({ phase: 'matching', uri });
    try {
      const res = await fetch(`${apiBase()}/api/v1/locate/photo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64 }),
      });
      if (!res.ok) throw new Error(`locate/photo ${res.status}`);
      setPhoto({ phase: 'done', uri, res: (await res.json()) as LocatePhotoResponse });
    } catch {
      setPhoto({ phase: 'failed', uri });
    }
  };

  const choosePhoto = async () => {
    // base64: true — the exact picked bytes go to the server (no re-encode);
    // the server downscales/decodes; contract caps decoded size at 4 MB.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
    });
    if (!result.canceled) {
      setError('');
      setArtifactHits([]);
      const asset = result.assets[0];
      const base64 = asset.base64 ?? asset.uri.replace(/^data:[^,]*,/, '');
      locateByPhoto(asset.uri, base64);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Where are you?</Text>

      <View style={styles.gpsPanel} testID="gps-status">
        {gps.phase === 'resolving' && (
          <View style={styles.gpsRow}>
            <ActivityIndicator color={colors.red} size="small" />
            <Text style={type.meta}>Locating via GPS…</Text>
          </View>
        )}
        {gps.phase === 'resolved' && (
          <>
            <Text style={styles.gpsKicker}>Your location</Text>
            <Text style={styles.gpsAnchor}>{gps.anchor.label}</Text>
            <Text style={type.meta}>
              {gps.anchor.assumedFloor !== undefined
                ? 'Set from GPS — wing-level only; floor assumed from your last fix. For an exact room, override below.'
                : 'Set from GPS — wing-level only. For an exact room, override below.'}
            </Text>
          </>
        )}
        {gps.phase === 'kept' && (
          <>
            <Text style={styles.gpsKicker}>Your location</Text>
            <Text style={styles.gpsAnchor}>{gps.anchor.label}</Text>
            <Text style={type.meta}>
              GPS confirms you're at the museum — keeping your recent room fix.
              Moved since? Override below.
            </Text>
          </>
        )}
        {gps.phase === 'unavailable' && (
          <Text style={type.meta}>GPS unavailable indoors — set your location below.</Text>
        )}
      </View>

      {/* Venue override — venue is location state, not map chrome. A manual
          pick pins the venue for this session: GPS will never auto-switch
          away from it (shared/positioning venue/anchor coupling rule 3). */}
      <View style={styles.venueRow} testID="venue-row">
        <Text style={styles.venueKicker}>Venue</Text>
        {(['fifthAve', 'cloisters'] as const).map((s) => {
          const active = venue.venue === s;
          return (
            <Pressable
              key={s}
              style={[styles.venueBtn, active && styles.venueBtnActive]}
              onPress={() => applyVenue(s, 'manual')}
              testID={`venue-${s}`}
            >
              <Text style={[styles.venueBtnText, active && styles.venueBtnTextActive]}>
                {VENUE_NAMES[s]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actionCard} testID="locate-action-card">
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={onInput}
          placeholder="Gallery # — or artifact name / accession #"
          placeholderTextColor={colors.inkFaint}
          autoFocus
          autoCorrect={false}
          onSubmitEditing={() => (/^\d+$/.test(input.trim()) ? locateRoom() : locateArtifact())}
          testID="locate-input"
        />
        <View style={styles.btnRow}>
          <Pressable style={[styles.btn, styles.btnRoom]} onPress={locateRoom} testID="locate-room-btn">
            <Text style={styles.btnText}>Locate room</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnArtifact]}
            onPress={locateArtifact}
            testID="locate-artifact-btn"
          >
            <Text style={styles.btnText}>Locate artifact</Text>
          </Pressable>
        </View>
        <Pressable style={styles.photoBtn} onPress={choosePhoto} testID="locate-photo-btn">
          <CameraIcon color={colors.ink} />
          <Text style={styles.photoBtnText}>Locate by photo</Text>
        </Pressable>
      </View>
      {error ? (
        <Text style={styles.error} testID="locate-error">
          {error}
        </Text>
      ) : null}

      <ScrollView style={styles.flex1} keyboardShouldPersistTaps="handled">
        {artifactHits.map((o) => (
          <Pressable
            key={o.objectID}
            style={styles.row}
            onPress={() => pickArtifact(o)}
            testID={`locate-candidate-${o.objectID}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {o.title}
              </Text>
              <Text style={type.meta} numberOfLines={1}>
                {o.artist || o.dept} · Gallery {o.gallery}
              </Text>
            </View>
            <Text style={styles.rowAction}>I'm next to this</Text>
          </Pressable>
        ))}

        {photo ? (
          <>
            <View style={styles.photoHeader}>
              <Image source={{ uri: photo.uri }} style={styles.photoThumb} resizeMode="cover" />
              <Text style={[type.meta, styles.flex1]}>
                {photo.phase === 'matching'
                  ? 'Matching your photo against the collection…'
                  : photo.phase === 'failed'
                    ? 'Photo lookup needs a connection — try again, or set your room above.'
                    : photo.res.label
                      ? 'Wall label read — you are next to:'
                      : photo.res.candidates.length > 0
                        ? 'Best matches:'
                        : 'No match — try a clearer photo, or include the wall label.'}
              </Text>
            </View>
            {photo.phase === 'matching' && (
              <ActivityIndicator color={colors.red} style={styles.photoSpinner} />
            )}
            {photo.phase === 'done' && photo.res.label && (
              <Pressable
                style={styles.row}
                onPress={() => applyPhotoGallery(photo.res.label!.gallery, photo.res.label!.floor)}
                testID="locate-photo-label"
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {data.getObject(photo.res.label.objectID)?.title ??
                      `Object ${photo.res.label.accession}`}
                  </Text>
                  <Text style={type.meta} numberOfLines={1}>
                    Wall label · Gallery {photo.res.label.gallery}
                    {photo.res.label.floor ? ` · Floor ${photo.res.label.floor}` : ''}
                  </Text>
                </View>
                <Text style={styles.rowAction}>I'm here</Text>
              </Pressable>
            )}
            {photo.phase === 'done' &&
              !photo.res.label &&
              photo.res.candidates.map((c) => (
                <Pressable
                  key={c.objectID}
                  style={styles.row}
                  onPress={() => applyPhotoGallery(c.gallery, c.floor)}
                  testID={`locate-photo-candidate-${c.objectID}`}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {c.title}
                    </Text>
                    <Text style={type.meta} numberOfLines={1}>
                      {c.artist ? `${c.artist} · ` : ''}Gallery {c.gallery}
                      {c.floor ? ` · Floor ${c.floor}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.rowAction}>This one</Text>
                </Pressable>
              ))}
            {photo.phase !== 'matching' && (
              <Pressable
                style={styles.linkBtn}
                onPress={() => setPhoto(undefined)}
                testID="locate-photo-retry"
              >
                <Text style={styles.linkBtnText}>None of these — try another photo</Text>
              </Pressable>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function CameraIcon({ color = colors.red, size = 18 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 7.5h4.2L9 5h6l1.8 2.5H21V19H3V7.5z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13} r={3.2} stroke={color} strokeWidth={1.8} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: {
    ...type.title,
  },
  gpsPanel: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.xs,
  },
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  gpsKicker: {
    ...type.label,
    color: colors.red,
  },
  gpsAnchor: {
    ...type.title,
  },
  // Compact segmented venue row: label + two ≥44pt segments.
  venueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  venueKicker: {
    ...type.label,
    color: colors.inkSecondary,
    marginRight: spacing.xs,
  },
  venueBtn: {
    flex: 1,
    minHeight: 44, // HIG tap target
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  venueBtnActive: {
    backgroundColor: colors.ink,
  },
  venueBtnText: {
    ...type.label,
    letterSpacing: 0.5,
  },
  venueBtnTextActive: {
    color: colors.white,
  },
  // One visual group for all three locate methods: text input, the
  // room/artifact pair below it, and the photo button full-width underneath —
  // same button family, hierarchy through weight (outlined vs filled).
  actionCard: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  input: {
    ...type.body,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  btnRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  btnRoom: {
    backgroundColor: colors.red,
  },
  btnArtifact: {
    backgroundColor: colors.ink,
  },
  btnText: {
    ...type.label,
    color: colors.white,
  },
  error: {
    ...type.meta,
    color: colors.red,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  rowAction: {
    ...type.label,
    color: colors.red,
  },
  linkBtn: {
    paddingVertical: spacing.md,
  },
  linkBtnText: {
    ...type.label,
    color: colors.red,
  },
  photoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  photoThumb: {
    width: 56,
    height: 56,
    backgroundColor: colors.surface,
  },
  photoSpinner: {
    paddingVertical: spacing.md,
  },
  // Outlined/ink variant of the .btn family — same size, lighter weight.
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  photoBtnText: {
    ...type.label,
    color: colors.ink,
  },
  flex1: {
    flex: 1,
  },
});
