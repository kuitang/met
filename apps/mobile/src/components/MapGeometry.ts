/**
 * MapGeometry — real gallery-polygon geometry for FloorMap.
 *
 * Provider contract (S2 ⇄ S1): the real DataProvider additionally implements
 *
 *   galleriesGeometry(site: Site, floor: string): GalleryFeature[]
 *
 * where `floor` uses the galleries-table label vocabulary
 * ('G' | '1' | '1M' | '2' | '3' | '4' | '5') and the returned features are the
 * rows of blobs['galleries.geojson'] (gunzipped) filtered to that site+floor —
 * every category (gallery, exhibition, corridor, toilet, floor outline, …),
 * geometry in WGS84 lon/lat. FloorMap feature-detects this method; when absent
 * it falls back to the stub schematic, or (web test seam) to a FeatureCollection
 * injected at globalThis.__MET_GEOMETRY__ by e2e/checks/realmap.spec.ts.
 *
 * Projection: equirectangular around the site bbox center — at building scale
 * (~450 m) the distortion is sub-decimeter, so local XY is treated as meters.
 */
import type { DataProvider } from '@/data/provider';

export type Site = 'fifthAve' | 'cloisters';

export interface GalleryFeatureProperties {
  geomId: number;
  galleryNumber: string | null;
  name: string | null;
  title: string | null;
  /** 'gallery' | 'exhibition' | 'corridor' | 'floor' | 'toilet' | 'vista' | … */
  type: string;
  /** Numeric floor: 0 (=G), 1, 1.5 (=1M), 2, 3, 4, 5. */
  floor: number;
  floorName: string;
  site: Site;
  closed: boolean;
}

export interface GalleryFeature {
  type: 'Feature';
  properties: GalleryFeatureProperties;
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };
}

export interface GeometryProvider {
  galleriesGeometry(site: Site, floor: string): GalleryFeature[];
}

export type GeometryFn = (site: Site, floor: string) => GalleryFeature[];

/** Every floor label the dataset can carry, in display (bottom-up) order. */
export const FLOOR_ORDER = ['G', '1', '1M', '2', '3', '4', '5'] as const;

export function floorLabel(floor: number | string): string {
  if (typeof floor === 'string') return floor;
  if (floor === 0) return 'G';
  if (floor === 1.5) return '1M';
  return String(floor);
}

export function floorNumber(label: string): number {
  if (label === 'G') return 0;
  if (label === '1M') return 1.5;
  return Number(label);
}

/**
 * Resolve the geometry source for a provider: the real provider's
 * galleriesGeometry method, else the e2e-injected FeatureCollection,
 * else undefined (→ FloorMap renders the stub schematic).
 */
export function resolveGeometryFn(data: DataProvider): GeometryFn | undefined {
  const candidate = data as unknown as Partial<GeometryProvider>;
  if (typeof candidate.galleriesGeometry === 'function') {
    return candidate.galleriesGeometry.bind(data);
  }
  const injected = (globalThis as { __MET_GEOMETRY__?: { features: GalleryFeature[] } })
    .__MET_GEOMETRY__;
  if (injected?.features) {
    return (site, floor) =>
      injected.features.filter(
        (f) => f.properties.site === site && floorLabel(f.properties.floor) === floor,
      );
  }
  return undefined;
}

export type ShapeKind = 'outline' | 'circulation' | 'amenity' | 'gallery';

export interface MapShape {
  /** galleryNumber for galleries (testID room-{id}), else g{geomId}. */
  id: string;
  /** SVG path data in local meters. */
  d: string;
  kind: ShapeKind;
  /** Gallery-number label text (galleries only). */
  label?: string;
  /** Human name for the room sheet. */
  name: string;
  labelX: number;
  labelY: number;
  areaM2: number;
  floor: string;
  floorNumeric: number;
  closed: boolean;
  /** Projected bbox [x, y, w, h] — doubles as the stub-schema Room.rect. */
  bbox: [number, number, number, number];
}

export interface SiteGeometry {
  site: Site;
  /** Floor labels that contain at least one gallery, FLOOR_ORDER order. */
  floors: string[];
  /** viewBox covering every floor, so switching floors never reflows. */
  viewBox: { x: number; y: number; w: number; h: number };
  shapesByFloor: Map<string, MapShape[]>;
}

const AMENITY_TYPES = new Set([
  'toilet',
  'restaurant',
  'cafe',
  'bar',
  'shop',
  'cloakroom',
  'tickets',
  'auditorium',
  'library',
  'classroom',
  'changing_room',
]);

function shapeKind(type: string): ShapeKind {
  if (type === 'gallery' || type === 'exhibition') return 'gallery';
  if (type === 'floor') return 'outline';
  if (AMENITY_TYPES.has(type)) return 'amenity';
  return 'circulation'; // corridor, vista, back_of_house, …
}

const DRAW_ORDER: Record<ShapeKind, number> = {
  outline: 0,
  circulation: 1,
  amenity: 2,
  gallery: 3,
};

function rings(geometry: GalleryFeature['geometry']): number[][][] {
  return geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

/** Floor labels (FLOOR_ORDER order) whose features include ≥1 gallery. */
export function availableFloors(geometry: GeometryFn, site: Site): string[] {
  return FLOOR_ORDER.filter((label) =>
    geometry(site, label).some((f) => shapeKind(f.properties.type) === 'gallery'),
  );
}

/**
 * Project a site's features (all floors) into local meters and build the
 * per-floor SVG render model. Pure + deterministic → memoize per (data, site).
 */
export function buildSiteGeometry(geometry: GeometryFn, site: Site): SiteGeometry {
  const byFloor = new Map<string, GalleryFeature[]>();
  for (const label of FLOOR_ORDER) {
    const features = geometry(site, label);
    if (features.length) byFloor.set(label, features);
  }

  // Pass 1 — site bbox in lon/lat for the projection origin.
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const features of byFloor.values()) {
    for (const f of features) {
      for (const ring of rings(f.geometry)) {
        for (const [lon, lat] of ring) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }
    }
  }
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  // Meters per degree (equirectangular, building scale).
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  const px = (lon: number) => (lon - lon0) * kx;
  const py = (lat: number) => (lat0 - lat) * ky; // flip: SVG y grows downward

  // Pass 2 — shapes.
  const shapesByFloor = new Map<string, MapShape[]>();
  const floors: string[] = [];
  for (const [label, features] of byFloor) {
    const shapes: MapShape[] = [];
    for (const f of features) {
      const p = f.properties;
      const kind = shapeKind(p.type);
      let d = '';
      let area = 0;
      let cx = 0;
      let cy = 0;
      let bMinX = Infinity;
      let bMinY = Infinity;
      let bMaxX = -Infinity;
      let bMaxY = -Infinity;
      const featureRings = rings(f.geometry);
      featureRings.forEach((ring, ringIdx) => {
        const pts = ring.map(([lon, lat]) => [px(lon), py(lat)] as const);
        d += pts
          .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
          .join('');
        d += 'Z';
        if (ringIdx === 0) {
          // Shoelace area + centroid of the outer ring (label anchor).
          let a2 = 0;
          let sx = 0;
          let sy = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const cross = pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
            a2 += cross;
            sx += (pts[i][0] + pts[i + 1][0]) * cross;
            sy += (pts[i][1] + pts[i + 1][1]) * cross;
          }
          area = Math.abs(a2 / 2);
          if (a2 !== 0) {
            cx = sx / (3 * a2);
            cy = sy / (3 * a2);
          } else {
            cx = pts[0][0];
            cy = pts[0][1];
          }
        }
        for (const [x, y] of pts) {
          if (x < bMinX) bMinX = x;
          if (y < bMinY) bMinY = y;
          if (x > bMaxX) bMaxX = x;
          if (y > bMaxY) bMaxY = y;
        }
      });
      shapes.push({
        id: kind === 'gallery' && p.galleryNumber ? p.galleryNumber : `g${p.geomId}`,
        d,
        kind,
        label: kind === 'gallery' ? (p.galleryNumber ?? p.name ?? undefined) : undefined,
        name:
          p.title ??
          (p.galleryNumber ? `Gallery ${p.galleryNumber}` : (p.name ?? p.type)),
        labelX: cx,
        labelY: cy,
        areaM2: area,
        floor: label,
        floorNumeric: p.floor,
        closed: p.closed,
        bbox: [bMinX, bMinY, bMaxX - bMinX, bMaxY - bMinY],
      });
    }
    shapes.sort((a, b) => DRAW_ORDER[a.kind] - DRAW_ORDER[b.kind]);
    shapesByFloor.set(label, shapes);
    if (shapes.some((s) => s.kind === 'gallery')) floors.push(label);
  }

  // viewBox across every floor, padded.
  let vMinX = Infinity;
  let vMinY = Infinity;
  let vMaxX = -Infinity;
  let vMaxY = -Infinity;
  for (const shapes of shapesByFloor.values()) {
    for (const s of shapes) {
      const [x, y, w, h] = s.bbox;
      if (x < vMinX) vMinX = x;
      if (y < vMinY) vMinY = y;
      if (x + w > vMaxX) vMaxX = x + w;
      if (y + h > vMaxY) vMaxY = y + h;
    }
  }
  const PAD = 10;
  return {
    site,
    floors,
    viewBox: {
      x: vMinX - PAD,
      y: vMinY - PAD,
      w: vMaxX - vMinX + 2 * PAD,
      h: vMaxY - vMinY + 2 * PAD,
    },
    shapesByFloor,
  };
}
