// Generates assets/share/musewalk-share.svg (1200x630) — canonical MuseWalk
// og:image source. Run from anywhere: `node assets/share/gen-musewalk.js`.
//
// Composition: real Fifth Ave floor-1 gallery polygons (extracted below from
// data/snapshots/galleries.geojson, auto-rotated ~29deg to the Manhattan grid)
// behind the wordmark, plus a turn-by-turn route motif snapped to actual
// gallery geometry (waypoints verified against the room bboxes in
// rooms-screen.json — screen-space gallery centers/bboxes for floor 1).
//
// Branding text lives in <g id="text-layer"> so it can be regenerated after a
// rename/copy change by editing only the strings there. Fonts: render box
// lacks Georgia; Liberation Serif/Sans are metric stand-ins for the app's
// Georgia/Helvetica stack (swap to Georgia in production renders).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const GEOJSON = path.join(DIR, '../../data/snapshots/galleries.geojson');

// ---- Floor-plan extraction (Fifth Ave, floor 1) -------------------------
const g = JSON.parse(fs.readFileSync(GEOJSON));
const KEEP = new Set(['gallery','corridor','vista','exhibition','tickets','auditorium','restaurant','cafe','shop','library']);
const feats = g.features.filter(f => f.properties.site === 'fifthAve' && f.properties.floor === 1 && KEEP.has(f.properties.type));
const lat0 = 40.7794;
const base = ([lon, lat]) => [lon * Math.cos(lat0 * Math.PI / 180) * 111320, lat * 110540];

const rawRings = [];
for (const f of feats) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) rawRings.push(poly[0].map(base));
}

function bboxArea(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  let minX=1/0,minY=1/0,maxX=-1/0,maxY=-1/0;
  for (const r of rawRings) for (const [x,y] of r) {
    const rx = x*c - y*s, ry = x*s + y*c;
    if(rx<minX)minX=rx; if(rx>maxX)maxX=rx; if(ry<minY)minY=ry; if(ry>maxY)maxY=ry;
  }
  return {area:(maxX-minX)*(maxY-minY),minX,minY,maxX,maxY};
}
let best={theta:0,area:1/0};
for (let deg=-45; deg<=45; deg+=0.25) {
  const t=deg*Math.PI/180, r=bboxArea(t);
  if (r.area<best.area) best={theta:t,deg,...r};
}

const c=Math.cos(best.theta), s=Math.sin(best.theta);
const planW = best.maxY-best.minY, planH = best.maxX-best.minX;
// long axis horizontal, fit width 1200, flip y so up=north-ish on screen
const SW = 1200, sc = SW / planW;
const PH = +(planH * sc).toFixed(1);
const PLAN_D = rawRings.map(r =>
  'M' + r.map(([x,y]) => {
    const rx = x*c - y*s, ry = x*s + y*c;
    return `${((ry-best.minY)*sc).toFixed(1)},${((rx-best.minX)*sc).toFixed(1)}`;
  }).join('L') + 'Z'
).join('');

// ---- Composition ----------------------------------------------------------
const SERIF = "Georgia, 'Liberation Serif', 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, 'Liberation Sans', Arial, sans-serif";
const RED = '#e4002b';
const INK = '#111111';
const W = 1200, H = 630;
const ty = -(PH - H) / 2; // vertical centering of the taller-than-canvas plan (~-58)

// Route snapped to real floor-1 rooms (screen coords incl. ty shift, verified
// against room bboxes in rooms-screen.json):
//   Great Hall (entrance)  ->  east through Gallery 100  ->  north into 138
//   ->  east along the Egyptian run 137/135/134/133/128  ->  north via the
//   129/130 corridor  ->  east across the South Walkway into Gallery 131
//   (The Temple of Dendur).
const ROUTE = '598,588 598,565 749,565 749,537 1013,537 1013,470 1095,470';
const START = [598, 588];   // start ring: Great Hall
const DEST = [1095, 470];   // destination pin: Gallery 131

// Classic map pin, drawn in a 48x66 box with tip at (24,66)
function pin(x, y, scale, fill, hole) {
  return `<g transform="translate(${x},${y}) scale(${scale}) translate(-24,-66)">
  <path d="M24 0C10.7 0 0 10.7 0 24c0 18 24 42 24 42s24-24 24-42C48 10.7 37.3 0 24 0z" fill="${fill}"/>
  <circle cx="24" cy="23" r="9" fill="${hole}"/>
</g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>

<!-- Real Fifth Ave floor-1 gallery polygons (galleries.geojson, rotated 29deg to the Manhattan grid) -->
<g transform="translate(0,${ty.toFixed(0)})"><path d="${PLAN_D}" fill="#f6f5f3" stroke="#c2beb8" stroke-width="1.5"/></g>
<rect width="${W}" height="${H}" fill="#ffffff" opacity="0.45"/>

<!-- Navigation route: white casing under red line so it pops over plan strokes -->
<polyline points="${ROUTE}" fill="none" stroke="#ffffff" stroke-width="13" stroke-linejoin="round" stroke-linecap="round"/>
<polyline points="${ROUTE}" fill="none" stroke="${RED}" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${START[0]}" cy="${START[1]}" r="12" fill="#ffffff" stroke="${RED}" stroke-width="6.5"/>
${pin(DEST[0], DEST[1], 1.45, RED, '#ffffff')}

<!-- Branding (regenerable text block). Wordmark matches the app header
     (apps/mobile/src/app/index.tsx styles.wordmark / wordmarkAccent): serif
     bold uppercase, default tracking, MUSE in ink + WALK in Met red. -->
<g id="text-layer">
  <text x="600" y="288" text-anchor="middle" font-family="${SERIF}" font-size="128" font-weight="bold" fill="${INK}">MUSE<tspan fill="${RED}">WALK</tspan></text>
  <text x="600" y="352" text-anchor="middle" font-family="${SANS}" font-size="32" fill="#494643" letter-spacing="0.5">Find any artwork. Never get lost.</text>
  <text x="600" y="403" text-anchor="middle" font-family="${SANS}" font-size="21" fill="#6b6660" letter-spacing="0.4">An unofficial companion for The Met</text>
</g>
</svg>`;

fs.writeFileSync(path.join(DIR, 'musewalk-share.svg'), svg);
console.log('wrote', path.join(DIR, 'musewalk-share.svg'));
