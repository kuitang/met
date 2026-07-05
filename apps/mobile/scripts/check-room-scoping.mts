/**
 * Room-id collision regression check (run: npx tsx scripts/check-room-scoping.mts
 * from apps/mobile). Boots the REAL SqliteDataProvider over data/met.sqlite via
 * a better-sqlite3 MetDb shim and asserts museum isolation on colliding codes.
 */
import Database from 'better-sqlite3';
import { SqliteDataProvider } from '../src/data/SqliteDataProvider';
import { objectMuseumId } from '../src/data/provider';

const raw = new Database(new URL('../../../data/met.sqlite', import.meta.url).pathname, {
  readonly: true,
});
const met = {
  dataVersion: 'check',
  allSync: <T>(sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params) as T[],
  allAsync: async <T>(sql: string, params: unknown[] = []) =>
    raw.prepare(sql).all(...params) as T[],
  persist: async () => {},
};

const fail = (msg: string): never => {
  console.error('FAIL:', msg);
  process.exit(1);
};

const p = await SqliteDataProvider.create(met as never);

// 1. Colliding code "241": bare id is the Met room; scoped id is AIC's.
const met241 = p.objectsInGallery('241');
if (!met241.length || !met241.every((o) => objectMuseumId(o) === 'met'))
  fail(`objectsInGallery('241') leaked non-met rows: ${[...new Set(met241.map(objectMuseumId))]}`);
const aic241 = p.objectsInGallery('aic:241');
if (!aic241.length || !aic241.every((o) => objectMuseumId(o) === 'aic'))
  fail(`objectsInGallery('aic:241') wrong museums: ${[...new Set(aic241.map(objectMuseumId))]}`);
console.log(`objectsInGallery: met 241 → ${met241.length} met rows; aic:241 → ${aic241.length} aic rows ✓`);

// 2. Rooms map holds BOTH rooms distinctly.
const metRoom = p.getGallery('241');
const aicRoom = p.getGallery('aic:241');
if (!metRoom || metRoom.site !== 'fifthAve') fail(`getGallery('241') site=${metRoom?.site}`);
if (!aicRoom || aicRoom.site !== 'aic') fail(`getGallery('aic:241') site=${aicRoom?.site}`);
console.log(`getGallery: '241' → ${metRoom.name} (fifthAve); 'aic:241' → ${aicRoom.name} (aic) ✓`);

// 3. Browse loop stays inside the museum (J15): walk AIC 241's full ring.
const start = aic241[0];
if (start.gallery !== 'aic:241') fail(`MetObject.gallery = ${start.gallery}, want aic:241`);
const total = p.galleryObjectCount('aic:241');
let cur = start.objectID;
for (let i = 0; i < Math.min(total + 1, 30); i++) {
  const o = p.getObject(cur)!;
  if (objectMuseumId(o) !== 'aic') fail(`neighbor walk crossed museums at ${cur}`);
  const n = p.galleryNeighbors(cur);
  if (!n) fail(`no neighbors for ${cur}`);
  cur = n!.nextObjectID;
}
const pos = p.objectGalleryPosition(start.objectID);
if (!pos || pos.total !== total) fail(`position.total=${pos?.total} != count=${total}`);
console.log(`gallery browse ring: ${total} aic objects, no museum crossing, position/total consistent ✓`);

// 4. Met routing still works with scoped byGallery keys (131 → 822).
const route = p.route('131', '822');
if (!route || route.steps.length < 5) fail(`met route 131→822 broken (${route?.steps.length} steps)`);
console.log(`met route 131→822: ${route.steps.length} steps, ${Math.round(route.distance)} m ✓`);

// 5. searchGalleries digit query returns both museums' rooms, distinctly.
const hits = p.searchGalleries('241', 6);
const sites = new Set(hits.map((r) => r.site));
if (!sites.has('fifthAve') || !sites.has('aic')) fail(`searchGalleries('241') sites=${[...sites]}`);
console.log(`searchGalleries('241') → ${hits.map((r) => r.id).join(', ')} ✓`);

console.log('\nALL ROOM-SCOPING CHECKS PASS');
