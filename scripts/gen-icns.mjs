// Assemble macOS launcher icon sizes from the committed master. This does not
// run the payload binary (which may be built for a different Mac architecture)
// or need the designer's rasterization tooling.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const master = fileURLToPath(new URL('../apps/shell/assets/hypergate-1024.png', import.meta.url));
const target = resolve(process.argv[2] ?? 'dist-installers/hypergate.icns');
const temp = mkdtempSync(join(tmpdir(), 'hypergate-icon-'));
const iconset = join(temp, 'hypergate.iconset');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
try {
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      run('sips', ['-z', pixels, pixels, master, '--out', join(iconset, name)]);
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  run('iconutil', ['-c', 'icns', iconset, '-o', target]);
  console.log(`Wrote ${target}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
