// Renders the MuseWalk share/icon SVGs to the PNGs served from
// apps/mobile/public/. Run from anywhere: `node assets/share/render-musewalk.js`
// (Chromium via the repo's @playwright/test; `npx playwright install chromium`
// if browsers are missing).
//
// Pipeline (crisp flat-color output):
//   1. Rasterize each SVG at deviceScaleFactor 2 (2x supersample)
//   2. Downscale 2x via canvas with imageSmoothingQuality 'high'
//
// Outputs:
//   apps/mobile/public/share.png            1200x630  og:image
//   apps/mobile/public/apple-touch-icon.png  180x180
//   apps/mobile/public/icon-192.png          192x192  (site.webmanifest)
//   apps/mobile/public/icon-512.png          512x512  (site.webmanifest)
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PUBLIC = path.join(DIR, '../../apps/mobile/public');

async function rasterize(b, svgPath, w, h) {
  // 2x supersample of the SVG (viewport = intrinsic size), then downscale.
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await p.goto(`file://${svgPath}`);
  const big = await p.screenshot();
  await p.close();
  return big;
}

async function downscale(b, srcPngBuf, outPng, w, h) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const data = srcPngBuf.toString('base64');
  const url = await p.evaluate(async ({ data, w, h }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/png');
  }, { data, w, h });
  fs.writeFileSync(outPng, Buffer.from(url.split(',')[1], 'base64'));
  await p.close();
}

(async () => {
  const b = await chromium.launch();

  // Share image: 1200x630 intrinsic -> 2400x1260 supersample -> 1200x630
  const share2x = await rasterize(b, path.join(DIR, 'musewalk-share.svg'), 1200, 630);
  await downscale(b, share2x, path.join(PUBLIC, 'share.png'), 1200, 630);

  // Icon: 512x512 intrinsic -> 1024 supersample -> 512 / 192 / 180
  const icon2x = await rasterize(b, path.join(DIR, 'musewalk-icon.svg'), 512, 512);
  await downscale(b, icon2x, path.join(PUBLIC, 'icon-512.png'), 512, 512);
  await downscale(b, icon2x, path.join(PUBLIC, 'icon-192.png'), 192, 192);
  await downscale(b, icon2x, path.join(PUBLIC, 'apple-touch-icon.png'), 180, 180);

  await b.close();
  for (const f of ['share.png', 'icon-512.png', 'icon-192.png', 'apple-touch-icon.png'])
    console.log(f, fs.statSync(path.join(PUBLIC, f)).size, 'bytes');
})();
