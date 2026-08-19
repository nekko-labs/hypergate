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
for (const literal of [
  '[109.0, 94.0, 252.0]',
  '[34.0, 211.0, 238.0]',
  '[165.0, 243.0, 252.0]',
  '[124.0, 107.0, 255.0]',
  '8.8',
  '14.2',
  '1.0 + 1.4 * (1.0 - 1.0 / k.max(1.0))',
  'powf(3.2)',
  'crest.powf(1.6) * ring * 0.22',
  '(1.0 - smoothstep(13.6, 14.9, r)) * smoothstep(12.6, 13.6, r) * 0.42',
]) {
  if (!RUST.includes(literal)) {
    throw new Error(`ICNS renderer drift guard failed: icon.rs no longer contains ${literal}`);
  }
}

const VIOLET = [109, 94, 252];
const CYAN = [34, 211, 238];
const ICE = [165, 243, 252];
const HALO = [124, 107, 255];
const SIZE = 32;
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sample = (x, y, size) => {
  const k = size / SIZE;
  const c = size / 2;
  const dx = x - c;
  const dy = y - c;
  const r = Math.hypot(dx, dy) / k;
  const feather = 1 + 1.4 * (1 - 1 / Math.max(k, 1));
  const ring = smooth(8.8, 8.8 + feather, r) * (1 - smooth(14.2 - feather, 14.2, r));
  const angle = Math.atan2(dy, dx);
  const phase = 0.5 + 0.5 * Math.sin(angle * 3 + 0.28 * Math.sin(angle * 5));
  const crest = phase ** 3.2;
  const rgb = crest < 0.68
    ? VIOLET.map((v, i) => v + (CYAN[i] - v) * (crest / 0.68))
    : CYAN.map((v, i) => v + (ICE[i] - v) * ((crest - 0.68) / 0.32) * 0.67);
  const bloom = crest ** 1.6 * ring * 0.22;
  const lit = rgb.map((v, i) => v + (ICE[i] - v) * bloom);
  const halo = (1 - smooth(13.6, 14.9, r)) * smooth(12.6, 13.6, r) * 0.42;
  if (ring <= 0) {
    if (halo <= 0) return [[0, 0, 0], 0];
    return [HALO.map((v) => v * halo), halo];
  }
  const coverage = Math.min(1, ring + halo);
  return [[lit[0] * ring + HALO[0] * halo, lit[1] * ring + HALO[1] * halo, lit[2] * ring + HALO[2] * halo], coverage];
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
const rgba = (size) => {
  const scan = Buffer.alloc((size * 4 + 1) * size);
  const samples = 3;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    scan[row] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      let alpha = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const [rgb, a] = sample(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples, size);
          acc[0] += rgb[0];
          acc[1] += rgb[1];
          acc[2] += rgb[2];
          alpha += a;
        }
      }
      const n = samples * samples;
      const a = alpha / n;
      const i = row + 1 + x * 4;
      if (a <= 0.001) continue;
      scan[i] = Math.max(0, Math.min(255, Math.round(acc[0] / n / a)));
      scan[i + 1] = Math.max(0, Math.min(255, Math.round(acc[1] / n / a)));
      scan[i + 2] = Math.max(0, Math.min(255, Math.round(acc[2] / n / a)));
      scan[i + 3] = Math.round(a * 255);
    }
  }
  return scan;
};
const png = (size) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rgba(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

if (process.argv[2] === '--raw') {
  const size = Number(process.argv[3]);
  const target = process.argv[4];
  if (!Number.isInteger(size) || !target) throw new Error('usage: gen-icns.mjs --raw <size> <output>');
  writeFileSync(target, rgba(size));
  process.exit(0);
}

const entries = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
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
