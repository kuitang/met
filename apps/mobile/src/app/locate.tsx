import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useState } from 'react';
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

import { Anchor, anchorForRoom, setAnchor } from '@/components/LocateState';
import { MetObject, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

type Mode = 'gallery' | 'artifact' | 'photo' | 'gps';

const MODES: { key: Mode; label: string }[] = [
  { key: 'gallery', label: 'Gallery #' },
  { key: 'artifact', label: 'Artifact' },
  { key: 'photo', label: 'Photo' },
  { key: 'gps', label: 'GPS' },
];

/**
 * Locate sheet (modal) — set your position anchor by gallery number,
 * nearby artifact, photo (stub matcher), or GPS (coarse entrance only).
 */
export default function LocateScreen() {
  const [mode, setMode] = useState<Mode>('gallery');

  const apply = (anchor: Anchor) => {
    setAnchor(anchor);
    router.dismissTo('/');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Where are you?</Text>

      <View style={styles.tabs}>
        {MODES.map((m) => {
          const active = m.key === mode;
          return (
            <Pressable
              key={m.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setMode(m.key)}
              testID={`locate-mode-${m.key}`}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {mode === 'gallery' && <GalleryPane apply={apply} />}
      {mode === 'artifact' && <ArtifactPane apply={apply} />}
      {mode === 'photo' && <PhotoPane apply={apply} />}
      {mode === 'gps' && <GpsPane apply={apply} />}
    </View>
  );
}

function GalleryPane({ apply }: { apply: (a: Anchor) => void }) {
  const data = useData();
  const [roomNumber, setRoomNumber] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    const room = data.getGallery(roomNumber.trim());
    if (!room) {
      setError(`Gallery “${roomNumber.trim()}” is not in the stub map.`);
      return;
    }
    apply(anchorForRoom(room, 'gallery'));
  };

  return (
    <View style={styles.pane}>
      <Text style={type.meta}>Enter the gallery number posted at the room entrance.</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={roomNumber}
          onChangeText={(t) => {
            setRoomNumber(t);
            setError('');
          }}
          placeholder="e.g. 131"
          placeholderTextColor={colors.inkFaint}
          keyboardType="number-pad"
          autoFocus
          onSubmitEditing={submit}
          testID="locate-room-input"
        />
        <Pressable style={styles.submitBtn} onPress={submit} testID="locate-submit">
          <Text style={styles.submitBtnText}>Set</Text>
        </Pressable>
      </View>
      {error ? (
        <Text style={styles.error} testID="locate-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function ArtifactPane({ apply }: { apply: (a: Anchor) => void }) {
  const data = useData();
  const [query, setQuery] = useState('');
  const suggestions = data.searchAutocomplete(query, 6);

  const pick = (o: MetObject) => {
    if (!o.gallery) return;
    const room = data.getGallery(o.gallery);
    apply(
      room
        ? anchorForRoom(room, 'artifact')
        : { label: `Gallery ${o.gallery}`, source: 'artifact' },
    );
  };

  return (
    <View style={styles.pane}>
      <Text style={type.meta}>Search for an artwork you can see, then tap it.</Text>
      <TextInput
        style={[styles.input, styles.inputBlock]}
        value={query}
        onChangeText={setQuery}
        placeholder="e.g. Wheat Field with Cypresses"
        placeholderTextColor={colors.inkFaint}
        autoFocus
        autoCorrect={false}
        testID="locate-artifact-input"
      />
      <ScrollView keyboardShouldPersistTaps="handled">
        {suggestions.map((o) => (
          <Pressable
            key={o.objectID}
            style={[styles.row, !o.gallery && styles.rowDisabled]}
            disabled={!o.gallery}
            onPress={() => pick(o)}
            testID={`locate-artifact-${o.objectID}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {o.title}
              </Text>
              <Text style={type.meta} numberOfLines={1}>
                {o.artist || o.dept}
              </Text>
            </View>
            <Text style={styles.rowAction}>
              {o.gallery ? "I'm next to this" : 'Not on view'}
            </Text>
          </Pressable>
        ))}
        {query.trim() && suggestions.length === 0 ? (
          <Text style={[type.meta, styles.padTop]}>No matches in stub data.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function PhotoPane({ apply }: { apply: (a: Anchor) => void }) {
  const data = useData();
  const [photoUri, setPhotoUri] = useState<string | undefined>();
  // Fake "top-3 candidates": deterministic stub stand-in for the Phase 2
  // server-side embedding match — one highlight from each of three different
  // galleries on the stub map.
  const candidates: MetObject[] = [];
  if (photoUri) {
    for (const g of data.galleries()) {
      const hit = data.objectsInGallery(g.id).find((o) => o.isHighlight && o.img);
      if (hit) candidates.push(hit);
      if (candidates.length === 3) break;
    }
  }

  const choosePhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
    });
    if (!result.canceled) setPhotoUri(result.assets[0].uri);
  };

  return (
    <View style={styles.pane}>
      {!photoUri ? (
        <>
          <Text style={type.meta}>
            Photograph the artwork in front of you. The stub build returns sample
            candidates — real photo matching arrives in Phase 2.
          </Text>
          <Pressable style={styles.bigBtn} onPress={choosePhoto} testID="locate-photo-pick">
            <Text style={styles.bigBtnText}>Choose a photo</Text>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.photoHeader}>
            <Image source={{ uri: photoUri }} style={styles.photoThumb} resizeMode="cover" />
            <Text style={[type.meta, styles.flex1]}>
              Best matches (stub data — not a real match):
            </Text>
          </View>
          {candidates.map((o) => (
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
      )}
    </View>
  );
}

function GpsPane({ apply }: { apply: (a: Anchor) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const useLocation = async () => {
    setBusy(true);
    setError('');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setError('Location permission denied — try a gallery number instead.');
        return;
      }
      await Location.getCurrentPositionAsync({});
      // Stub: GPS can only ever place you near an entrance, never in a room.
      apply({
        roomId: 'great-hall',
        label: 'Near Fifth Ave entrance',
        floor: 1,
        source: 'gps',
      });
    } catch {
      setError('Could not read your location — try a gallery number instead.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.pane}>
      <Text style={type.meta}>
        GPS only places you near an entrance — indoors it cannot tell which room
        or floor you are on. The stub anchors you at the Fifth Avenue entrance.
      </Text>
      <Pressable
        style={[styles.bigBtn, busy && styles.bigBtnBusy]}
        onPress={useLocation}
        disabled={busy}
        testID="locate-gps"
      >
        {busy ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.bigBtnText}>Use my location</Text>
        )}
      </Pressable>
      {error ? (
        <Text style={styles.error} testID="locate-gps-error">
          {error}
        </Text>
      ) : null}
    </View>
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
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  tab: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },
  tabActive: {
    borderBottomColor: colors.red,
  },
  tabText: {
    ...type.label,
    color: colors.inkSecondary,
  },
  tabTextActive: {
    color: colors.ink,
  },
  pane: {
    flex: 1,
    gap: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  input: {
    ...type.body,
    flex: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  inputBlock: {
    flex: 0, // standalone (column) inputs must not stretch vertically
    marginTop: spacing.sm,
  },
  submitBtn: {
    backgroundColor: colors.red,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  submitBtnText: {
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
  rowDisabled: {
    opacity: 0.45,
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
  padTop: {
    paddingTop: spacing.md,
  },
  bigBtn: {
    backgroundColor: colors.ink,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  bigBtnBusy: {
    opacity: 0.7,
  },
  bigBtnText: {
    ...type.label,
    color: colors.white,
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
  flex1: {
    flex: 1,
  },
});
