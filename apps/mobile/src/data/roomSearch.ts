/**
 * Amenity matching + nearest-first ranking for the search surfaces (omnibar
 * and All Results share it — same rows, same order). Gallery matching lives
 * in shared/search.ts matchGalleries (exposed as provider.searchGalleries).
 */
import { DataProvider, Room } from '@/data/provider';

/** "bathroom" and friends should still find restrooms. */
const AMENITY_SYNONYMS: Record<string, string> = {
  bathroom: 'restroom',
  bathrooms: 'restroom',
  toilet: 'restroom',
  toilets: 'restroom',
  wc: 'restroom',
  lift: 'elevator',
  lifts: 'elevator',
  staircase: 'stairs',
  stairway: 'stairs',
};

export function matchAmenities(amenities: Room[], query: string): Room[] {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const canon = AMENITY_SYNONYMS[q] ?? q;
  return amenities.filter(
    (r) => r.kind.includes(canon) || r.name.toLowerCase().includes(canon),
  );
}

/**
 * Nearest-first amenity ranking: walking (graph) distance from the visitor's
 * anchor — or the Great Hall before any fix exists. Unreachable rooms (other
 * site, no graph) sink to the end. ~0.6 ms per route on the full graph,
 * computed once per (anchor, amenity-set).
 */
export function rankAmenities(
  data: DataProvider,
  matched: Room[],
  originId: string,
): { room: Room; distance?: number }[] {
  return matched
    .map((room) => ({ room, distance: data.route(originId, room.id)?.distance }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}
