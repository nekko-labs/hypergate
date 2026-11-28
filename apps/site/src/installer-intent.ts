export type DownloadPlatform = 'macos' | 'windows' | 'linux' | 'other';

/** Only our own GitHub release assets count, never a releases listing or a repo link. */
export function installerPlatform(href: string): DownloadPlatform | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (url.origin !== 'https://github.com' || url.username || url.password) return;
  const asset = url.pathname.match(/^\/nekko-labs\/hypergate\/releases\/(?:latest\/download|download\/[^/]+)\/(hypergate[-_][a-z0-9._-]+)$/i)?.[1].toLowerCase();
  if (!asset) return;
  if (asset.endsWith('.dmg')) return 'macos';
  if (asset.endsWith('-setup.exe')) return 'windows';
  if (/\.(?:deb|rpm|tar\.gz)$/.test(asset)) return 'linux';
  if (asset.endsWith('.pkg')) return 'macos';
  if (asset.endsWith('.msi')) return 'windows';
  if (asset.endsWith('.appimage')) return 'linux';
  if (/\.(?:zip|tgz)$/.test(asset)) return 'other';
}
