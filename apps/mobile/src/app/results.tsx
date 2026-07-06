import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { components } from '@met/shared';

import { useAnchor, useVenue } from '@/components/LocateState';
import MuseumBadge from '@/components/MuseumBadge';
import { ObjectThumb } from '@/components/ObjectImage';
import RoomRow from '@/components/RoomRow';
import ScopeChips, { type MuseumScope } from '@/components/ScopeChips';
import SearchFilterChips, {
  ResultFilters,
  applyFilters,
} from '@/components/SearchFilterChips';
import { apiBase } from '@/data/apiBase';
import {
  DataProvider,
  MetObject,
  museumForSite,
  museumSiteIds,
  parseRoomId,
  partitionByMuseum,
  useData,
} from '@/data/provider';
import { matchAmenities, rankAmenities } from '@/data/roomSearch';
import { colors, spacing, type } from '@/theme';

type InterpretResponse = components['schemas']['InterpretResponse'];

/** One flat FlatList item: either an object row or a section header (C2
 *  sectioned multi-museum results — see the module doc in ScopeChips.tsx). */
type ListItem =
  | { kind: 'object'; key: string; object: MetObject; other: boolean }
  | { kind: 'header'; key: string; label: string };

/**
 * Server-side LLM interpret flow (POST /api/v1/search/interpret): the server
 * rewrites the natural-language query (escalating to a bounded agentic loop),
 * executes it against its met.sqlite, and returns final ranked results in one
 * round trip. Offline / server-down degrades to plain local search with a
 * notice — the local index keeps working.
 */
type InterpretState =
  | { phase: 'loading' }
  | { phase: 'done'; body: InterpretResponse }
  | { phase: 'offline' };

/** Ranked server results → full local objects (hit the local DB for images). */
function hydrateResults(data: DataProvider, body: InterpretResponse): MetObject[] {
  return body.results.map(
    (r) =>
      data.getObject(r.objectID) ?? {
        objectID: r.objectID,
        title: r.title,
        artist: r.artist,
        date: '',
        medium: '',
        accession: '',
        gallery: r.galleryNumber,
        dept: '',
        credit: '',
        isHighlight: false,
        img: '',
      },
  );
}

/** All Results — a full-text search (?q=), a gallery's objects (?gallery=),
 * or the LLM-interpreted fallback (?q=&interpreted=1, stubbed). */
export default function ResultsScreen() {
  const data = useData();
  const { q, gallery, interpreted } = useLocalSearchParams<{
    q?: string;
    gallery?: string;
    interpreted?: string;
  }>();
  const [filters, setFilters] = useState<ResultFilters>({});
  const [scope, setScope] = useState<MuseumScope>('all');

  // Multi-museum sectioning (C2) — see the identical block in search.tsx.
  const venue = useVenue();
  const museums = data.museums();
  const isMultiMuseum = museums.length > 1;
  const activeMuseum = museumForSite(museums, venue.venue) ?? museums[0];
  const activeSiteIds = useMemo(() => museumSiteIds(activeMuseum), [activeMuseum]);
  // Gallery browsing (?gallery=) is inherently single-site; scoping only
  // applies to text queries.
  const scopedMuseum = isMultiMuseum && scope === 'here' && !gallery ? activeMuseum.id : undefined;
  // Ranking-only boost for the visitor's museum (see search.tsx).
  const boostMuseum = isMultiMuseum ? activeMuseum.id : undefined;
  const showSections = isMultiMuseum && scope === 'all' && !gallery;

  const isInterpreted = interpreted === '1' && !!q;
  const [interp, setInterp] = useState<InterpretState>({ phase: 'loading' });
  useEffect(() => {
    if (!isInterpreted) return;
    let cancelled = false;
    setInterp({ phase: 'loading' });
    (async () => {
      const res = await fetch(`${apiBase()}/api/v1/search/interpret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: q,
          maxResults: 20,
          ...(scopedMuseum ? { museum: scopedMuseum } : null),
        }),
      });
      if (!res.ok) throw new Error(`interpret ${res.status}`);
      const body = (await res.json()) as InterpretResponse;
      if (!cancelled) setInterp({ phase: 'done', body });
    })().catch(() => {
      if (!cancelled) setInterp({ phase: 'offline' });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInterpreted, q, scopedMuseum]);

  // Gallery + amenity rows for text searches — same anatomy and one-tap
  // grammar as the search omnibar (rows open the home-map sheet; no inline
  // actions). Skipped for ?gallery= listings (already a single room's view).
  // Always scoped to the active museum's sites (never surface another
  // museum's gallery/amenity row here).
  const anchor = useAnchor();
  const originId = anchor?.roomId ?? 'great-hall';
  const galleryRowsRaw = !gallery && q ? data.searchGalleries(q, 4) : [];
  const galleryRows = isMultiMuseum
    ? galleryRowsRaw.filter((r) => activeSiteIds.has(r.site ?? 'fifthAve'))
    : galleryRowsRaw;
  const matchedAmenitiesRaw = !gallery && q ? matchAmenities(data.amenities(), q) : [];
  const matchedAmenities = isMultiMuseum
    ? matchedAmenitiesRaw.filter((r) => activeSiteIds.has(r.site ?? 'fifthAve'))
    : matchedAmenitiesRaw;
  const amenityRows = useMemo(
    () => rankAmenities(data, matchedAmenities, originId),
    // matchedAmenities is identity-unstable per render; key on its ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, originId, matchedAmenities.map((r) => r.id).join(',')],
  );

  const base = gallery
    ? data.objectsInGallery(gallery)
    : isInterpreted
      ? interp.phase === 'done'
        ? hydrateResults(data, interp.body)
        : interp.phase === 'offline'
          ? data.searchAll(q ?? '', scopedMuseum ? { museum: scopedMuseum } : undefined, boostMuseum) // graceful degrade: local index still works
          : []
      : data.searchAll(q ?? '', scopedMuseum ? { museum: scopedMuseum } : undefined, boostMuseum);
  const floorOf = (galleryId: string) => data.getGallery(galleryId)?.floor;
  const results = applyFilters(base, filters, floorOf);
  const heading = gallery
    ? (data.getGallery(gallery)?.name ?? `Gallery ${parseRoomId(gallery).galleryNumber}`)
    : `“${q ?? ''}”`;

  const listItems: ListItem[] = (() => {
    const asItem = (o: MetObject, other: boolean): ListItem => ({
      kind: 'object',
      key: String(o.objectID),
      object: o,
      other,
    });
    if (!showSections) return results.map((o) => asItem(o, false));
    const { active, other } = partitionByMuseum(results, activeMuseum.id);
    const items: ListItem[] = [];
    if (active.length > 0) {
      items.push({
        kind: 'header',
        key: 'hdr-active',
        label: `AT ${activeMuseum.shortName.toUpperCase()}`,
      });
      items.push(...active.map((o) => asItem(o, false)));
    }
    if (other.length > 0) {
      items.push({ kind: 'header', key: 'hdr-other', label: 'OTHER MUSEUMS' });
      items.push(...other.map((o) => asItem(o, true)));
    }
    return items;
  })();

  const galleryChip = (o: MetObject) => {
    if (!o.gallery) return 'Not on view';
    const floor = floorOf(o.gallery);
    // o.gallery is site-scoped ("aic:243") to disambiguate the lookup key —
    // the visible chip reads the bare gallery number.
    const num = parseRoomId(o.gallery).galleryNumber;
    return floor !== undefined ? `Gallery ${num} · F${floor}` : `Gallery ${num}`;
  };

  return (
    <View style={styles.container}>
      {isInterpreted && (
        <View style={styles.banner} testID="interpreted-banner">
          <Text style={styles.bannerLabel}>Ask differently</Text>
          {interp.phase === 'loading' && (
            <View style={styles.bannerRow}>
              <ActivityIndicator size="small" color={colors.red} />
              <Text style={type.meta}>Interpreting your words…</Text>
            </View>
          )}
          {interp.phase === 'done' && (
            <>
              <Text style={styles.bannerText} testID="interpreted-query">
                Interpreted: “{interp.body.interpretedQuery.ftsQuery}”
              </Text>
              <Text style={type.meta}>
                {interp.body.method === 'agentic' && interp.body.why
                  ? interp.body.why
                  : 'Your words were rewritten into a catalog query and re-searched.'}
              </Text>
            </>
          )}
          {interp.phase === 'offline' && (
            <Text style={type.meta} testID="interpret-offline">
              You're offline — smart interpretation needs a connection. Showing
              plain matches from the on-device index instead.
            </Text>
          )}
        </View>
      )}
      <Text style={styles.heading}>
        {results.length} result{results.length === 1 ? '' : 's'} · {heading}
      </Text>
      {isMultiMuseum && !gallery && (
        <ScopeChips activeLabel={activeMuseum.shortName} scope={scope} onChange={setScope} />
      )}
      <SearchFilterChips filters={filters} onChange={setFilters} />
      <FlatList
        data={listItems}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={
          galleryRows.length > 0 || amenityRows.length > 0 ? (
            <View>
              {galleryRows.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  meta={
                    room.kind === 'gallery'
                      ? `Gallery ${parseRoomId(room.id).galleryNumber}`
                      : undefined
                  }
                  testID={`gallery-${room.id}`}
                />
              ))}
              {amenityRows.map(({ room, distance }) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  meta={distance !== undefined ? `~${Math.round(distance)} m walk` : 'Amenity'}
                  testID={`amenity-${room.id}`}
                />
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={styles.sectionHeader}>{item.label}</Text>
          ) : (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`/object/${item.object.objectID}`)}
              testID={`result-${item.object.objectID}`}
            >
              {item.object.img ? (
                // Tigris CDN first, proxy fallback — see data/imageCdn.ts.
                <ObjectThumb object={item.object} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty]} />
              )}
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {item.object.title}
                </Text>
                <Text style={type.meta} numberOfLines={1}>
                  {item.object.artist || item.object.dept}
                  {item.object.date ? ` · ${item.object.date}` : ''}
                </Text>
                {item.other ? (
                  <MuseumBadge
                    shortName={museumForSite(museums, item.object.site)?.shortName ?? ''}
                    testID={`museum-badge-${item.object.objectID}`}
                  />
                ) : (
                  <Text style={styles.galleryChip}>{galleryChip(item.object)}</Text>
                )}
              </View>
            </Pressable>
          )
        }
        ListEmptyComponent={<Text style={styles.empty}>No results.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  banner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    gap: 2,
    backgroundColor: colors.surface,
    borderLeftWidth: 2,
    borderLeftColor: colors.red,
  },
  bannerLabel: {
    ...type.label,
    color: colors.red,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bannerText: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  heading: {
    ...type.meta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  thumb: {
    width: 64,
    height: 64,
    backgroundColor: colors.surface,
  },
  thumbEmpty: {
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.body,
    fontFamily: type.title.fontFamily,
  },
  galleryChip: {
    ...type.label,
    color: colors.red,
    marginTop: 2,
  },
  // Multi-museum section headers ("AT THE MET" / "OTHER MUSEUMS") — small
  // caps, secondary color, matching the codebase's all-caps label idiom.
  sectionHeader: {
    ...type.label,
    color: colors.inkSecondary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  empty: {
    ...type.meta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
