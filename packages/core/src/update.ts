import type { InstallChannel, UpdatePlan } from '@hypergate/shared';

/**
 * Update logic: is there a newer version, how did this copy get installed, and
 * what would updating it actually take.
 *
 * All pure, so the daemon can answer `/api/update` without a network call and
 * the awkward parts (prereleases, an install we can't place, a channel we must
 * not touch automatically) are decided in one tested place. Fetching the feed
 * and running the command live in the daemon and the shell respectively.
 */

/** The npm package the daemon ships as, and the repo its releases are cut from. */
export const UPDATE_PACKAGE = 'hypergated';
export const UPDATE_REPO = 'nekko-labs/hypergate';
export const NPM_FEED_URL = `https://registry.npmjs.org/${UPDATE_PACKAGE}`;
export const GITHUB_FEED_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Release notes page for a version tag. */
export const releaseUrlFor = (version: string): string => `https://github.com/${UPDATE_REPO}/releases/tag/v${version}`;

interface Parsed {
  nums: number[];
  /** Prerelease identifiers (`1.2.0-rc.1` → `['rc', 1]`), empty for a release. */
  pre: (string | number)[];
}

/** Parse a semver-ish string, tolerating a `v` prefix and missing patch. */
const parse = (v: string): Parsed | undefined => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return undefined;
  const nums = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const pre = (m[4] ?? '')
    .split('.')
    .filter(Boolean)
    .map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { nums, pre };
};

/**
 * Compare two versions: negative if `a` is older, 0 if equal, positive if newer.
 * Unparseable input sorts as older than anything parseable, so garbage in a feed
 * can never be presented as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // A prerelease precedes its release (1.2.0-rc.1 < 1.2.0).
  if (pa.pre.length === 0 || pb.pre.length === 0) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // Numeric identifiers always rank lower than alphanumeric ones (semver §11).
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Is `latest` an update worth offering over `current`? */
export const isNewerVersion = (latest: string | undefined, current: string): boolean =>
  !!latest && compareVersions(latest, current) > 0;

/**
 * Work out how this copy of Hypergate was installed, from the paths it is
 * running out of. Pure on purpose: the daemon passes its own module path and
 * `process.execPath`, and the same rules are then testable per platform.
 *
 * Order matters. A repo checkout can sit anywhere (including under a folder
 * called `hypergate`), and an npm install lives inside `node_modules`, so both
 * are matched before the broader installer locations.
 */
export function detectInstallChannel(opts: { daemonPath: string; execPath?: string; platform?: string }): InstallChannel {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const daemon = norm(opts.daemonPath);
  const exec = norm(opts.execPath ?? '');
  const platform = opts.platform ?? process.platform;

  // A checkout run in place: `apps/daemon/src|dist/index.…`.
  if (/\/apps\/daemon\/(src|dist)\//.test(daemon)) return 'repo';
  // Global (or local) npm install of the published package.
  if (daemon.includes('/node_modules/hypergated/') || exec.includes('/node_modules/hypergated/')) return 'npm';
  if (daemon.includes('/node_modules/')) return 'npm';

  const installerDirs =
    platform === 'win32'
      ? ['/programs/hypergate/', '/appdata/local/hypergate/']
      : platform === 'darwin'
        ? ['/applications/hypergate.app/', '/usr/local/bin/hypergate']
        : ['/usr/lib/hypergate', '/opt/hypergate', '/usr/bin/hypergate'];
  if (installerDirs.some((d) => daemon.includes(d) || exec.includes(d))) return 'installer';

  return 'unknown';
}

/**
 * What updating would take on this channel.
 *
 * One-click is deliberately limited to the npm channel. The native installers
 * are not code-signed yet on Windows or macOS (see docs/signing.md), and
 * silently downloading and running an unsigned installer is worse than telling
 * the user where the release is; the Linux packages need root, which a per-user
 * agent does not have. So those channels get the exact command or the release
 * page instead of a button that half-works.
 */
export function updatePlan(channel: InstallChannel, latest?: string, platform: string = process.platform): UpdatePlan {
  const version = latest ? `@${latest}` : '@latest';
  switch (channel) {
    case 'npm':
      return { canApply: true, command: `npm install -g ${UPDATE_PACKAGE}${version}` };
    case 'installer':
      return {
        canApply: false,
        command:
          platform === 'linux'
            ? `sudo apt install ./hypergate_${latest ?? 'VERSION'}_amd64.deb  # or dnf install ./hypergate-…rpm`
            : undefined,
        note:
          platform === 'linux'
            ? 'Installed from a system package, which needs root to replace. Download the release and install it with your package manager.'
            : 'Installed from the native installer. Download the new one from the release page and run it: it stops the running app, replaces it, and starts it again.',
      };
    case 'repo':
      return {
        canApply: false,
        command: 'git pull && npm install && npm run build',
        note: 'Running from a checkout, so updating is a pull and a rebuild rather than a package install.',
      };
    default:
      return {
        canApply: false,
        note: "Couldn't tell how this copy was installed, so it won't try to replace it. Update it the way you installed it.",
      };
  }
}

/** Pull `dist-tags.latest` out of an npm registry document. */
export function latestFromNpm(doc: unknown): string | undefined {
  const tags = (doc as { 'dist-tags'?: Record<string, string> } | null)?.['dist-tags'];
  const latest = tags?.latest;
  return typeof latest === 'string' && parse(latest) ? latest : undefined;
}

/** Pull the version out of a GitHub "latest release" document (`tag_name`). */
export function latestFromGithub(doc: unknown): string | undefined {
  const d = doc as { tag_name?: string; draft?: boolean; prerelease?: boolean } | null;
  if (!d || d.draft) return undefined;
  const tag = d.tag_name;
  if (typeof tag !== 'string' || !parse(tag)) return undefined;
  return tag.replace(/^v/, '');
}
