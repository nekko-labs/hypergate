// Rasterize docs/splash.svg into the README banner and social preview.
// Uses the Playwright Chromium already installed in the sibling
// nekko-notes repo, so no new dependency here. Run from repo root:
//   node scripts/gen-splash.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/phili/code/nekko-notes/');
const { chromium } = require('playwright');

const svg = readFileSync(fileURLToPath(new URL('../docs/splash.svg', import.meta.url)), 'utf8');
const W = 1280;
const H = 600;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: 'networkidle' });
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
writeFileSync(fileURLToPath(new URL('../docs/splash.png', import.meta.url)), buf);
writeFileSync(fileURLToPath(new URL('../apps/site/public/og.png', import.meta.url)), buf);
await browser.close();
console.log('wrote docs/splash.png and apps/site/public/og.png');
