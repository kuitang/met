import * as ExpoLinking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import ObjectImage from '@/components/ObjectImage';
import { applyVenue, getAnchor, getVenue, useVenue } from '@/components/LocateState';
import { museumForSite, objectSourceUrl, useData } from '@/data/provider';
import { colors, spacing, type } from '@/theme';

export default function ObjectScreen() {
  const data = useData();
  // `anchor` (optional) = the visitor's last confirmed room, threaded through
  // so "Navigate here" starts from where they actually are.
  const { id, anchor } = useLocalSearchParams<{ id: string; anchor?: string }>();
  const [copied, setCopied] = useState(false); // share-button feedback
  const object = data.getObject(Number(id));

  // Cross-venue browse: opening an object at the other venue switches the
  // app venue (map, chip) with the dismissible toast — same coupling as the
  // GPS auto-switch (shared/positioning venue rules; cause 'browse'). This
  // auto-switch only applies WITHIN a museum (Fifth Ave ⇄ Cloisters, existing
  // behavior, unchanged); crossing to a DIFFERENT museum (C2) instead shows a
  // "VIEW AT {museum}" action the visitor taps explicitly — see crossMuseum.
  const gallerySite = object?.gallery ? data.getGallery(object.gallery)?.site : undefined;
  const venueState = useVenue();
  const museums = data.museums();
  const objectMuseum = museumForSite(museums, object?.site ?? gallerySite);
  const activeMuseum = museumForSite(museums, venueState.venue);
  const crossMuseum = !!(objectMuseum && activeMuseum && objectMuseum.id !== activeMuseum.id);
  useEffect(() => {
    if (gallerySite && gallerySite !== getVenue().venue && !crossMuseum) {
      applyVenue(gallerySite, 'browse');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gallerySite, crossMuseum]);

  if (!object) {
    return (
      <View style={styles.container}>
        <Text style={[type.body, styles.notFound]}>
          Object {id} not found in stub data.
        </Text>
      </View>
    );
  }

  const gallery = object.gallery ? data.getGallery(object.gallery) : undefined;

  // Cross-museum "VIEW AT {shortName}" (C2): switches the active venue to the
  // object's site, then routes home focused on its room — reusing the same
  // `/?focus=` grammar RoomRow's focusRoom uses for room-row taps.
  const viewAtOtherMuseum = () => {
    const site = object.site ?? gallery?.site;
    if (site) applyVenue(site, 'browse');
    router.dismissTo({
      pathname: '/',
      params: object.gallery
        ? { focus: object.gallery, ts: String(Date.now()) }
        : { ts: String(Date.now()) },
    });
  };

  // J15: next/previous within the same room — browse a gallery's objects
  // sequentially without re-searching. Position + neighbors are computed in
  // SQL over the FULL gallery ordering (galleries hold up to ~4.5k objects;
  // the capped objectsInGallery list must never define this counter). When
  // the position is unknowable the counter is hidden — never a wrong number.
  const galleryPos = object.gallery ? data.objectGalleryPosition(object.objectID) : undefined;
  const neighbors = object.gallery ? data.galleryNeighbors(object.objectID) : undefined;
  const cycleTo = (nextID: number) =>
    router.replace({
      pathname: '/object/[id]',
      params: anchor ? { id: String(nextID), anchor } : { id: String(nextID) },
    });

  // Outbound link to the object's page on its own museum's site (schema-v2
  // objectUrlTemplate + sourceId; Met fallback covers stub/pre-v2 artifacts).
  const objectURL =
    objectSourceUrl(object, museums) ??
    `https://www.metmuseum.org/art/collection/search/${object.objectID}`;
  const objectURLHost = new URL(objectURL).hostname.replace(/^www\./, '');

  // Share = copy the canonical deep link (web clipboard; native share sheet).
  // Always derived from the RUNTIME origin — window.location.origin on web,
  // Linking.createURL on native — never a baked-in constant, so the same
  // build shares correct links from any origin (custom domain, fly.dev,
  // PR preview apps).
  const canonicalURL =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? `${window.location.origin}/object/${object.objectID}`
      : ExpoLinking.createURL(`/object/${object.objectID}`);
  const onShare = async () => {
    if (Platform.OS === 'web' && navigator.clipboard) {
      await navigator.clipboard.writeText(canonicalURL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      await Share.share({ message: canonicalURL });
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {object.img ? <ObjectImage object={object} /> : null}

      {galleryPos && neighbors && galleryPos.total > 1 && (
        <View style={styles.cycleRow}>
          <Pressable
            style={styles.cycleBtn}
            onPress={() => cycleTo(neighbors.prevObjectID)}
            testID="object-prev"
          >
            <Text style={styles.cycleArrow}>‹</Text>
          </Pressable>
          <Text style={styles.cycleLabel} testID="object-position">
            {galleryPos.position.toLocaleString('en-US')} of{' '}
            {galleryPos.total.toLocaleString('en-US')} in Gallery {object.gallery}
          </Text>
          <Pressable
            style={styles.cycleBtn}
            onPress={() => cycleTo(neighbors.nextObjectID)}
            testID="object-next"
          >
            <Text style={styles.cycleArrow}>›</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.title} testID="object-title">
        {object.title}
      </Text>
      <Text style={type.meta}>
        {object.artist || object.dept}
        {object.date ? ` · ${object.date}` : ''}
      </Text>
      <Text style={type.meta}>{object.medium}</Text>
      <Text style={[type.meta, styles.credit]}>
        {object.credit} ({object.accession})
      </Text>

      <View style={styles.galleryRow}>
        <Text style={styles.galleryChip} testID="object-gallery-chip">
          {object.gallery ? `GALLERY ${object.gallery}` : 'NOT ON VIEW'}
        </Text>
        {crossMuseum && objectMuseum ? (
          <Text style={type.meta} testID="object-cross-museum-location">
            {objectMuseum.name} ·{' '}
            {gallery ? gallery.name : object.gallery ? `Gallery ${object.gallery}` : 'Not on view'}
          </Text>
        ) : (
          <>
            {gallery && (
              <Text style={type.meta}>
                On view · {gallery.name} · Floor {gallery.floor}
              </Text>
            )}
            {object.gallery && !gallery && (
              <Text style={type.meta}>On view (gallery not in stub map)</Text>
            )}
          </>
        )}
      </View>

      {crossMuseum && objectMuseum ? (
        <Pressable style={styles.navigateBtn} onPress={viewAtOtherMuseum} testID="view-at-museum">
          <Text style={styles.navigateBtnText}>
            VIEW AT {objectMuseum.shortName.toUpperCase()}
          </Text>
        </Pressable>
      ) : (
        // Directions only when this museum's site actually has a routing
        // graph (AIC today is room-labels-only, hasGraph: false) — unchanged
        // for the Met, where hasGraph has always been true.
        gallery &&
        objectMuseum?.capabilities.hasGraph && (
          <Pressable
            style={styles.navigateBtn}
            onPress={() =>
              // Home in nav mode (variant D), PUSHED so back = exit nav. The
              // `obj` param makes the artwork the destination identity in the
              // nav sheet header. Origin precedence: explicit ?anchor= deep-link
              // param, then the visitor's live anchor, then the Great Hall
              // fallback — routes start from where the visitor actually is.
              router.push({
                pathname: '/',
                params: {
                  nav: `${anchor ?? getAnchor()?.roomId ?? 'great-hall'}:${gallery.id}`,
                  obj: String(object.objectID),
                },
              })
            }
            testID="navigate-here"
          >
            <Text style={styles.navigateBtnText}>Navigate here</Text>
          </Pressable>
        )
      )}

      <Pressable style={styles.linkOut} onPress={onShare} testID="object-share">
        <Text style={styles.linkOutText}>{copied ? 'Link copied ✓' : 'Share'}</Text>
      </Pressable>

      <Pressable
        style={styles.linkOut}
        onPress={() => Linking.openURL(objectURL)}
        testID="object-met-link"
      >
        <Text style={styles.linkOutText}>View on {objectURLHost} ↗</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  notFound: {
    padding: spacing.lg,
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  cycleBtn: {
    width: 44, // HIG tap target
    height: 44,
    borderWidth: 1,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cycleArrow: {
    ...type.title,
    fontSize: 24,
    lineHeight: 28,
  },
  cycleLabel: {
    ...type.label,
    color: colors.inkSecondary,
  },
  title: {
    ...type.display,
    fontSize: 26,
    lineHeight: 32,
  },
  credit: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
  },
  galleryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  galleryChip: {
    ...type.label,
    color: colors.red,
  },
  navigateBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.red,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  navigateBtnText: {
    ...type.label,
    color: colors.white,
  },
  linkOut: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 44, // HIG tap target
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  linkOutText: {
    ...type.label,
  },
});
