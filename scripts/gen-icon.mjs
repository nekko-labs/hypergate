// Rasterize the gate mark into square PNGs for surfaces that won't take an SVG.
// The OAuth `logo_uri` is the one that matters: consent screens run our logo
// through their own image pipelines, and a raster square is the only format all
// of them render. Same Playwright borrow as gen-splash.mjs. Run from repo root:
//   node scripts/gen-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/phili/code/nekko-notes/');
const { chromium } = require('playwright');

const url = (p) => fileURLToPath(new URL(p, import.meta.url));
const svg = readFileSync(url('../apps/site/public/favicon.svg'), 'utf8');

// 512 for the OAuth consent screen and PWA install, 192 for the smaller PWA slot.
const SIZES = [512, 192];

const browser = await chromium.launch();
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // The mark's rounded tile leaves the corners transparent; keep them that way so
  // a provider drawing it on any background gets the tile, not a black square.
  await page.setContent(
    `<!doctype html><html><body style="margin:0">
     <div style="width:${size}px;height:${size}px">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</div>
     </body></html>`,
    { waitUntil: 'networkidle' },
  );
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(url(`../apps/site/public/icon-${size}.png`), buf);
  await page.close();
  console.log(`wrote apps/site/public/icon-${size}.png`);
}
await browser.close();
