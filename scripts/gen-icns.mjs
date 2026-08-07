/**
 * Generate Hypergate's macOS icon without executing the payload binary.
 *
 * This is deliberately a second copy of the mark's geometry in JavaScript:
 * build-artifacts cross-compiles the Intel payload on an arm64 macOS runner,
 * and that host cannot assume Rosetta is installed to run the x86_64 binary.
 * The simple literal guard below makes changes to icon.rs fail loudly instead
 * of silently letting this packaging-only renderer drift.
 */
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUST = readFileSync(join(ROOT, 'apps/shell/src/icon.rs'), 'utf8');
for (const literal of ['[109.0, 94.0, 252.0]', '[34.0, 211.0, 238.0]', '8.8', '14.2']) {
  if (!RUST.includes(literal)) {
    throw new Error(`ICNS renderer drift guard failed: icon.rs no longer contains ${literal}`);
  }
}

const VIOLET = [109, 94, 252];
const CYAN = [34, 211, 238];
const SIZE = 32;
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const pixel = (x, y, size) => {
  const k = size / SIZE;
  const c = size / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy) / k;
  const feather = 1.2 / Math.max(k, 1);
  const ring = smooth(8.8, 8.8 + feather, r) * (1 - smooth(14.2 - feather, 14.2, r));
  const angle = Math.atan2(dy, dx);
  const band = 0.34 + 0.26 * (0.5 + 0.5 * Math.sin(angle * 3 + 0.28 * Math.sin(angle * 5)));
  const rgb = VIOLET.map((v, i) => v + (CYAN[i] - v) * band);
  const halo = r > 14.2 ? (1 - smooth(14.2, 15.9, r)) * 0.1 : 0;
  const coverage = Math.min(1, ring + halo);
  return [...rgb, coverage];
};

const crcTable = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
const png = (size) => {
  const scan = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    scan[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const i = row + 1 + x * 4;
      scan[i] = Math.round(r);
      scan[i + 1] = Math.round(g);
      scan[i + 2] = Math.round(b);
      scan[i + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scan, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const entries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];
const bodies = entries.map(([, size]) => png(size));
const total = 8 + bodies.reduce((n, b) => n + 8 + b.length, 0);
const out = Buffer.alloc(total);
out.write('icns', 0, 4, 'ascii');
out.writeUInt32BE(total, 4);
let offset = 8;
entries.forEach(([type], i) => {
  const body = bodies[i];
  out.write(type, offset, 4, 'ascii');
  out.writeUInt32BE(body.length + 8, offset + 4);
  body.copy(out, offset + 8);
  offset += body.length + 8;
});

const target = process.argv[2] ?? join(ROOT, 'dist-installers', 'hypergate.icns');
writeFileSync(target, out);
console.log(`Wrote ${target} (${out.length} bytes)`);
