// What `npm run dev` prints once the daemon and the manager are both up:
// the gate, what is running where, and the keys. Pure, so it is tested as text.

/** The gate: an open ring, like the app icon. */
const GATE = [
  '   .-""-.   ',
  '  / .--. \\  ',
  ' | |    | | ',
  ' | |    | | ',
  "  \\ '--' /  ",
  "   '-..-'   ",
];

/** "Hypergate" in figlet's standard font, one glyph per letter, six rows each. */
const GLYPHS = {
  H: [' _   _ ', '| | | |', '| |_| |', '|  _  |', '|_| |_|', '       '],
  y: ['       ', ' _   _ ', '| | | |', '| |_| |', ' \\__, |', ' |___/ '],
  p: ['       ', ' _ __  ', "| '_ \\ ", '| |_) |', '| .__/ ', '|_|    '],
  e: ['      ', '  ___ ', ' / _ \\', '|  __/', ' \\___|', '      '],
  r: ['      ', ' _ __ ', "| '__|", '| |   ', '|_|   ', '      '],
  g: ['       ', '  __ _ ', ' / _` |', '| (_| |', ' \\__, |', ' |___/ '],
  a: ['       ', '  __ _ ', ' / _` |', '| (_| |', ' \\__,_|', '       '],
  t: [' _   ', '| |_ ', '| __|', '| |_ ', ' \\__|', '     '],
};

/** The art's rows, gate and word side by side. */
export const ART = GATE.map((gate, row) => `${gate}  ${[...'Hypergate'].map((ch) => GLYPHS[ch][row]).join('')}`);

// The site's gate gradient: violet into cyan.
const FROM = [124, 107, 255];
const TO = [34, 211, 238];

/** One row in the gradient, left to right, one colour per character. */
const gradient = (line, width) =>
  [...line]
    .map((ch, i) => {
      if (ch === ' ') return ch;
      const t = width > 1 ? i / (width - 1) : 0;
      const [r, g, b] = FROM.map((f, k) => Math.round(f + (TO[k] - f) * t));
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    })
    .join('') + '\x1b[39m';

/**
 * @param {{
 *   version?: string,
 *   manager?: string,
 *   gateway?: string,
 *   dataDir?: string,
 *   scratch?: boolean,
 *   keys?: boolean,
 *   restart?: boolean,
 *   desktop?: boolean,
 *   color?: boolean,
 * }} info
 */
export function devBanner(info) {
  const c = info.color
    ? {
        dim: (s) => `\x1b[2m${s}\x1b[22m`,
        ok: (s) => `\x1b[32m${s}\x1b[39m`,
        key: (s) => `\x1b[1m${s}\x1b[22m`,
        art: (s, w) => gradient(s, w),
      }
    : { dim: (s) => s, ok: (s) => s, key: (s) => s, art: (s) => s };
  const width = Math.max(...ART.map((l) => l.length));
  const row = (label, value) => `  ${c.dim(label.padEnd(9))} ${value}`;
  const lines = [
    '',
    ...ART.map((l) => `  ${c.art(l, width)}`),
    '',
    `  ${c.ok('●')} Hypergate${info.version ? ` ${info.version}` : ''} ${c.dim('dev')} is running`,
    '',
  ];
  if (info.manager) lines.push(row('Manager', `${info.manager} ${c.dim('(hot reload)')}`));
  if (info.desktop) lines.push(row('Desktop', `the manager in the app's own window ${c.dim('(npm run dev:browser for a tab instead)')}`));
  if (info.gateway) lines.push(row('Gateway', `${info.gateway} ${c.dim('(restarts on save)')}`));
  if (info.dataDir) {
    lines.push(
      row('Data', `${info.dataDir} ${c.dim(info.scratch ? '(scratch)' : '(your real data; HYPERGATE_DIR=<dir> for a scratch copy)')}`),
    );
  }
  lines.push('');
  if (info.keys) {
    lines.push(
      `  ${c.key('q')} or ${c.key('Enter')}  stop, with every server it started`,
      `  ${c.key('Ctrl+C')}      same; press again to force`,
      ...(info.restart === false ? [] : [`  ${c.key('r')}           restart with what is on disk ${c.dim('(after a git pull: installs, rebuilds)')}`]),
      `  ${c.key('o')}           open the manager${info.desktop ? ' in your browser' : ''}`,
      '',
    );
  } else {
    lines.push(`  ${c.key('Ctrl+C')} stops it, with every server it started`, '');
  }
  return lines.join('\n');
}

/**
 * A hint for daemon output that means the shared packages' build is behind
 * their source: a fresh pull, or a type error that stopped the watcher's emit.
 * Undefined for anything else.
 */
export function staleBuildHint(line) {
  if (/does not provide an export named|Cannot find module '@hypergate\/(core|shared)/.test(line)) {
    return 'The daemon loaded an older build of @hypergate/core or shared. Look for [core] or [shared] errors above; once they compile the daemon restarts by itself. Press r to rebuild everything.';
  }
  return undefined;
}
