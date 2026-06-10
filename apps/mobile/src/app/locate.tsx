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

import { Anchor, anchorForRoom, setAnchor } from '@/components/LocateState';
import { MetObject, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

type GpsState =
  | { phase: 'resolving' }
  | { phase: 'resolved'; anchor: Anchor }
  | { phase: 'unavailable' };

/**
 * Stub GPS confidence model: a fix near the museum is confident at *wing*
 * level only — GPS indoors can never name a specific room, so the resolved
 * anchor is the area around the Great Hall entrance, never a gallery.
 */
const GPS_STUB_ANCHOR: Anchor = {
  roomId: 'great-hall',
  label: 'Near Great Hall · Floor 1',
  floor: 1,
  source: 'gps',
};

/**
 * Locate sheet (modal) — one display, no tabs. GPS resolves first and
 * auto-applies a wing-level anchor; the text box (gallery number or artifact
 * name) and the photo flow are overrides that beat the GPS anchor.
 */
export default function LocateScreen() {
  const data = useData();
  const [gps, setGps] = useState<GpsState>({ phase: 'resolving' });
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [artifactHits, setArtifactHits] = useState<MetObject[]>([]);
  const [photoUri, setPhotoUri] = useState<string | undefined>();
  // Set once a manual override applied (or the sheet closed): a late GPS fix
  // must never clobber an explicit room/artifact/photo anchor.
  const overridden = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) throw new Error('denied');
        await Location.getCurrentPositionAsync({});
        if (overridden.current) return;
        // Confident wing-level fix → show it and auto-apply as the anchor.
        setGps({ phase: 'resolved', anchor: GPS_STUB_ANCHOR });
        setAnchor(GPS_STUB_ANCHOR);
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
      setError(`Gallery “${id}” is not on the stub map — check the number posted at the room entrance.`);
      return;
    }
    apply(anchorForRoom(room, 'gallery'));
  };

  const pickArtifact = (o: MetObject) => {
    const room = data.getGallery(o.gallery);
    apply(
      room
        ? anchorForRoom(room, 'artifact')
        : { label: `Gallery ${o.gallery}`, source: 'artifact' },
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

  // Fake "top-3 candidates": deterministic stub stand-in for the Phase 2
  // server-side embedding match — one highlight from each of three different
  // galleries on the stub map.
  const photoCandidates: MetObject[] = [];
  if (photoUri) {
    for (const g of data.galleries()) {
      const hit = data.objectsInGallery(g.id).find((o) => o.isHighlight && o.img);
      if (hit) photoCandidates.push(hit);
      if (photoCandidates.length === 3) break;
    }
  }

  const choosePhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
    });
    if (!result.canceled) {
      setError('');
      setArtifactHits([]);
      setPhotoUri(result.assets[0].uri);
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
              Set from GPS — wing-level only. For an exact room, override below.
            </Text>
          </>
        )}
        {gps.phase === 'unavailable' && (
          <Text style={type.meta}>GPS unavailable indoors — set your location below.</Text>
        )}
      </View>

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

        {photoUri ? (
          <>
            <View style={styles.photoHeader}>
              <Image source={{ uri: photoUri }} style={styles.photoThumb} resizeMode="cover" />
              <Text style={[type.meta, styles.flex1]}>
                Best matches (stub data — not a real match):
              </Text>
            </View>
            {photoCandidates.map((o) => (
              <Pressable
                key={o.objectID}
                style={styles.row}
                onPress={() => {
                  const room = data.getGallery(o.gallery)!;
                  apply(anchorForRoom(room, 'photo'));
                }}
                testID={`locate-photo-candidate-${o.objectID}`}
              >
                <Image source={{ uri: o.img }} style={styles.candidateThumb} resizeMode="cover" />
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {o.title}
                  </Text>
                  <Text style={type.meta} numberOfLines={1}>
                    Gallery {o.gallery}
                  </Text>
                </View>
                <Text style={styles.rowAction}>This one</Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.linkBtn}
              onPress={() => setPhotoUri(undefined)}
              testID="locate-photo-retry"
            >
              <Text style={styles.linkBtnText}>None of these — try another photo</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>

      <Pressable style={styles.photoBtn} onPress={choosePhoto} testID="locate-photo-btn">
        <CameraIcon />
        <Text style={styles.photoBtnText}>Locate by photo</Text>
      </Pressable>
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
  candidateThumb: {
    width: 44,
    height: 44,
    backgroundColor: colors.surface,
  },
  photoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  photoBtnText: {
    ...type.label,
    color: colors.red,
  },
  flex1: {
    flex: 1,
  },
});
